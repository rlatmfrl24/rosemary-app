import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";
import { app } from "electron";
import type {
	ArchiveContentScanMode,
	ArchiveContentSummary,
} from "../shared/file-organizer";
import { pathExists } from "./process-utils";

interface ZipImageEntry {
	fileName: string;
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	method: number;
	crc32: string;
	isEncrypted: boolean;
}

interface ArchiveContentCacheRecord {
	path: string;
	size: number;
	mtimeMs: number;
	summary: ArchiveContentSummary;
	updatedAt: number;
}

interface ArchiveContentCacheFile {
	version: 1;
	records: Record<string, ArchiveContentCacheRecord>;
}

const inflateRawAsync = promisify(inflateRaw);

const ZIP_EXTENSION = ".zip";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_EOCD_MIN_SIZE = 22;
const ZIP_EOCD_MAX_COMMENT_SIZE = 0xffff;
const ZIP_MAX_EOCD_SEARCH_SIZE = ZIP_EOCD_MIN_SIZE + ZIP_EOCD_MAX_COMMENT_SIZE;
const MAX_CENTRAL_DIRECTORY_SIZE = 64 * 1024 * 1024;
const MAX_SAMPLE_COMPRESSED_IMAGE_SIZE = 40 * 1024 * 1024;
const MAX_SAMPLE_UNCOMPRESSED_IMAGE_SIZE = 120 * 1024 * 1024;
const MAX_ARCHIVE_CONTENT_CACHE_ENTRIES = 60000;
const ZIP_IMAGE_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".webp",
	".gif",
]);

let contentCache: ArchiveContentCacheFile | null = null;
let contentCacheDirty = false;

const getArchiveContentCachePath = (): string =>
	path.join(app.getPath("userData"), "archive-content-cache-v1.json");

const getCacheKey = (filePath: string): string =>
	path.resolve(filePath).toLowerCase();

const createEmptyCache = (): ArchiveContentCacheFile => ({
	version: 1,
	records: {},
});

const loadArchiveContentCache = async (): Promise<ArchiveContentCacheFile> => {
	if (contentCache) {
		return contentCache;
	}

	try {
		const cachePath = getArchiveContentCachePath();
		if (!(await pathExists(cachePath))) {
			contentCache = createEmptyCache();
			return contentCache;
		}

		const data = await fs.promises.readFile(cachePath, "utf8");
		const parsedCache = JSON.parse(data) as Partial<ArchiveContentCacheFile>;
		contentCache = {
			version: 1,
			records: parsedCache.records ?? {},
		};
		return contentCache;
	} catch (error) {
		console.warn("압축 내용 캐시를 불러오지 못했습니다:", error);
		contentCache = createEmptyCache();
		return contentCache;
	}
};

const pruneArchiveContentCache = (cache: ArchiveContentCacheFile): void => {
	const records = Object.entries(cache.records);
	if (records.length <= MAX_ARCHIVE_CONTENT_CACHE_ENTRIES) {
		return;
	}

	const removeCount = records.length - MAX_ARCHIVE_CONTENT_CACHE_ENTRIES;
	for (const [key] of records
		.sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
		.slice(0, removeCount)) {
		delete cache.records[key];
	}
};

export const flushArchiveContentCache = async (): Promise<void> => {
	if (!contentCache || !contentCacheDirty) {
		return;
	}

	pruneArchiveContentCache(contentCache);
	const cachePath = getArchiveContentCachePath();
	await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
	await fs.promises.writeFile(cachePath, JSON.stringify(contentCache, null, 2));
	contentCacheDirty = false;
};

const hashText = (value: string): string =>
	crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);

const hashBuffer = (buffer: Buffer): string =>
	crypto.createHash("sha256").update(buffer).digest("hex");

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

const getCrcText = (crcValue: number): string =>
	crcValue.toString(16).padStart(8, "0");

