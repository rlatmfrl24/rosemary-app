import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { app, nativeImage } from "electron";
import type { FileThumbnail } from "../shared/file-organizer";

interface ZipImageEntry {
	fileName: string;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	method: number;
}

const inflateRawAsync = promisify(inflateRaw);

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_EOCD_MAX_COMMENT_SIZE = 0xffff;
const ZIP_MAX_EOCD_SEARCH_SIZE = ZIP_EOCD_MIN_SIZE + ZIP_EOCD_MAX_COMMENT_SIZE;
const MAX_CENTRAL_DIRECTORY_SIZE = 64 * 1024 * 1024;
const MAX_COMPRESSED_IMAGE_SIZE = 25 * 1024 * 1024;
const MAX_UNCOMPRESSED_IMAGE_SIZE = 80 * 1024 * 1024;
const THUMBNAIL_WIDTH = 240;
const THUMBNAIL_MAX_HEIGHT = 360;
const THUMBNAIL_JPEG_QUALITY = 78;
const MAX_THUMBNAIL_CACHE_SIZE = 500;
const ZIP_IMAGE_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".webp",
	".gif",
]);
const ZIP_EXTENSION = ".zip";

interface CachedThumbnail {
	size: number;
	mtimeMs: number;
	thumbnail: FileThumbnail | null;
}

const thumbnailCache = new Map<string, CachedThumbnail>();

const isSupportedZipImage = (fileName: string): boolean => {
	const normalizedName = fileName.replace(/\\/g, "/");

	if (
		normalizedName.endsWith("/") ||
		normalizedName.startsWith("__MACOSX/") ||
		path.basename(normalizedName).startsWith(".")
	) {
		return false;
	}

	return ZIP_IMAGE_EXTENSIONS.has(path.extname(normalizedName).toLowerCase());
};

const findEndOfCentralDirectory = (buffer: Buffer): number => {
	for (let index = buffer.length - ZIP_EOCD_MIN_SIZE; index >= 0; index -= 1) {
		if (buffer.readUInt32LE(index) === ZIP_EOCD_SIGNATURE) {
			return index;
		}
	}

	return -1;
};

const readBuffer = async (
	handle: fs.promises.FileHandle,
	length: number,
	position: number,
): Promise<Buffer | null> => {
	const buffer = Buffer.alloc(length);
	let bytesRead = 0;

	while (bytesRead < length) {
		const result = await handle.read(
			buffer,
			bytesRead,
			length - bytesRead,
			position + bytesRead,
		);

		if (result.bytesRead === 0) {
			return null;
		}

		bytesRead += result.bytesRead;
	}

	return buffer;
};

const readFirstZipImageEntry = async (
	handle: fs.promises.FileHandle,
	fileSize: number,
): Promise<ZipImageEntry | null> => {
	const searchSize = Math.min(fileSize, ZIP_MAX_EOCD_SEARCH_SIZE);
	const tailBuffer = await readBuffer(
		handle,
		searchSize,
		fileSize - searchSize,
	);
	if (!tailBuffer) {
		return null;
	}

	const eocdOffset = findEndOfCentralDirectory(tailBuffer);
	if (eocdOffset === -1) {
		return null;
	}

	const centralDirectorySize = tailBuffer.readUInt32LE(eocdOffset + 12);
	const centralDirectoryOffset = tailBuffer.readUInt32LE(eocdOffset + 16);

	if (
		centralDirectorySize === 0xffffffff ||
		centralDirectoryOffset === 0xffffffff ||
		centralDirectorySize <= 0 ||
		centralDirectorySize > MAX_CENTRAL_DIRECTORY_SIZE ||
		centralDirectoryOffset < 0 ||
		centralDirectoryOffset + centralDirectorySize > fileSize
	) {
		return null;
	}

	const centralDirectory = await readBuffer(
		handle,
		centralDirectorySize,
		centralDirectoryOffset,
	);
	if (!centralDirectory) {
		return null;
	}

	let offset = 0;

	while (offset + 46 <= centralDirectory.length) {
		if (
			centralDirectory.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
		) {
			break;
		}

		const flags = centralDirectory.readUInt16LE(offset + 8);
		const method = centralDirectory.readUInt16LE(offset + 10);
		const compressedSize = centralDirectory.readUInt32LE(offset + 20);
		const uncompressedSize = centralDirectory.readUInt32LE(offset + 24);
		const fileNameLength = centralDirectory.readUInt16LE(offset + 28);
		const extraLength = centralDirectory.readUInt16LE(offset + 30);
		const commentLength = centralDirectory.readUInt16LE(offset + 32);
		const localHeaderOffset = centralDirectory.readUInt32LE(offset + 42);
		const fileNameStart = offset + 46;
		const fileNameEnd = fileNameStart + fileNameLength;

		if (fileNameEnd > centralDirectory.length) {
			break;
		}

		const fileName = centralDirectory
			.subarray(fileNameStart, fileNameEnd)
			.toString("utf8");
		const isEncrypted = (flags & 1) === 1;

		if (
			!isEncrypted &&
			(method === 0 || method === 8) &&
			compressedSize > 0 &&
			compressedSize <= MAX_COMPRESSED_IMAGE_SIZE &&
			uncompressedSize > 0 &&
			uncompressedSize <= MAX_UNCOMPRESSED_IMAGE_SIZE &&
			isSupportedZipImage(fileName)
		) {
			return {
				fileName: fileName.replace(/\\/g, "/"),
				compressedSize,
				uncompressedSize,
				localHeaderOffset,
				method,
			};
		}

		offset = fileNameEnd + extraLength + commentLength;
	}

	return null;
};

