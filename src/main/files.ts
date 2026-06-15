import * as fs from "node:fs";
import * as path from "node:path";
import { shell } from "electron";
import {
	normalizeArchiveText,
	parseArchiveFileName,
} from "../shared/archive-name";
import type {
	FileThumbnail,
	GroupMergeCandidate,
	GroupMergeSourceFile,
	GroupOperationResult,
	RandomReviewOptions,
	RandomReviewResult,
	ScanArchiveProgress,
	SimilarGroup,
	SimilarGroupFile,
	SimilarGroupOptions,
	SimilarGroupResult,
} from "../shared/file-organizer";
import { ensurePathExists, pathExists } from "./process-utils";

export interface FileEntry {
	path: string;
	name: string;
	size: number;
	thumbnail?: FileThumbnail;
	modifiedTimeMs?: number;
	isGrouped?: boolean;
	groupName?: string;
}

interface ArchiveCandidate {
	path: string;
	name: string;
}

type ScanProgressCallback = (progress: ScanArchiveProgress) => void;

interface RandomReviewIndexedFile extends FileEntry {
	relativePath: string;
	searchText: string;
}

interface RandomReviewIndexCacheEntry {
	sourcePath: string;
	recursive: boolean;
	indexedAt: number;
	files: RandomReviewIndexedFile[];
}

interface SimilarGroupIndexedFile extends SimilarGroupFile {
	searchText: string;
	normalizedType: string;
	normalizedOrigin: string;
	normalizedArtist: string;
	normalizedBaseTitle: string;
	normalizedCategory: string;
}

interface SimilarGroupIndexCacheEntry {
	sourcePath: string;
	recursive: boolean;
	indexedAt: number;
	files: SimilarGroupIndexedFile[];
}

interface GroupFolderSummary {
	groupName: string;
	groupPath: string;
	files: SimilarGroupIndexedFile[];
	codes: Set<string>;
	artists: Set<string>;
	baseTitles: Set<string>;
	sampleFiles: string[];
}

export interface DuplicateFileInfo {
	sourceFile: string;
	sourcePath: string;
	sourceSize: number;
	targetPath: string;
	targetSize: number;
	relativePath: string;
}

interface FileMutationResult {
	success: boolean;
	message: string;
	targetPath?: string;
}

interface MoveAllFileResult {
	file: string;
	success: boolean;
	error?: string;
	action?: string;
	targetPath?: string;
}

type DuplicateAction = "overwrite" | "skip";

const MAX_RANDOM_REVIEW_CACHE_ENTRIES = 8;
const randomReviewIndexCache = new Map<string, RandomReviewIndexCacheEntry>();
const MAX_SIMILAR_GROUP_CACHE_ENTRIES = 4;
const similarGroupIndexCache = new Map<string, SimilarGroupIndexCacheEntry>();
const APP_MANAGED_DIRECTORIES = new Set(["_grouped", "_trash"]);

const ARCHIVE_EXTENSIONS = new Set([
	".zip",
	".rar",
	".7z",
	".tar",
	".gz",
	".bz2",
	".xz",
	".cab",
	".iso",
	".dmg",
	".pkg",
	".deb",
	".rpm",
]);

const COMPOUND_ARCHIVE_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz"];

const EXCLUDED_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".bmp",
	".tiff",
	".tif",
	".webp",
	".svg",
	".ico",
	".raw",
	".cr2",
	".nef",
	".arw",
	".dng",
	".psd",
	".ai",
	".eps",
	".mp4",
	".avi",
	".mkv",
	".mov",
	".wmv",
	".flv",
	".webm",
	".m4v",
	".3gp",
	".mpg",
	".mpeg",
	".ts",
	".vob",
	".asf",
	".rm",
	".rmvb",
	".m2ts",
	".mts",
	".mp3",
	".wav",
	".flac",
	".aac",
	".ogg",
	".wma",
	".m4a",
	".txt",
	".doc",
	".docx",
	".pdf",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".rtf",
	".odt",
	".ods",
	".odp",
]);

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException => {
	return error instanceof Error && "code" in error;
};

const isArchiveFile = (fileName: string): boolean => {
	const lowerFileName = fileName.toLowerCase();
	const extension = path.extname(lowerFileName);

	if (EXCLUDED_EXTENSIONS.has(extension)) {
		return false;
	}

	if (ARCHIVE_EXTENSIONS.has(extension)) {
		return true;
	}

	return COMPOUND_ARCHIVE_EXTENSIONS.some((suffix) =>
		lowerFileName.endsWith(suffix),
	);
};

const isZipFile = (fileName: string): boolean =>
	path.extname(fileName.toLowerCase()) === ".zip";

const getGroupedArchiveMetadata = (
	filePath: string,
): {
	isGrouped?: boolean;
	groupName?: string;
} => {
	const pathParts = path
		.resolve(filePath)
		.split(/[\\/]+/)
		.filter(Boolean);

	for (let index = pathParts.length - 1; index >= 0; index -= 1) {
		if (pathParts[index]?.toLowerCase() !== "_grouped") {
			continue;
		}

		return {
			isGrouped: true,
			groupName: pathParts[index + 1],
		};
	}

	return {};
};

const normalizeKeyword = (keyword: string | undefined): string =>
	keyword?.trim().toLowerCase() ?? "";

const getRandomReviewCacheKey = (
	sourcePath: string,
	recursive: boolean,
): string =>
	`${path.resolve(sourcePath).toLowerCase()}::${recursive ? "recursive" : "flat"}`;

const setRandomReviewCacheEntry = (
	cacheKey: string,
	cacheEntry: RandomReviewIndexCacheEntry,
): void => {
	randomReviewIndexCache.delete(cacheKey);
	randomReviewIndexCache.set(cacheKey, cacheEntry);

	if (randomReviewIndexCache.size > MAX_RANDOM_REVIEW_CACHE_ENTRIES) {
		const oldestKey = randomReviewIndexCache.keys().next().value;
		if (oldestKey) {
			randomReviewIndexCache.delete(oldestKey);
		}
	}
};

const setSimilarGroupCacheEntry = (
	cacheKey: string,
	cacheEntry: SimilarGroupIndexCacheEntry,
): void => {
	similarGroupIndexCache.delete(cacheKey);
	similarGroupIndexCache.set(cacheKey, cacheEntry);

	if (similarGroupIndexCache.size > MAX_SIMILAR_GROUP_CACHE_ENTRIES) {
		const oldestKey = similarGroupIndexCache.keys().next().value;
		if (oldestKey) {
			similarGroupIndexCache.delete(oldestKey);
		}
	}
};