const readZipImageEntries = async (
	handle: fs.promises.FileHandle,
	fileSize: number,
): Promise<{
	entryCount: number;
	imageEntries: ZipImageEntry[];
	unsupportedReason?: string;
}> => {
	const searchSize = Math.min(fileSize, ZIP_MAX_EOCD_SEARCH_SIZE);
	const tailBuffer = await readBuffer(
		handle,
		searchSize,
		fileSize - searchSize,
	);
	if (!tailBuffer) {
		return {
			entryCount: 0,
			imageEntries: [],
			unsupportedReason: "ZIP 끝 정보를 읽지 못했습니다.",
		};
	}

	const eocdOffset = findEndOfCentralDirectory(tailBuffer);
	if (eocdOffset === -1) {
		return {
			entryCount: 0,
			imageEntries: [],
			unsupportedReason: "ZIP 중앙 디렉터리를 찾지 못했습니다.",
		};
	}

	const centralDirectorySize = tailBuffer.readUInt32LE(eocdOffset + 12);
	const centralDirectoryOffset = tailBuffer.readUInt32LE(eocdOffset + 16);

	if (
		centralDirectorySize === 0xffffffff ||
		centralDirectoryOffset === 0xffffffff
	) {
		return {
			entryCount: 0,
			imageEntries: [],
			unsupportedReason: "ZIP64 파일은 내용 스캔 v1에서 제외됩니다.",
		};
	}

	if (
		centralDirectorySize <= 0 ||
		centralDirectorySize > MAX_CENTRAL_DIRECTORY_SIZE ||
		centralDirectoryOffset < 0 ||
		centralDirectoryOffset + centralDirectorySize > fileSize
	) {
		return {
			entryCount: 0,
			imageEntries: [],
			unsupportedReason: "ZIP 중앙 디렉터리 크기가 올바르지 않습니다.",
		};
	}

	const centralDirectory = await readBuffer(
		handle,
		centralDirectorySize,
		centralDirectoryOffset,
	);
	if (!centralDirectory) {
		return {
			entryCount: 0,
			imageEntries: [],
			unsupportedReason: "ZIP 중앙 디렉터리를 읽지 못했습니다.",
		};
	}

	let offset = 0;
	let entryCount = 0;
	const imageEntries: ZipImageEntry[] = [];

	while (offset + 46 <= centralDirectory.length) {
		if (
			centralDirectory.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
		) {
			break;
		}

		const flags = centralDirectory.readUInt16LE(offset + 8);
		const method = centralDirectory.readUInt16LE(offset + 10);
		const crc32 = getCrcText(centralDirectory.readUInt32LE(offset + 16));
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
			.toString((flags & 0x800) === 0x800 ? "utf8" : "utf8")
			.replace(/\\/g, "/");

		if (!fileName.endsWith("/")) {
			entryCount += 1;
		}

		if (isSupportedZipImage(fileName)) {
			imageEntries.push({
				fileName,
				compressedSize,
				uncompressedSize,
				localHeaderOffset,
				method,
				crc32,
				isEncrypted: (flags & 1) === 1,
			});
		}

		offset = fileNameEnd + extraLength + commentLength;
	}

	return { entryCount, imageEntries };
};