const readZipImageBuffer = async (
	handle: fs.promises.FileHandle,
	entry: ZipImageEntry,
): Promise<Buffer | null> => {
	const localHeader = await readBuffer(handle, 30, entry.localHeaderOffset);
	if (!localHeader) {
		return null;
	}

	if (localHeader.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE) {
		return null;
	}

	const fileNameLength = localHeader.readUInt16LE(26);
	const extraLength = localHeader.readUInt16LE(28);
	const dataOffset =
		entry.localHeaderOffset + 30 + fileNameLength + extraLength;
	const compressedBuffer = await readBuffer(
		handle,
		entry.compressedSize,
		dataOffset,
	);

	if (!compressedBuffer) {
		return null;
	}

	if (entry.method === 0) {
		return compressedBuffer;
	}

	return await inflateRawAsync(compressedBuffer);
};

const nativeImageToDataUrl = (
	image: Electron.NativeImage,
	source: FileThumbnail["source"],
): FileThumbnail | null => {
	if (image.isEmpty()) {
		return null;
	}

	const size = image.getSize();
	const scale = Math.min(
		THUMBNAIL_WIDTH / size.width,
		THUMBNAIL_MAX_HEIGHT / size.height,
		1,
	);
	const resizedImage =
		scale < 1
			? image.resize({
					width: Math.max(1, Math.round(size.width * scale)),
					quality: "good",
				})
			: image;

	return {
		dataUrl:
			source === "archive-image"
				? `data:image/jpeg;base64,${resizedImage.toJPEG(THUMBNAIL_JPEG_QUALITY).toString("base64")}`
				: resizedImage.toDataURL(),
		source,
	};
};

const createZipImageThumbnail = async (
	filePath: string,
): Promise<FileThumbnail | null> => {
	if (path.extname(filePath).toLowerCase() !== ZIP_EXTENSION) {
		return null;
	}

	let handle: fs.promises.FileHandle | null = null;

	try {
		handle = await fs.promises.open(filePath, "r");
		const stats = await handle.stat();
		const firstEntry = await readFirstZipImageEntry(handle, stats.size);

		if (!firstEntry) {
			return null;
		}

		const imageBuffer = await readZipImageBuffer(handle, firstEntry);
		if (!imageBuffer) {
			return null;
		}

		return nativeImageToDataUrl(
			nativeImage.createFromBuffer(imageBuffer),
			"archive-image",
		);
	} catch (error) {
		console.warn(`압축 파일 썸네일 생성 실패: ${filePath}`, error);
		return null;
	} finally {
		await handle?.close();
	}
};

const createShellThumbnail = async (
	filePath: string,
): Promise<FileThumbnail | null> => {
	if (process.platform !== "darwin" && process.platform !== "win32") {
		return null;
	}

	try {
		const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
			width: THUMBNAIL_WIDTH,
			height: THUMBNAIL_WIDTH,
		});

		return nativeImageToDataUrl(thumbnail, "file-thumbnail");
	} catch (error) {
		console.warn(`파일 썸네일 생성 실패: ${filePath}`, error);
		return null;
	}
};

const createFileIconThumbnail = async (
	filePath: string,
): Promise<FileThumbnail | null> => {
	try {
		const icon = await app.getFileIcon(filePath, { size: "large" });
		return nativeImageToDataUrl(icon, "file-icon");
	} catch (error) {
		console.warn(`파일 아이콘 생성 실패: ${filePath}`, error);
		return null;
	}
};

export const createFileThumbnail = async (
	filePath: string,
): Promise<FileThumbnail | null> => {
	try {
		const stats = await fs.promises.stat(filePath);
		const cached = thumbnailCache.get(filePath);

		if (
			cached &&
			cached.size === stats.size &&
			cached.mtimeMs === stats.mtimeMs
		) {
			return cached.thumbnail;
		}

		const thumbnail =
			(await createZipImageThumbnail(filePath)) ??
			(await createShellThumbnail(filePath)) ??
			(await createFileIconThumbnail(filePath));

		thumbnailCache.set(filePath, {
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			thumbnail,
		});

		if (thumbnailCache.size > MAX_THUMBNAIL_CACHE_SIZE) {
			const oldestKey = thumbnailCache.keys().next().value;
			if (oldestKey) {
				thumbnailCache.delete(oldestKey);
			}
		}

		return thumbnail;
	} catch (error) {
		console.warn(`썸네일 캐시 확인 실패: ${filePath}`, error);
		return null;
	}
};