const getComparablePath = (filePath: string): string =>
	path.resolve(filePath).toLowerCase();

const isSamePath = (leftPath: string, rightPath: string): boolean =>
	getComparablePath(leftPath) === getComparablePath(rightPath);

const isPathSameOrInside = (basePath: string, targetPath: string): boolean => {
	const relativePath = path.relative(
		getComparablePath(basePath),
		getComparablePath(targetPath),
	);

	return (
		relativePath === "" ||
		(!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
	);
};

const removeFileFromRandomReviewCache = (filePath: string): void => {
	for (const [cacheKey, cacheEntry] of randomReviewIndexCache.entries()) {
		const nextFiles = cacheEntry.files.filter(
			(file) => !isSamePath(file.path, filePath),
		);

		if (nextFiles.length !== cacheEntry.files.length) {
			randomReviewIndexCache.set(cacheKey, {
				...cacheEntry,
				files: nextFiles,
			});
		}
	}
};

const removeFileFromSimilarGroupCache = (filePath: string): void => {
	for (const [cacheKey, cacheEntry] of similarGroupIndexCache.entries()) {
		const nextFiles = cacheEntry.files.filter(
			(file) => !isSamePath(file.path, filePath),
		);

		if (nextFiles.length !== cacheEntry.files.length) {
			similarGroupIndexCache.set(cacheKey, {
				...cacheEntry,
				files: nextFiles,
			});
		}
	}
};

const removeFileFromOrganizerCaches = (filePath: string): void => {
	removeFileFromRandomReviewCache(filePath);
	removeFileFromSimilarGroupCache(filePath);
};

const invalidateOrganizerCachesContainingPath = (filePath: string): void => {
	for (const [cacheKey, cacheEntry] of randomReviewIndexCache.entries()) {
		if (isPathSameOrInside(cacheEntry.sourcePath, filePath)) {
			randomReviewIndexCache.delete(cacheKey);
		}
	}

	for (const [cacheKey, cacheEntry] of similarGroupIndexCache.entries()) {
		if (isPathSameOrInside(cacheEntry.sourcePath, filePath)) {
			similarGroupIndexCache.delete(cacheKey);
		}
	}
};

const invalidateOrganizerCachesForMove = (
	sourcePath: string,
	targetPath: string,
): void => {
	invalidateOrganizerCachesContainingPath(sourcePath);
	invalidateOrganizerCachesContainingPath(targetPath);
};

const ensureTargetDirectory = async (targetPath: string): Promise<void> => {
	await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
};

const moveFileWithFallback = async (
	sourcePath: string,
	targetPath: string,
): Promise<void> => {
	try {
		await fs.promises.rename(sourcePath, targetPath);
		invalidateOrganizerCachesForMove(sourcePath, targetPath);
	} catch (error) {
		if (isErrnoException(error) && error.code === "EXDEV") {
			await fs.promises.copyFile(sourcePath, targetPath);
			await fs.promises.unlink(sourcePath);
			invalidateOrganizerCachesForMove(sourcePath, targetPath);
			return;
		}

		throw error;
	}
};

const createNumberedPath = async (targetPath: string): Promise<string> => {
	const fileExtension = path.extname(targetPath);
	const baseName = path.basename(targetPath, fileExtension);
	const targetDirectory = path.dirname(targetPath);
	let counter = 1;
	let nextPath = targetPath;

	while (await pathExists(nextPath)) {
		nextPath = path.join(
			targetDirectory,
			`${baseName}_${counter}${fileExtension}`,
		);
		counter += 1;
	}

	return nextPath;
};

export const scanArchiveFiles = async (
	targetPath: string,
	onProgress?: ScanProgressCallback,
): Promise<FileEntry[]> => {
	if (!targetPath) {
		throw new Error("경로가 지정되지 않았습니다.");
	}

	const candidates: ArchiveCandidate[] = [];
	const directories = [targetPath];
	let processedDirectories = 0;
	let totalDirectories = 1;

	onProgress?.({
		phase: "searching",
		processed: processedDirectories,
		total: totalDirectories,
		foundFiles: candidates.length,
		currentPath: targetPath,
	});

	while (directories.length > 0) {
		const currentPath = directories.pop();
		if (!currentPath) {
			continue;
		}

		let items: fs.Dirent[];
		try {
			items = await fs.promises.readdir(currentPath, { withFileTypes: true });
		} catch (error) {
			console.warn(`디렉토리 읽기 실패: ${currentPath}`, error);
			continue;
		}

		for (const item of items) {
			const fullPath = path.join(currentPath, item.name);
			onProgress?.({
				phase: "searching",
				processed: processedDirectories,
				total: totalDirectories,
				foundFiles: candidates.length,
				currentPath,
				currentFileName: item.name,
			});

			if (item.isDirectory()) {
				directories.push(fullPath);
				totalDirectories += 1;
				continue;
			}

			if (!item.isFile() || !isArchiveFile(item.name)) {
				continue;
			}

			candidates.push({
				path: fullPath,
				name: item.name,
			});
		}

		processedDirectories += 1;
		onProgress?.({
			phase: "searching",
			processed: processedDirectories,
			total: totalDirectories,
			foundFiles: candidates.length,
			currentPath,
		});
	}

	const results: FileEntry[] = [];

	onProgress?.({
		phase: "reading",
		processed: 0,
		total: candidates.length,
		foundFiles: candidates.length,
	});

	for (const [index, candidate] of candidates.entries()) {
		onProgress?.({
			phase: "reading",
			processed: index,
			total: candidates.length,
			foundFiles: candidates.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});

		try {
			const stats = await fs.promises.stat(candidate.path);
			results.push({
				path: candidate.path,
				name: candidate.name,
				size: stats.size,
			});
		} catch (error) {
			console.warn(`파일 정보 읽기 실패: ${candidate.path}`, error);
		}

		onProgress?.({
			phase: "reading",
			processed: index + 1,
			total: candidates.length,
			foundFiles: candidates.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});
	}

	onProgress?.({
		phase: "complete",
		processed: results.length,
		total: candidates.length,
		foundFiles: results.length,
	});

	return results;
};

const shouldIncludeRandomReviewFile = (
	file: RandomReviewIndexedFile,
	options: RandomReviewOptions,
): boolean => {
	const includeKeyword = normalizeKeyword(options.includeKeyword);
	const excludeKeyword = normalizeKeyword(options.excludeKeyword);

	if (includeKeyword && !file.searchText.includes(includeKeyword)) {
		return false;
	}

	if (excludeKeyword && file.searchText.includes(excludeKeyword)) {
		return false;
	}

	if (
		typeof options.modifiedBeforeMs === "number" &&
		typeof file.modifiedTimeMs === "number" &&
		file.modifiedTimeMs > options.modifiedBeforeMs
	) {
		return false;
	}

	if (
		typeof options.minSizeBytes === "number" &&
		file.size < options.minSizeBytes
	) {
		return false;
	}

	if (
		typeof options.maxSizeBytes === "number" &&
		file.size > options.maxSizeBytes
	) {
		return false;
	}

	return true;
};

const addRandomReviewSample = (
	sample: FileEntry[],
	entry: FileEntry,
	matchedCount: number,
	limit: number,
): void => {
	if (sample.length < limit) {
		sample.push(entry);
		return;
	}

	const replaceIndex = Math.floor(Math.random() * matchedCount);
	if (replaceIndex < limit) {
		sample[replaceIndex] = entry;
	}
};

const shuffleFileEntries = (files: FileEntry[]): FileEntry[] => {
	const shuffledFiles = [...files];

	for (let index = shuffledFiles.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(Math.random() * (index + 1));
		const currentFile = shuffledFiles[index];
		shuffledFiles[index] = shuffledFiles[swapIndex];
		shuffledFiles[swapIndex] = currentFile;
	}

	return shuffledFiles;
};

const buildRandomReviewIndex = async (
	sourcePath: string,
	recursive: boolean,
	onProgress?: ScanProgressCallback,
): Promise<RandomReviewIndexCacheEntry> => {
	const candidates: ArchiveCandidate[] = [];
	const directories = [sourcePath];
	let processedDirectories = 0;
	let totalDirectories = 1;

	onProgress?.({
		phase: "searching",
		processed: processedDirectories,
		total: totalDirectories,
		foundFiles: candidates.length,
		currentPath: sourcePath,
	});

	while (directories.length > 0) {
		const currentPath = directories.pop();
		if (!currentPath) {
			continue;
		}

		let items: fs.Dirent[];
		try {
			items = await fs.promises.readdir(currentPath, { withFileTypes: true });
		} catch (error) {
			console.warn(`재검토 디렉토리 읽기 실패: ${currentPath}`, error);
			continue;
		}

		for (const item of items) {
			const fullPath = path.join(currentPath, item.name);
			onProgress?.({
				phase: "searching",
				processed: processedDirectories,
				total: totalDirectories,
				foundFiles: candidates.length,
				currentPath,
				currentFileName: item.name,
			});

			if (item.isDirectory()) {
				if (recursive) {
					directories.push(fullPath);
					totalDirectories += 1;
				}
				continue;
			}

			if (!item.isFile() || !isZipFile(item.name)) {
				continue;
			}

			candidates.push({
				path: fullPath,
				name: item.name,
			});
		}

		processedDirectories += 1;
		onProgress?.({
			phase: "searching",
			processed: processedDirectories,
			total: totalDirectories,
			foundFiles: candidates.length,
			currentPath,
		});
	}

	const files: RandomReviewIndexedFile[] = [];

	onProgress?.({
		phase: "reading",
		processed: 0,
		total: candidates.length,
		foundFiles: files.length,
	});

	for (const [index, candidate] of candidates.entries()) {
		const relativePath = path.relative(sourcePath, candidate.path);

		onProgress?.({
			phase: "reading",
			processed: index,
			total: candidates.length,
			foundFiles: files.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});

		try {
			const stats = await fs.promises.stat(candidate.path);
			files.push({
				path: candidate.path,
				name: candidate.name,
				size: stats.size,
				modifiedTimeMs: stats.mtimeMs,
				...getGroupedArchiveMetadata(candidate.path),
				relativePath,
				searchText: `${candidate.name} ${relativePath}`.toLowerCase(),
			});
		} catch (error) {
			console.warn(`재검토 파일 정보 읽기 실패: ${candidate.path}`, error);
		}

		onProgress?.({
			phase: "reading",
			processed: index + 1,
			total: candidates.length,
			foundFiles: files.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});
	}

	onProgress?.({
		phase: "complete",
		processed: files.length,
		total: candidates.length,
		foundFiles: files.length,
	});

	return {
		sourcePath,
		recursive,
		indexedAt: Date.now(),
		files,
	};
};

const selectRandomReviewFiles = (
	indexedFiles: RandomReviewIndexedFile[],
	options: RandomReviewOptions,
	limit: number,
): { files: FileEntry[]; matchedCount: number } => {
	const sample: FileEntry[] = [];
	let matchedCount = 0;

	for (const file of indexedFiles) {
		if (!shouldIncludeRandomReviewFile(file, options)) {
			continue;
		}

		matchedCount += 1;
		addRandomReviewSample(
			sample,
			{
				path: file.path,
				name: file.name,
				size: file.size,
				modifiedTimeMs: file.modifiedTimeMs,
				isGrouped: file.isGrouped,
				groupName: file.groupName,
			},
			matchedCount,
			limit,
		);
	}

	return {
		files: shuffleFileEntries(sample),
		matchedCount,
	};
};

export const scanRandomReviewFiles = async (
	options: RandomReviewOptions,
	onProgress?: ScanProgressCallback,
): Promise<RandomReviewResult> => {
	const sourcePath = options.sourcePath.trim();

	if (!sourcePath) {
		throw new Error("재검토 경로가 지정되지 않았습니다.");
	}

	await ensurePathExists(
		sourcePath,
		"재검토 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const requestedLimit = Number.isFinite(options.limit) ? options.limit : 20;
	const limit = Math.min(200, Math.max(1, Math.floor(requestedLimit)));
	const cacheKey = getRandomReviewCacheKey(sourcePath, options.recursive);
	const cachedIndex = randomReviewIndexCache.get(cacheKey);
	const cacheUsed = Boolean(cachedIndex && !options.forceRefresh);
	const indexEntry = cacheUsed
		? cachedIndex
		: await buildRandomReviewIndex(sourcePath, options.recursive, onProgress);

	if (!indexEntry) {
		throw new Error("재검토 인덱스를 생성하지 못했습니다.");
	}

	if (cacheUsed) {
		randomReviewIndexCache.delete(cacheKey);
		randomReviewIndexCache.set(cacheKey, indexEntry);
		onProgress?.({
			phase: "complete",
			processed: indexEntry.files.length,
			total: indexEntry.files.length,
			foundFiles: indexEntry.files.length,
			currentPath: sourcePath,
			currentFileName: "인덱스 캐시 사용",
		});
	} else {
		setRandomReviewCacheEntry(cacheKey, indexEntry);
	}

	const selection = selectRandomReviewFiles(indexEntry.files, options, limit);

	return {
		files: selection.files,
		matchedCount: selection.matchedCount,
		scannedCount: indexEntry.files.length,
		sourcePath: indexEntry.sourcePath,
		cacheUsed,
		indexedAt: indexEntry.indexedAt,
		indexedCount: indexEntry.files.length,
	};
};

const ORIGIN_ALIASES = new Map<string, string>([
	["페이트 그랜드 오더", "fate grand order"],
	["fate grand order", "fate grand order"],
	["fate go", "fate grand order"],
	["동방 프로젝트", "touhou project"],
	["touhou project", "touhou project"],
	["아이돌마스터", "the idolmaster"],
	["the idolmaster", "the idolmaster"],
]);

const normalizeOrigin = (origin: string | undefined): string => {
	const normalizedOrigin = normalizeArchiveText(origin ?? "");
	return ORIGIN_ALIASES.get(normalizedOrigin) ?? normalizedOrigin;
};

const getSimilarGroupCacheKey = (
	sourcePath: string,
	recursive: boolean,
): string =>
	`${path.resolve(sourcePath).toLowerCase()}::similar::${recursive ? "recursive" : "flat"}`;

const isManagedDirectory = (directoryName: string): boolean =>
	APP_MANAGED_DIRECTORIES.has(directoryName.toLowerCase());

const isPathInside = (basePath: string, targetPath: string): boolean => {
	const relativePath = path.relative(
		path.resolve(basePath),
		path.resolve(targetPath),
	);
	return (
		Boolean(relativePath) &&
		!relativePath.startsWith("..") &&
		!path.isAbsolute(relativePath)
	);
};

const getRelativePathParts = (relativePath: string): string[] =>
	relativePath.split(path.sep).filter(Boolean);

const buildSimilarGroupFile = async (
	sourcePath: string,
	filePath: string,
	fileName: string,
): Promise<SimilarGroupIndexedFile> => {
	const relativePath = path.relative(sourcePath, filePath);
	const parts = getRelativePathParts(relativePath);
	const type = parts.length >= 2 ? parts[0] : undefined;
	const origin = parts.length >= 3 ? parts[1] : undefined;
	const parsedName = parseArchiveFileName(fileName);
	const stats = await fs.promises.stat(filePath);
	const artist = parsedName.artist;
	const category = parsedName.category;
	const title = parsedName.title;
	const normalizedType = normalizeArchiveText(type ?? "");
	const normalizedOrigin = normalizeOrigin(origin);
	const normalizedArtist = normalizeArchiveText(artist ?? "");
	const normalizedCategory = normalizeArchiveText(category ?? "");
	const normalizedBaseTitle = parsedName.baseTitle;

	return {
		path: filePath,
		relativePath,
		name: fileName,
		size: stats.size,
		modifiedTimeMs: stats.mtimeMs,
		type,
		origin,
		artist,
		category,
		title,
		code: parsedName.code,
		baseTitle: parsedName.baseTitle,
		seriesTokens: parsedName.seriesTokens,
		editionTokens: parsedName.editionTokens,
		searchText: normalizeArchiveText(
			`${relativePath} ${artist ?? ""} ${category ?? ""} ${title} ${parsedName.code ?? ""}`,
		),
		normalizedType,
		normalizedOrigin,
		normalizedArtist,
		normalizedBaseTitle,
		normalizedCategory,
	};
};

const buildSimilarGroupIndex = async (
	sourcePath: string,
	recursive: boolean,
	onProgress?: ScanProgressCallback,
): Promise<SimilarGroupIndexCacheEntry> => {
	const candidates: ArchiveCandidate[] = [];
	const directories = [sourcePath];
	let processedDirectories = 0;
	let totalDirectories = 1;

	onProgress?.({
		phase: "searching",
		processed: processedDirectories,
		total: totalDirectories,
		foundFiles: candidates.length,
		currentPath: sourcePath,
	});

	while (directories.length > 0) {
		const currentPath = directories.pop();
		if (!currentPath) {
			continue;
		}

		let items: fs.Dirent[];
		try {
			items = await fs.promises.readdir(currentPath, { withFileTypes: true });
		} catch (error) {
			console.warn(`유사 그룹 디렉토리 읽기 실패: ${currentPath}`, error);
			continue;
		}

		for (const item of items) {
			const fullPath = path.join(currentPath, item.name);
			onProgress?.({
				phase: "searching",
				processed: processedDirectories,
				total: totalDirectories,
				foundFiles: candidates.length,
				currentPath,
				currentFileName: item.name,
			});

			if (item.isDirectory()) {
				if (recursive && !isManagedDirectory(item.name)) {
					directories.push(fullPath);
					totalDirectories += 1;
				}
				continue;
			}

			if (!item.isFile() || !isArchiveFile(item.name)) {
				continue;
			}

			candidates.push({
				path: fullPath,
				name: item.name,
			});
		}

		processedDirectories += 1;
		onProgress?.({
			phase: "searching",
			processed: processedDirectories,
			total: totalDirectories,
			foundFiles: candidates.length,
			currentPath,
		});
	}

	const files: SimilarGroupIndexedFile[] = [];

	onProgress?.({
		phase: "reading",
		processed: 0,
		total: candidates.length,
		foundFiles: files.length,
	});

	for (const [index, candidate] of candidates.entries()) {
		onProgress?.({
			phase: "reading",
			processed: index,
			total: candidates.length,
			foundFiles: files.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});

		try {
			files.push(
				await buildSimilarGroupFile(sourcePath, candidate.path, candidate.name),
			);
		} catch (error) {
			console.warn(`유사 그룹 파일 정보 읽기 실패: ${candidate.path}`, error);
		}

		onProgress?.({
			phase: "reading",
			processed: index + 1,
			total: candidates.length,
			foundFiles: files.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});
	}

	onProgress?.({
		phase: "complete",
		processed: files.length,
		total: candidates.length,
		foundFiles: files.length,
	});

	return {
		sourcePath,
		recursive,
		indexedAt: Date.now(),
		files,
	};
};

const getBigramCounts = (value: string): Map<string, number> => {
	const counts = new Map<string, number>();
	const normalizedValue = value.replace(/\s+/g, "");

	if (normalizedValue.length < 2) {
		return counts;
	}

	for (let index = 0; index < normalizedValue.length - 1; index += 1) {
		const bigram = normalizedValue.slice(index, index + 2);
		counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
	}

	return counts;
};

const getTitleSimilarity = (left: string, right: string): number => {
	if (left === right) {
		return 1;
	}

	if (left.length < 8 || right.length < 8) {
		return 0;
	}

	const leftCounts = getBigramCounts(left);
	const rightCounts = getBigramCounts(right);
	let intersection = 0;
	let total = 0;

	for (const count of leftCounts.values()) {
		total += count;
	}

	for (const count of rightCounts.values()) {
		total += count;
	}

	for (const [bigram, leftCount] of leftCounts.entries()) {
		intersection += Math.min(leftCount, rightCounts.get(bigram) ?? 0);
	}

	return total === 0 ? 0 : (2 * intersection) / total;
};

const getGroupSignature = (files: SimilarGroupIndexedFile[]): string =>
	[...files]
		.map((file) => file.path)
		.sort()
		.join("|");

const createStableId = (value: string): string => {
	let hash = 0;

	for (let index = 0; index < value.length; index += 1) {
		hash = (hash << 5) - hash + value.charCodeAt(index);
		hash |= 0;
	}

	return `g-${Math.abs(hash).toString(36)}`;
};

const hasDifferentTokens = (
	files: SimilarGroupIndexedFile[],
	tokenType: "seriesTokens" | "editionTokens",
): boolean => {
	const tokenSets = new Set(
		files.map((file) => [...file[tokenType]].sort().join(",")),
	);
	return tokenSets.size > 1;
};

const toSimilarGroup = (
	files: SimilarGroupIndexedFile[],
	groupType: "code" | "exact" | "fuzzy",
	key: string,
	confidence: number,
	extraReasons: string[],
): SimilarGroup => {
	const representative = [...files].sort((left, right) => {
		const lengthDelta = left.title.length - right.title.length;
		return lengthDelta === 0
			? left.name.localeCompare(right.name)
			: lengthDelta;
	})[0];
	const reasons = [...extraReasons];

	if (hasDifferentTokens(files, "seriesTokens")) {
		reasons.push("시리즈 표식 차이");
	}

	if (hasDifferentTokens(files, "editionTokens")) {
		reasons.push("버전 표식 차이");
	}

	return {
		id: createStableId(`${groupType}:${key}:${getGroupSignature(files)}`),
		representativeTitle: representative?.title ?? files[0]?.name ?? "그룹",
		artist: representative?.artist,
		type: representative?.type,
		origin: representative?.origin,
		confidence,
		reasons: Array.from(new Set(reasons)),
		files: files.map(
			({
				searchText,
				normalizedType,
				normalizedOrigin,
				normalizedArtist,
				normalizedBaseTitle,
				normalizedCategory,
				...file
			}) => file,
		),
		totalSize: files.reduce((sum, file) => sum + file.size, 0),
	};
};

const addGroupCandidate = (
	groups: SimilarGroup[],
	seenSignatures: Set<string>,
	files: SimilarGroupIndexedFile[],
	groupType: "code" | "exact" | "fuzzy",
	key: string,
	confidence: number,
	reasons: string[],
	minGroupSize: number,
	minConfidence: number,
): void => {
	if (files.length < minGroupSize || confidence < minConfidence) {
		return;
	}

	const signature = getGroupSignature(files);
	if (seenSignatures.has(signature)) {
		return;
	}

	seenSignatures.add(signature);
	groups.push(toSimilarGroup(files, groupType, key, confidence, reasons));
};

const getExactGroupKey = (file: SimilarGroupIndexedFile): string =>
	[
		file.normalizedType,
		file.normalizedOrigin,
		file.normalizedArtist,
		file.normalizedBaseTitle,
	].join("|");

const getFuzzyBucketKey = (file: SimilarGroupIndexedFile): string =>
	[file.normalizedType, file.normalizedOrigin, file.normalizedArtist].join("|");

const getFuzzyPrefix = (title: string): string => title.slice(0, 4);

const getFilteredSimilarGroupFiles = (
	files: SimilarGroupIndexedFile[],
	options: SimilarGroupOptions,
): SimilarGroupIndexedFile[] => {
	const includeKeyword = normalizeKeyword(options.includeKeyword);
	const excludeKeyword = normalizeKeyword(options.excludeKeyword);

	return files.filter((file) => {
		if (includeKeyword && !file.searchText.includes(includeKeyword)) {
			return false;
		}

		if (excludeKeyword && file.searchText.includes(excludeKeyword)) {
			return false;
		}

		return Boolean(file.normalizedBaseTitle && file.normalizedArtist);
	});
};

const findSimilarGroupsFromIndex = (
	files: SimilarGroupIndexedFile[],
	options: SimilarGroupOptions,
): SimilarGroup[] => {
	const minGroupSize = Math.max(2, Math.floor(options.minGroupSize || 2));
	const minConfidence = Math.min(100, Math.max(0, options.minConfidence || 86));
	const filteredFiles = getFilteredSimilarGroupFiles(files, options);
	const groups: SimilarGroup[] = [];
	const seenSignatures = new Set<string>();
	const codeGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const exactGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const fuzzyBuckets = new Map<
		string,
		Map<string, SimilarGroupIndexedFile[]>
	>();

	for (const file of filteredFiles) {
		if (file.code) {
			const filesByCode = codeGroups.get(file.code) ?? [];
			filesByCode.push(file);
			codeGroups.set(file.code, filesByCode);
		}

		const exactKey = getExactGroupKey(file);
		const filesByExactKey = exactGroups.get(exactKey) ?? [];
		filesByExactKey.push(file);
		exactGroups.set(exactKey, filesByExactKey);

		const fuzzyBucketKey = getFuzzyBucketKey(file);
		const titlesByBucket =
			fuzzyBuckets.get(fuzzyBucketKey) ??
			new Map<string, SimilarGroupIndexedFile[]>();
		const filesByTitle = titlesByBucket.get(file.normalizedBaseTitle) ?? [];
		filesByTitle.push(file);
		titlesByBucket.set(file.normalizedBaseTitle, filesByTitle);
		fuzzyBuckets.set(fuzzyBucketKey, titlesByBucket);
	}

	for (const [code, codeFiles] of codeGroups.entries()) {
		addGroupCandidate(
			groups,
			seenSignatures,
			codeFiles,
			"code",
			code,
			100,
			["같은 코드"],
			minGroupSize,
			minConfidence,
		);
	}

	for (const [exactKey, exactFiles] of exactGroups.entries()) {
		const confidence = hasDifferentTokens(exactFiles, "seriesTokens") ? 96 : 92;
		addGroupCandidate(
			groups,
			seenSignatures,
			exactFiles,
			"exact",
			exactKey,
			confidence,
			["같은 작가/분류/기준 제목"],
			minGroupSize,
			minConfidence,
		);
	}

	for (const [bucketKey, titlesByBucket] of fuzzyBuckets.entries()) {
		const prefixBuckets = new Map<
			string,
			Array<[string, SimilarGroupIndexedFile[]]>
		>();

		for (const entry of titlesByBucket.entries()) {
			const [baseTitle] = entry;
			if (baseTitle.length < 8) {
				continue;
			}

			const prefix = getFuzzyPrefix(baseTitle);
			const entries = prefixBuckets.get(prefix) ?? [];
			entries.push(entry);
			prefixBuckets.set(prefix, entries);
		}

		for (const entries of prefixBuckets.values()) {
			for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
				const [leftTitle, leftFiles] = entries[leftIndex];

				for (
					let rightIndex = leftIndex + 1;
					rightIndex < entries.length;
					rightIndex += 1
				) {
					const [rightTitle, rightFiles] = entries[rightIndex];
					const similarity = getTitleSimilarity(leftTitle, rightTitle);

					if (similarity < 0.94) {
						continue;
					}

					addGroupCandidate(
						groups,
						seenSignatures,
						[...leftFiles, ...rightFiles],
						"fuzzy",
						`${bucketKey}:${leftTitle}:${rightTitle}`,
						Math.min(95, Math.round(82 + similarity * 12)),
						["제목 고유사도"],
						minGroupSize,
						minConfidence,
					);
				}
			}
		}
	}

	return [...groups].sort((left, right) => {
		const confidenceDelta = right.confidence - left.confidence;
		if (confidenceDelta !== 0) {
			return confidenceDelta;
		}

		const fileCountDelta = right.files.length - left.files.length;
		if (fileCountDelta !== 0) {
			return fileCountDelta;
		}

		return right.totalSize - left.totalSize;
	});
};

export const findSimilarGroups = async (
	options: SimilarGroupOptions,
	onProgress?: ScanProgressCallback,
): Promise<SimilarGroupResult> => {
	const sourcePath = options.sourcePath.trim();

	if (!sourcePath) {
		throw new Error("저장소 경로가 지정되지 않았습니다.");
	}

	await ensurePathExists(
		sourcePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const cacheKey = getSimilarGroupCacheKey(sourcePath, options.recursive);
	const cachedIndex = similarGroupIndexCache.get(cacheKey);
	const cacheUsed = Boolean(cachedIndex && !options.forceRefresh);
	const indexEntry = cacheUsed
		? cachedIndex
		: await buildSimilarGroupIndex(sourcePath, options.recursive, onProgress);

	if (!indexEntry) {
		throw new Error("유사 그룹 인덱스를 생성하지 못했습니다.");
	}

	if (cacheUsed) {
		similarGroupIndexCache.delete(cacheKey);
		similarGroupIndexCache.set(cacheKey, indexEntry);
		onProgress?.({
			phase: "complete",
			processed: indexEntry.files.length,
			total: indexEntry.files.length,
			foundFiles: indexEntry.files.length,
			currentPath: sourcePath,
			currentFileName: "인덱스 캐시 사용",
		});
	} else {
		setSimilarGroupCacheEntry(cacheKey, indexEntry);
	}

	const groups = findSimilarGroupsFromIndex(indexEntry.files, options);

	return {
		groups,
		sourcePath: indexEntry.sourcePath,
		scannedCount: indexEntry.files.length,
		groupedFileCount: groups.reduce(
			(total, group) => total + group.files.length,
			0,
		),
		cacheUsed,
		indexedAt: indexEntry.indexedAt,
	};
};

const collectArchiveFilesInDirectory = async (
	directoryPath: string,
): Promise<string[]> => {
	const archiveFiles: string[] = [];
	const entries = await fs.promises.readdir(directoryPath, {
		withFileTypes: true,
	});

	for (const entry of entries) {
		const entryPath = path.join(directoryPath, entry.name);

		if (entry.isDirectory()) {
			archiveFiles.push(...(await collectArchiveFilesInDirectory(entryPath)));
			continue;
		}

		if (entry.isFile() && isArchiveFile(entry.name)) {
			archiveFiles.push(entryPath);
		}
	}

	return archiveFiles;
};

const buildGroupFolderSummaries = async (
	storePath: string,
): Promise<GroupFolderSummary[]> => {
	const groupRootPath = path.join(storePath, "_grouped");
	if (!(await pathExists(groupRootPath))) {
		return [];
	}

	const groupEntries = await fs.promises.readdir(groupRootPath, {
		withFileTypes: true,
	});
	const summaries: GroupFolderSummary[] = [];

	for (const entry of groupEntries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const groupPath = path.join(groupRootPath, entry.name);
		const archivePaths = await collectArchiveFilesInDirectory(groupPath);
		if (archivePaths.length === 0) {
			continue;
		}

		const files = await Promise.all(
			archivePaths.map((filePath) =>
				buildSimilarGroupFile(groupPath, filePath, path.basename(filePath)),
			),
		);

		summaries.push({
			groupName: entry.name,
			groupPath,
			files,
			codes: new Set(
				files.map((file) => file.code).filter((code): code is string => !!code),
			),
			artists: new Set(
				files
					.map((file) => file.normalizedArtist)
					.filter((artist) => artist.length > 0),
			),
			baseTitles: new Set(
				files
					.map((file) => file.normalizedBaseTitle)
					.filter((title) => title.length > 0),
			),
			sampleFiles: files.slice(0, 3).map((file) => file.name),
		});
	}

	return summaries;
};

const scoreGroupMergeCandidate = (
	file: SimilarGroupIndexedFile,
	group: GroupFolderSummary,
): {
	confidence: number;
	reasons: string[];
} | null => {
	if (file.code && group.codes.has(file.code)) {
		return {
			confidence: 100,
			reasons: ["같은 코드"],
		};
	}

	if (!file.normalizedArtist || !group.artists.has(file.normalizedArtist)) {
		return null;
	}

	if (
		file.normalizedBaseTitle &&
		group.baseTitles.has(file.normalizedBaseTitle)
	) {
		return {
			confidence: 96,
			reasons: ["같은 작가", "같은 기준 제목"],
		};
	}

	if (file.normalizedBaseTitle.length < 8) {
		return null;
	}

	let bestSimilarity = 0;
	for (const groupTitle of group.baseTitles) {
		if (groupTitle.length < 8) {
			continue;
		}

		bestSimilarity = Math.max(
			bestSimilarity,
			getTitleSimilarity(file.normalizedBaseTitle, groupTitle),
		);
	}

	if (bestSimilarity < 0.94) {
		return null;
	}

	return {
		confidence: Math.min(95, Math.round(82 + bestSimilarity * 12)),
		reasons: ["같은 작가", "제목 고유사도"],
	};
};

export const findGroupMergeCandidates = async (
	fileList: GroupMergeSourceFile[],
	scanPath: string,
	storePath: string,
): Promise<GroupMergeCandidate[]> => {
	if (!storePath) {
		return [];
	}

	const resolvedScanPath = path.resolve(scanPath);
	const resolvedStorePath = path.resolve(storePath);
	await ensurePathExists(
		resolvedStorePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const groupSummaries = await buildGroupFolderSummaries(resolvedStorePath);
	if (groupSummaries.length === 0) {
		return [];
	}

	const candidates: GroupMergeCandidate[] = [];

	for (const file of fileList) {
		if (!(await pathExists(file.path))) {
			continue;
		}

		const indexedFile = await buildSimilarGroupFile(
			resolvedScanPath,
			file.path,
			file.name,
		);
		let bestCandidate: GroupMergeCandidate | null = null;

		for (const group of groupSummaries) {
			const score = scoreGroupMergeCandidate(indexedFile, group);
			if (!score) {
				continue;
			}

			if (!bestCandidate || score.confidence > bestCandidate.confidence) {
				bestCandidate = {
					filePath: file.path,
					fileName: file.name,
					relativePath: path.relative(resolvedScanPath, file.path),
					groupName: group.groupName,
					groupPath: group.groupPath,
					confidence: score.confidence,
					reasons: score.reasons,
					sampleFiles: group.sampleFiles,
				};
			}
		}

		if (bestCandidate && bestCandidate.confidence >= 90) {
			candidates.push(bestCandidate);
		}
	}

	return candidates.sort((left, right) => right.confidence - left.confidence);
};

const createGroupFolderName = (groupName: string): string => {
	const normalizedName = groupName
		.normalize("NFKC")
		.replace(/[<>:"/\\|?*]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	return (normalizedName || "group").slice(0, 120).trim() || "group";
};

const createNumberedDirectory = async (targetPath: string): Promise<string> => {
	let counter = 1;
	let nextPath = targetPath;

	while (await pathExists(nextPath)) {
		nextPath = `${targetPath}_${counter}`;
		counter += 1;
	}

	await fs.promises.mkdir(nextPath, { recursive: true });
	return nextPath;
};

export const trashFilesToRecycleBin = async (
	filePaths: string[],
): Promise<GroupOperationResult> => {
	const results: GroupOperationResult["results"] = [];

	for (const filePath of filePaths) {
		try {
			await ensurePathExists(filePath, "파일이 존재하지 않습니다.");
			await shell.trashItem(filePath);
			removeFileFromOrganizerCaches(filePath);
			results.push({
				path: filePath,
				success: true,
			});
		} catch (error) {
			results.push({
				path: filePath,
				success: false,
				error: error instanceof Error ? error.message : "알 수 없는 오류",
			});
		}
	}

	const successCount = results.filter((result) => result.success).length;

	return {
		success: successCount === results.length,
		results,
		summary: {
			total: results.length,
			success: successCount,
			failed: results.length - successCount,
		},
	};
};

export const moveGroupFilesToFolder = async (
	sourcePath: string,
	filePaths: string[],
	groupName: string,
): Promise<GroupOperationResult> => {
	const resolvedSourcePath = path.resolve(sourcePath);
	await ensurePathExists(
		resolvedSourcePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const groupRootPath = path.join(resolvedSourcePath, "_grouped");
	const groupFolderPath = await createNumberedDirectory(
		path.join(groupRootPath, createGroupFolderName(groupName)),
	);
	const results: GroupOperationResult["results"] = [];

	for (const filePath of filePaths) {
		try {
			if (!isPathInside(resolvedSourcePath, filePath)) {
				throw new Error("저장소 밖의 파일은 그룹 폴더로 이동할 수 없습니다.");
			}

			await ensurePathExists(filePath, "파일이 존재하지 않습니다.");
			const targetPath = await createNumberedPath(
				path.join(groupFolderPath, path.basename(filePath)),
			);
			await moveFileWithFallback(filePath, targetPath);
			results.push({
				path: filePath,
				success: true,
				targetPath,
			});
		} catch (error) {
			results.push({
				path: filePath,
				success: false,
				error: error instanceof Error ? error.message : "알 수 없는 오류",
			});
		}
	}

	const successCount = results.filter((result) => result.success).length;

	return {
		success: successCount === results.length,
		results,
		summary: {
			total: results.length,
			success: successCount,
			failed: results.length - successCount,
		},
	};
};

export const deleteFile = async (
	filePath: string,
): Promise<FileMutationResult> => {
	await ensurePathExists(filePath, "파일이 존재하지 않습니다.");
	await fs.promises.unlink(filePath);
	removeFileFromOrganizerCaches(filePath);

	return { success: true, message: "파일이 성공적으로 삭제되었습니다." };
};

export const checkDuplicateFiles = async (
	fileList: FileEntry[],
	scanPath: string,
	storePath: string,
): Promise<{
	hasDuplicates: boolean;
	duplicates: DuplicateFileInfo[];
	totalFiles: number;
}> => {
	if (!storePath) {
		throw new Error(
			"저장소 경로가 설정되지 않았습니다. 설정에서 저장소 경로를 먼저 설정해주세요.",
		);
	}

	await ensurePathExists(
		storePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const duplicates: DuplicateFileInfo[] = [];

	for (const file of fileList) {
		const relativePath = path.relative(scanPath, file.path);
		const targetPath = path.join(storePath, relativePath);

		if (!(await pathExists(targetPath))) {
			continue;
		}

		try {
			const targetStats = await fs.promises.stat(targetPath);
			duplicates.push({
				sourceFile: file.name,
				sourcePath: file.path,
				sourceSize: file.size,
				targetPath,
				targetSize: targetStats.size,
				relativePath,
			});
		} catch (error) {
			console.warn(`기존 파일 정보 읽기 실패: ${targetPath}`, error);
			duplicates.push({
				sourceFile: file.name,
				sourcePath: file.path,
				sourceSize: file.size,
				targetPath,
				targetSize: -1,
				relativePath,
			});
		}
	}

	return {
		hasDuplicates: duplicates.length > 0,
		duplicates,
		totalFiles: fileList.length,
	};
};

export const moveAllFilesToStore = async (
	fileList: FileEntry[],
	scanPath: string,
	storePath: string,
	duplicateActions: Record<string, DuplicateAction> = {},
	groupTargetDirectories: Record<string, string> = {},
): Promise<{
	success: boolean;
	results: MoveAllFileResult[];
	summary: { total: number; success: number; failed: number };
}> => {
	if (!storePath) {
		throw new Error(
			"저장소 경로가 설정되지 않았습니다. 설정에서 저장소 경로를 먼저 설정해주세요.",
		);
	}

	await ensurePathExists(
		storePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const results: MoveAllFileResult[] = [];

	for (const file of fileList) {
		try {
			await ensurePathExists(file.path, "파일이 존재하지 않습니다.");

			const relativePath = path.relative(scanPath, file.path);
			const groupTargetDirectory =
				groupTargetDirectories[relativePath] ||
				groupTargetDirectories[file.path] ||
				groupTargetDirectories[file.name];
			const isGroupMerge = Boolean(groupTargetDirectory);
			const targetPath = isGroupMerge
				? path.join(groupTargetDirectory, path.basename(file.path))
				: path.join(storePath, relativePath);

			if (groupTargetDirectory) {
				const groupRootPath = path.join(storePath, "_grouped");
				if (!isPathInside(groupRootPath, groupTargetDirectory)) {
					throw new Error("저장소 그룹 폴더 밖으로는 편입할 수 없습니다.");
				}
			}

			await ensureTargetDirectory(targetPath);

			if (await pathExists(targetPath)) {
				if (isGroupMerge) {
					const renamedTargetPath = await createNumberedPath(targetPath);
					await moveFileWithFallback(file.path, renamedTargetPath);
					results.push({
						file: file.name,
						success: true,
						action: "그룹 편입",
						targetPath: path.relative(storePath, renamedTargetPath),
					});
					continue;
				}

				const action =
					duplicateActions[relativePath] || duplicateActions[file.name];

				if (action === "skip") {
					results.push({
						file: file.name,
						success: true,
						action: "건너뜀",
						targetPath: relativePath,
					});
					continue;
				}

				if (action === "overwrite") {
					await moveFileWithFallback(file.path, targetPath);
					results.push({
						file: file.name,
						success: true,
						action: "덮어쓰기",
						targetPath: relativePath,
					});
					continue;
				}

				const renamedTargetPath = await createNumberedPath(targetPath);
				await moveFileWithFallback(file.path, renamedTargetPath);
				results.push({
					file: file.name,
					success: true,
					action: "이름 변경",
					targetPath: path.relative(storePath, renamedTargetPath),
				});
				continue;
			}

			await moveFileWithFallback(file.path, targetPath);
			results.push({
				file: file.name,
				success: true,
				action: isGroupMerge ? "그룹 편입" : "이동",
				targetPath: path.relative(storePath, targetPath),
			});
		} catch (error) {
			console.error(`파일 이동 실패: ${file.name}`, error);
			results.push({
				file: file.name,
				success: false,
				error: error instanceof Error ? error.message : "알 수 없는 오류",
			});
		}
	}

	const successCount = results.filter((result) => result.success).length;
	const failedCount = results.length - successCount;

	return {
		success: failedCount === 0,
		results,
		summary: {
			total: fileList.length,
			success: successCount,
			failed: failedCount,
		},
	};
};

export const copyFileToPath = async (
	filePath: string,
	targetPath: string,
): Promise<FileMutationResult> => {
	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensureTargetDirectory(targetPath);
	await fs.promises.copyFile(filePath, targetPath);
	invalidateOrganizerCachesContainingPath(targetPath);

	return {
		success: true,
		message: "파일이 성공적으로 복사되었습니다.",
		targetPath,
	};
};

export const moveFileToPath = async (
	filePath: string,
	targetPath: string,
): Promise<FileMutationResult> => {
	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensureTargetDirectory(targetPath);
	await moveFileWithFallback(filePath, targetPath);

	return {
		success: true,
		message: "파일이 성공적으로 이동되었습니다.",
		targetPath,
	};
};

export const keepFileCopy = async (
	filePath: string,
	keepPath: string,
): Promise<FileMutationResult> => {
	if (!keepPath) {
		throw new Error(
			"보관 경로가 설정되지 않았습니다. 설정에서 보관 경로를 먼저 설정해주세요.",
		);
	}

	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensurePathExists(
		keepPath,
		"보관 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const fileName = path.basename(filePath);
	const targetPath = await createNumberedPath(path.join(keepPath, fileName));
	await fs.promises.copyFile(filePath, targetPath);
	invalidateOrganizerCachesContainingPath(targetPath);

	return {
		success: true,
		message: "파일이 성공적으로 보관되었습니다.",
		targetPath,
	};
};