const readZipEntryBuffer = async (
	handle: fs.promises.FileHandle,
	entry: ZipImageEntry,
): Promise<Buffer | null> => {
	if (
		entry.isEncrypted ||
		(entry.method !== 0 && entry.method !== 8) ||
		entry.compressedSize <= 0 ||
		entry.compressedSize > MAX_SAMPLE_COMPRESSED_IMAGE_SIZE ||
		entry.uncompressedSize <= 0 ||
		entry.uncompressedSize > MAX_SAMPLE_UNCOMPRESSED_IMAGE_SIZE
	) {
		return null;
	}

	const localHeader = await readBuffer(handle, 30, entry.localHeaderOffset);
	if (
		!localHeader ||
		localHeader.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE
	) {
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

	const maxOutputLength = Math.min(
		entry.uncompressedSize,
		MAX_SAMPLE_UNCOMPRESSED_IMAGE_SIZE,
	);

	if (entry.method === 0) {
		return compressedBuffer.length === entry.uncompressedSize
			? compressedBuffer
			: null;
	}

	const inflatedBuffer = await inflateRawAsync(compressedBuffer, {
		maxOutputLength,
	});
	return inflatedBuffer.length === entry.uncompressedSize
		? inflatedBuffer
		: null;
};

const getSampleEntries = (entries: ZipImageEntry[]): ZipImageEntry[] => {
	if (entries.length === 0) {
		return [];
	}

	const indexes = Array.from(
		new Set([0, Math.floor((entries.length - 1) / 2), entries.length - 1]),
	);
	return indexes.map((index) => entries[index]).filter(Boolean);
};

const createWindowSignature = (
	entries: ZipImageEntry[],
): string | undefined => {
	if (entries.length === 0) {
		return undefined;
	}

	const indexes = Array.from(
		new Set([
			...Array.from(
				{ length: Math.min(3, entries.length) },
				(_, index) => index,
			),
			Math.floor((entries.length - 1) / 2),
			...Array.from(
				{ length: Math.min(3, entries.length) },
				(_, index) => entries.length - 1 - index,
			),
		]),
	).sort((left, right) => left - right);

	return hashText(
		indexes
			.map((index) => {
				const entry = entries[index];
				return entry ? `${entry.crc32}:${entry.uncompressedSize}` : "";
			})
			.join("|"),
	);
};

const createArchiveContentSummary = async (
	filePath: string,
	mode: Exclude<ArchiveContentScanMode, "off">,
): Promise<ArchiveContentSummary> => {
	if (path.extname(filePath).toLowerCase() !== ZIP_EXTENSION) {
		return {
			status: "unsupported",
			entryCount: 0,
			imageCount: 0,
			totalCompressedSize: 0,
			totalUncompressedSize: 0,
			scanError: "ZIP 파일만 내용 스캔을 지원합니다.",
		};
	}

	let handle: fs.promises.FileHandle | null = null;

	try {
		handle = await fs.promises.open(filePath, "r");
		const stats = await handle.stat();
		const { entryCount, imageEntries, unsupportedReason } =
			await readZipImageEntries(handle, stats.size);
		const sortedImageEntries = [...imageEntries].sort((left, right) =>
			left.fileName.localeCompare(right.fileName, undefined, { numeric: true }),
		);
		const totalCompressedSize = sortedImageEntries.reduce(
			(sum, entry) => sum + entry.compressedSize,
			0,
		);
		const totalUncompressedSize = sortedImageEntries.reduce(
			(sum, entry) => sum + entry.uncompressedSize,
			0,
		);
		const orderedCrcValues = sortedImageEntries.map(
			(entry) => `${entry.crc32}:${entry.uncompressedSize}`,
		);
		const orderedCrcSignature =
			orderedCrcValues.length > 0
				? hashText(orderedCrcValues.join("|"))
				: undefined;
		const crcSetSignature =
			orderedCrcValues.length > 0
				? hashText([...orderedCrcValues].sort().join("|"))
				: undefined;
		const crcWindowSignature = createWindowSignature(sortedImageEntries);
		const sampleHashes: string[] = [];
		const sampleEntries = getSampleEntries(sortedImageEntries);

		if (mode === "sample") {
			for (const entry of sampleEntries) {
				const imageBuffer = await readZipEntryBuffer(handle, entry);
				if (imageBuffer) {
					sampleHashes.push(hashBuffer(imageBuffer));
				}
			}
		}

		const sampleHashSignature =
			sampleHashes.length > 0 ? hashText(sampleHashes.join("|")) : undefined;
		const contentFingerprint =
			orderedCrcSignature && sortedImageEntries.length > 0
				? hashText(
						[
							sortedImageEntries.length,
							totalUncompressedSize,
							orderedCrcSignature,
						].join("|"),
					)
				: undefined;
		const hasMetadataFailure =
			Boolean(unsupportedReason) &&
			entryCount === 0 &&
			sortedImageEntries.length === 0;

		return {
			status: hasMetadataFailure
				? "failed"
				: mode === "sample" &&
						sampleEntries.length > 0 &&
						sampleHashes.length === sampleEntries.length
					? "scanned"
					: "metadata-only",
			entryCount,
			imageCount: sortedImageEntries.length,
			totalCompressedSize,
			totalUncompressedSize,
			contentFingerprint,
			orderedCrcSignature,
			crcSetSignature,
			crcWindowSignature,
			sampleHashSignature,
			sampleHashes: sampleHashes.length > 0 ? sampleHashes : undefined,
			scanError: unsupportedReason,
		};
	} catch (error) {
		return {
			status: "failed",
			entryCount: 0,
			imageCount: 0,
			totalCompressedSize: 0,
			totalUncompressedSize: 0,
			scanError: error instanceof Error ? error.message : "알 수 없는 오류",
		};
	} finally {
		await handle?.close();
	}
};

const canUseCachedSummary = (
	record: ArchiveContentCacheRecord | undefined,
	stats: fs.Stats,
	mode: Exclude<ArchiveContentScanMode, "off">,
): record is ArchiveContentCacheRecord => {
	if (
		!record ||
		record.size !== stats.size ||
		record.mtimeMs !== stats.mtimeMs
	) {
		return false;
	}

	return (
		mode === "metadata" ||
		mode === "smart" ||
		Boolean(record.summary.sampleHashSignature) ||
		record.summary.imageCount === 0 ||
		record.summary.status === "failed"
	);
};

export const getArchiveContentSummary = async (
	filePath: string,
	stats: fs.Stats,
	mode: ArchiveContentScanMode,
	forceRefresh = false,
): Promise<ArchiveContentSummary | undefined> => {
	if (mode === "off") {
		return undefined;
	}

	const resolvedPath = path.resolve(filePath);
	const cache = await loadArchiveContentCache();
	const cacheKey = getCacheKey(resolvedPath);
	const cachedRecord = cache.records[cacheKey];

	if (!forceRefresh && canUseCachedSummary(cachedRecord, stats, mode)) {
		cachedRecord.updatedAt = Date.now();
		contentCacheDirty = true;
		return cachedRecord.summary;
	}

	const summary = await createArchiveContentSummary(resolvedPath, mode);
	cache.records[cacheKey] = {
		path: resolvedPath,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		summary,
		updatedAt: Date.now(),
	};
	contentCacheDirty = true;
	return summary;
};
