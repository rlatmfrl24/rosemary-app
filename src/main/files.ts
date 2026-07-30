import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app, shell } from "electron";
import {
	normalizeArchiveText,
	parseArchiveFileName,
} from "../shared/archive-name";
import type { ArchiveGalleryRecoveryEntry } from "../shared/crawler";
import type {
	ArchiveContentScanMode,
	DuplicateCheckResult,
	DuplicateFileInfo,
	FavoriteArtistCandidate,
	FavoriteArtistCandidateResult,
	FileThumbnail,
	GroupedFolderMigrationPreview,
	GroupedFolderMigrationResult,
	GroupMergeCandidate,
	GroupMergeCandidateResult,
	GroupMergeSourceFile,
	GroupOperationResult,
	RandomReviewOptions,
	RandomReviewResult,
	ScanArchiveProgress,
	ScanArchiveResult,
	SimilarGroup,
	SimilarGroupFile,
	SimilarGroupFolderSegments,
	SimilarGroupOptions,
	SimilarGroupQueue,
	SimilarGroupResult,
	SimilarGroupReviewStateInput,
	SimilarGroupReviewStatus,
} from "../shared/file-organizer";
import type { GallerySourceMetadata } from "../shared/gallery-metadata";
import {
	buildOrganizationMetadataEvidence,
	createOrganizationFileFallback,
	evaluateOrganizationMetadataCompatibility,
	findOrganizationMetadataConflicts,
	getOrganizationGalleryRelation,
	normalizeOrganizationCategory,
	normalizeOrganizationOrigin,
	type OrganizationMetadataEvidence,
	type OrganizationReviewIssue,
	resolveDuplicateTarget,
	resolveFavoriteArtistTargets,
} from "../shared/organization-metadata";
import {
	flushArchiveContentCache,
	getArchiveContentSummary,
} from "./archive-content";
import { ensurePathExists, pathExists } from "./process-utils";

export interface FileEntry {
	path: string;
	name: string;
	size: number;
	thumbnail?: FileThumbnail;
	modifiedTimeMs?: number;
	isGrouped?: boolean;
	groupName?: string;
	artist?: string;
	type?: string;
	origin?: string;
	sourceMetadata?: GallerySourceMetadata;
	archiveRecovery?: ArchiveGalleryRecoveryEntry;
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

interface ScanIndexCandidate {
	path: string;
	name: string;
	relativePath: string;
	pathKey: string;
}

interface ScanIndexFileRow {
	source_key: string;
	recursive: number;
	index_kind: string;
	path_key: string;
	source_path: string;
	file_path: string;
	relative_path: string;
	name: string;
	size: number;
	modified_time_ms: number;
	is_grouped: number;
	group_name: string | null;
	updated_at: string;
}

interface ScanIndexRefreshOptions {
	sourcePath: string;
	recursive: boolean;
	indexKind: "archive" | "random-review-zip";
	includeFile: (fileName: string) => boolean;
	forceRefresh?: boolean;
	errorLabel: string;
	signal?: AbortSignal;
}

interface ScanIndexRefreshResult {
	sourcePath: string;
	recursive: boolean;
	indexedAt: number;
	files: RandomReviewIndexedFile[];
	cacheUsed: boolean;
	reusedCount: number;
	refreshedCount: number;
	removedCount: number;
}

interface SimilarGroupIndexedFile extends SimilarGroupFile {
	searchText: string;
	normalizedType: string;
	normalizedOrigin: string;
	normalizedArtist: string;
	normalizedBaseTitle: string;
	normalizedCategory: string;
	normalizedArtists: string[];
	normalizedGroups: string[];
	normalizedParodies: string[];
	organizationMetadata: OrganizationMetadataEvidence;
	filenameType?: string;
	filenameOrigin?: string;
	filenameArtist?: string;
}

interface SimilarGroupIndexCacheEntry {
	sourcePath: string;
	recursive: boolean;
	indexedAt: number;
	files: SimilarGroupIndexedFile[];
}

interface SimilarGroupDiskIndexCacheRecord extends SimilarGroupIndexCacheEntry {
	cacheKey: string;
	contentScanMode: ArchiveContentScanMode;
	updatedAt: number;
}

interface SimilarGroupDiskIndexCacheFile {
	version: 1;
	records: Record<string, SimilarGroupDiskIndexCacheRecord>;
}

interface GroupFolderSummary {
	groupName: string;
	groupPath: string;
	folderSegments: SimilarGroupFolderSegments;
	files: SimilarGroupIndexedFile[];
	codes: Set<string>;
	artists: Set<string>;
	groups: Set<string>;
	parodies: Set<string>;
	categories: Set<string>;
	lineageGalleryIds: Set<string>;
	baseTitles: Set<string>;
	contentFingerprints: Set<string>;
	sampleHashes: Set<string>;
	crcWindowSignatures: Set<string>;
	sampleFiles: string[];
	reviewIssues: OrganizationReviewIssue[];
}

interface TitleSimilarityScore {
	value: number;
	dice: number;
	jaroWinkler: number;
	tokenJaccard: number;
	tokenContainment: number;
	lengthBalance: number;
	reasons: string[];
}

type SimilarGroupType =
	| "code"
	| "content"
	| "lineage"
	| "exact"
	| "fuzzy"
	| "merge";

interface SimilarGroupReviewRecord {
	reviewKey: string;
	contentSignature: string;
	status: SimilarGroupReviewStatus;
	updatedAt: number;
}

interface SimilarGroupReviewState {
	records: Record<string, SimilarGroupReviewRecord>;
}

export type GalleryMetadataResolver = (
	galleryIds: string[],
) => Record<string, GallerySourceMetadata | undefined>;

const hydrateOrganizerSourceFiles = <TFile extends GroupMergeSourceFile>(
	files: TFile[],
	resolveMetadata?: GalleryMetadataResolver,
): TFile[] => {
	if (!resolveMetadata) return files;

	const galleryIdsByPath = new Map<string, string>();
	for (const file of files) {
		const galleryId = parseArchiveFileName(file.name).code;
		if (galleryId) galleryIdsByPath.set(file.path, galleryId);
	}
	const metadataByGalleryId = resolveMetadata([...galleryIdsByPath.values()]);

	return files.map((file) => {
		const galleryId = galleryIdsByPath.get(file.path);
		return {
			...file,
			sourceMetadata: galleryId ? metadataByGalleryId[galleryId] : undefined,
		};
	});
};

interface FileMutationResult {
	success: boolean;
	message: string;
	targetPath?: string;
}

interface MoveAllFileResult {
	file: string;
	sourcePath: string;
	relativePath: string;
	success: boolean;
	error?: string;
	action?: string;
	targetPath?: string;
}

type DuplicateAction = "overwrite" | "skip";

const MAX_SIMILAR_GROUP_CACHE_ENTRIES = 4;
const similarGroupIndexCache = new Map<string, SimilarGroupIndexCacheEntry>();
const MAX_SIMILAR_GROUP_DISK_CACHE_ENTRIES = 8;
const APP_MANAGED_DIRECTORIES = new Set(["_grouped", "_trash"]);
const UNKNOWN_TYPE_SEGMENT = "_unknown_type";
const UNKNOWN_ORIGIN_SEGMENT = "_unknown_origin";
const UNKNOWN_ARTIST_SEGMENT = "_unknown_artist";
const UNKNOWN_TITLE_SEGMENT = "_unknown_title";
const HIERARCHICAL_GROUP_ROOTS = new Set([
	UNKNOWN_TYPE_SEGMENT,
	"artistcg",
	"doujinshi",
	"gamecg",
	"imageset",
	"manga",
	"misc",
	"non-h",
	"western",
]);
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

let scanIndexDatabase: DatabaseSync | null = null;
let similarGroupDiskIndexCache: SimilarGroupDiskIndexCacheFile | null = null;
let similarGroupDiskIndexCacheSaveTask: Promise<void> = Promise.resolve();

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

const getScanIndexDatabase = (): DatabaseSync => {
	if (scanIndexDatabase) {
		return scanIndexDatabase;
	}

	const databasePath = path.join(app.getPath("userData"), "scan-index.sqlite");
	const database = new DatabaseSync(databasePath);
	database.exec("PRAGMA journal_mode = WAL;");
	database.exec(`
		CREATE TABLE IF NOT EXISTS scan_index_files (
			source_key TEXT NOT NULL,
			recursive INTEGER NOT NULL,
			index_kind TEXT NOT NULL,
			path_key TEXT NOT NULL,
			source_path TEXT NOT NULL,
			file_path TEXT NOT NULL,
			relative_path TEXT NOT NULL,
			name TEXT NOT NULL,
			size INTEGER NOT NULL,
			modified_time_ms REAL NOT NULL,
			is_grouped INTEGER NOT NULL DEFAULT 0,
			group_name TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (source_key, recursive, index_kind, path_key)
		);

		CREATE TABLE IF NOT EXISTS scan_index_roots (
			source_key TEXT NOT NULL,
			recursive INTEGER NOT NULL,
			index_kind TEXT NOT NULL,
			source_path TEXT NOT NULL,
			indexed_at INTEGER NOT NULL,
			file_count INTEGER NOT NULL,
			reused_count INTEGER NOT NULL DEFAULT 0,
			refreshed_count INTEGER NOT NULL DEFAULT 0,
			removed_count INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (source_key, recursive, index_kind)
		);

		CREATE INDEX IF NOT EXISTS idx_scan_index_files_source
		ON scan_index_files(source_key, recursive, index_kind);
	`);

	scanIndexDatabase = database;
	return database;
};

const getScanIndexRows = (
	sourceKey: string,
	recursive: boolean,
	indexKind: ScanIndexRefreshOptions["indexKind"],
): ScanIndexFileRow[] => {
	const database = getScanIndexDatabase();
	return database
		.prepare(
			`
				SELECT
					source_key,
					recursive,
					index_kind,
					path_key,
					source_path,
					file_path,
					relative_path,
					name,
					size,
					modified_time_ms,
					is_grouped,
					group_name,
					updated_at
				FROM scan_index_files
				WHERE source_key = ? AND recursive = ? AND index_kind = ?
			`,
		)
		.all(
			sourceKey,
			recursive ? 1 : 0,
			indexKind,
		) as unknown as ScanIndexFileRow[];
};

const mapScanIndexRowToFile = (
	row: ScanIndexFileRow,
): RandomReviewIndexedFile => ({
	path: row.file_path,
	name: row.name,
	size: row.size,
	modifiedTimeMs: row.modified_time_ms,
	isGrouped: row.is_grouped === 1 ? true : undefined,
	groupName: row.group_name ?? undefined,
	relativePath: row.relative_path,
	searchText: `${row.name} ${row.relative_path}`.toLowerCase(),
});

const upsertScanIndexRecords = (params: {
	sourceKey: string;
	recursive: boolean;
	indexKind: ScanIndexRefreshOptions["indexKind"];
	sourcePath: string;
	indexedAt: number;
	files: Array<{ pathKey: string; file: RandomReviewIndexedFile }>;
	stalePathKeys: string[];
	reusedCount: number;
	refreshedCount: number;
	removedCount: number;
}): void => {
	const database = getScanIndexDatabase();
	const updatedAt = new Date(params.indexedAt).toISOString();
	const recursiveValue = params.recursive ? 1 : 0;
	const upsertFile = database.prepare(`
		INSERT INTO scan_index_files (
			source_key,
			recursive,
			index_kind,
			path_key,
			source_path,
			file_path,
			relative_path,
			name,
			size,
			modified_time_ms,
			is_grouped,
			group_name,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(source_key, recursive, index_kind, path_key)
		DO UPDATE SET
			source_path = excluded.source_path,
			file_path = excluded.file_path,
			relative_path = excluded.relative_path,
			name = excluded.name,
			size = excluded.size,
			modified_time_ms = excluded.modified_time_ms,
			is_grouped = excluded.is_grouped,
			group_name = excluded.group_name,
			updated_at = excluded.updated_at
	`);
	const deleteFile = database.prepare(`
		DELETE FROM scan_index_files
		WHERE source_key = ? AND recursive = ? AND index_kind = ? AND path_key = ?
	`);
	const upsertRoot = database.prepare(`
		INSERT INTO scan_index_roots (
			source_key,
			recursive,
			index_kind,
			source_path,
			indexed_at,
			file_count,
			reused_count,
			refreshed_count,
			removed_count,
			updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(source_key, recursive, index_kind)
		DO UPDATE SET
			source_path = excluded.source_path,
			indexed_at = excluded.indexed_at,
			file_count = excluded.file_count,
			reused_count = excluded.reused_count,
			refreshed_count = excluded.refreshed_count,
			removed_count = excluded.removed_count,
			updated_at = excluded.updated_at
	`);

	database.exec("BEGIN IMMEDIATE TRANSACTION");
	try {
		for (const { pathKey, file } of params.files) {
			upsertFile.run(
				params.sourceKey,
				recursiveValue,
				params.indexKind,
				pathKey,
				params.sourcePath,
				file.path,
				file.relativePath,
				file.name,
				file.size,
				file.modifiedTimeMs ?? 0,
				file.isGrouped ? 1 : 0,
				file.groupName ?? null,
				updatedAt,
			);
		}

		for (const pathKey of params.stalePathKeys) {
			deleteFile.run(
				params.sourceKey,
				recursiveValue,
				params.indexKind,
				pathKey,
			);
		}

		upsertRoot.run(
			params.sourceKey,
			recursiveValue,
			params.indexKind,
			params.sourcePath,
			params.indexedAt,
			params.reusedCount + params.refreshedCount,
			params.reusedCount,
			params.refreshedCount,
			params.removedCount,
			updatedAt,
		);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
};

const refreshScanIndex = async (
	options: ScanIndexRefreshOptions,
	onProgress?: ScanProgressCallback,
): Promise<ScanIndexRefreshResult> => {
	const sourcePath = path.resolve(options.sourcePath);
	const sourceKey = getComparablePath(sourcePath);
	const throwIfAborted = (): void => {
		if (options.signal?.aborted) {
			throw (
				options.signal.reason ?? new DOMException("scan-aborted", "AbortError")
			);
		}
	};
	throwIfAborted();
	const existingRows = getScanIndexRows(
		sourceKey,
		options.recursive,
		options.indexKind,
	);
	const existingRowsByPath = new Map(
		existingRows.map((row) => [row.path_key, row]),
	);
	const candidates: ScanIndexCandidate[] = [];
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
		throwIfAborted();
		const currentPath = directories.pop();
		if (!currentPath) {
			continue;
		}

		let items: fs.Dirent[];
		try {
			items = await fs.promises.readdir(currentPath, { withFileTypes: true });
		} catch (error) {
			console.warn(
				`${options.errorLabel} 디렉토리 읽기 실패: ${currentPath}`,
				error,
			);
			continue;
		}

		for (const item of items) {
			throwIfAborted();
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
				if (options.recursive) {
					directories.push(fullPath);
					totalDirectories += 1;
				}
				continue;
			}

			if (!item.isFile() || !options.includeFile(item.name)) {
				continue;
			}

			candidates.push({
				path: fullPath,
				name: item.name,
				relativePath: path.relative(sourcePath, fullPath),
				pathKey: getComparablePath(fullPath),
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
	const refreshedFiles: Array<{
		pathKey: string;
		file: RandomReviewIndexedFile;
	}> = [];
	const seenPathKeys = new Set<string>();
	let reusedCount = 0;
	let refreshedCount = 0;

	onProgress?.({
		phase: "reading",
		processed: 0,
		total: candidates.length,
		foundFiles: files.length,
	});

	for (const [index, candidate] of candidates.entries()) {
		throwIfAborted();
		seenPathKeys.add(candidate.pathKey);

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
			const existingRow = existingRowsByPath.get(candidate.pathKey);
			const canReuseExistingRow =
				existingRow &&
				!options.forceRefresh &&
				existingRow.size === stats.size &&
				Math.abs(existingRow.modified_time_ms - stats.mtimeMs) < 1;

			if (canReuseExistingRow) {
				files.push(mapScanIndexRowToFile(existingRow));
				reusedCount += 1;
				onProgress?.({
					phase: "reading",
					processed: index + 1,
					total: candidates.length,
					foundFiles: files.length,
					currentPath: path.dirname(candidate.path),
					currentFileName: candidate.name,
				});
				continue;
			}

			const file: RandomReviewIndexedFile = {
				path: candidate.path,
				name: candidate.name,
				size: stats.size,
				modifiedTimeMs: stats.mtimeMs,
				...getGroupedArchiveMetadata(candidate.path),
				relativePath: candidate.relativePath,
				searchText: `${candidate.name} ${candidate.relativePath}`.toLowerCase(),
			};
			files.push(file);
			refreshedFiles.push({
				pathKey: candidate.pathKey,
				file,
			});
			refreshedCount += 1;
		} catch (error) {
			console.warn(
				`${options.errorLabel} 파일 정보 읽기 실패: ${candidate.path}`,
				error,
			);
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

	const stalePathKeys = [...existingRowsByPath.keys()].filter(
		(pathKey) => !seenPathKeys.has(pathKey),
	);
	const indexedAt = Date.now();
	upsertScanIndexRecords({
		sourceKey,
		recursive: options.recursive,
		indexKind: options.indexKind,
		sourcePath,
		indexedAt,
		files: refreshedFiles,
		stalePathKeys,
		reusedCount,
		refreshedCount,
		removedCount: stalePathKeys.length,
	});

	onProgress?.({
		phase: "complete",
		processed: files.length,
		total: candidates.length,
		foundFiles: files.length,
		currentPath: sourcePath,
		currentFileName:
			refreshedCount > 0 ? `신규/갱신 ${refreshedCount}개` : "DB 인덱스 사용",
	});

	return {
		sourcePath,
		recursive: options.recursive,
		indexedAt,
		files,
		cacheUsed: existingRows.length > 0 && !options.forceRefresh,
		reusedCount,
		refreshedCount,
		removedCount: stalePathKeys.length,
	};
};

const getSimilarGroupDiskIndexCachePath = (): string =>
	path.join(app.getPath("userData"), "similar-group-index-cache-v1.json");

const createEmptySimilarGroupDiskIndexCache =
	(): SimilarGroupDiskIndexCacheFile => ({
		version: 1,
		records: {},
	});

const loadSimilarGroupDiskIndexCache =
	async (): Promise<SimilarGroupDiskIndexCacheFile> => {
		if (similarGroupDiskIndexCache) {
			return similarGroupDiskIndexCache;
		}

		try {
			const cachePath = getSimilarGroupDiskIndexCachePath();
			if (!(await pathExists(cachePath))) {
				similarGroupDiskIndexCache = createEmptySimilarGroupDiskIndexCache();
				return similarGroupDiskIndexCache;
			}

			const data = await fs.promises.readFile(cachePath, "utf8");
			const parsedCache = JSON.parse(
				data,
			) as Partial<SimilarGroupDiskIndexCacheFile>;
			similarGroupDiskIndexCache = {
				version: 1,
				records: parsedCache.records ?? {},
			};
			return similarGroupDiskIndexCache;
		} catch (error) {
			console.warn("유사 그룹 인덱스 캐시를 불러오지 못했습니다:", error);
			similarGroupDiskIndexCache = createEmptySimilarGroupDiskIndexCache();
			return similarGroupDiskIndexCache;
		}
	};

const pruneSimilarGroupDiskIndexCache = (
	cache: SimilarGroupDiskIndexCacheFile,
): void => {
	const records = Object.entries(cache.records);
	if (records.length <= MAX_SIMILAR_GROUP_DISK_CACHE_ENTRIES) {
		return;
	}

	const removeCount = records.length - MAX_SIMILAR_GROUP_DISK_CACHE_ENTRIES;
	for (const [cacheKey] of records
		.sort(([, left], [, right]) => left.updatedAt - right.updatedAt)
		.slice(0, removeCount)) {
		delete cache.records[cacheKey];
	}
};

const writeSimilarGroupDiskIndexCache = async (
	cache: SimilarGroupDiskIndexCacheFile,
): Promise<void> => {
	pruneSimilarGroupDiskIndexCache(cache);
	const cachePath = getSimilarGroupDiskIndexCachePath();
	await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
	await fs.promises.writeFile(cachePath, JSON.stringify(cache));
};

const queueSimilarGroupDiskIndexCacheSave = (): void => {
	similarGroupDiskIndexCacheSaveTask = similarGroupDiskIndexCacheSaveTask
		.catch(() => undefined)
		.then(async () => {
			if (similarGroupDiskIndexCache) {
				await writeSimilarGroupDiskIndexCache(similarGroupDiskIndexCache);
			}
		});

	void similarGroupDiskIndexCacheSaveTask.catch((error) => {
		console.warn("유사 그룹 인덱스 캐시 저장에 실패했습니다:", error);
	});
};

const getSimilarGroupDiskIndexCacheEntry = async (
	cacheKey: string,
): Promise<SimilarGroupIndexCacheEntry | undefined> => {
	const cache = await loadSimilarGroupDiskIndexCache();
	const record = cache.records[cacheKey];

	if (!record || !Array.isArray(record.files)) {
		if (record) {
			delete cache.records[cacheKey];
			queueSimilarGroupDiskIndexCacheSave();
		}
		return undefined;
	}

	record.updatedAt = Date.now();
	queueSimilarGroupDiskIndexCacheSave();

	return {
		sourcePath: record.sourcePath,
		recursive: record.recursive,
		indexedAt: record.indexedAt,
		files: record.files,
	};
};

const setSimilarGroupDiskIndexCacheEntry = async (
	cacheKey: string,
	cacheEntry: SimilarGroupIndexCacheEntry,
	contentScanMode: ArchiveContentScanMode,
): Promise<void> => {
	const cache = await loadSimilarGroupDiskIndexCache();
	cache.records[cacheKey] = {
		...cacheEntry,
		cacheKey,
		contentScanMode,
		updatedAt: Date.now(),
	};
	await writeSimilarGroupDiskIndexCache(cache);
};

const removeFileFromSimilarGroupDiskCache = async (
	filePath: string,
): Promise<void> => {
	const cache = await loadSimilarGroupDiskIndexCache();
	let changed = false;

	for (const [cacheKey, cacheEntry] of Object.entries(cache.records)) {
		const nextFiles = cacheEntry.files.filter(
			(file) => !isSamePath(file.path, filePath),
		);

		if (nextFiles.length === cacheEntry.files.length) {
			continue;
		}

		changed = true;
		if (nextFiles.length === 0) {
			delete cache.records[cacheKey];
			continue;
		}

		cache.records[cacheKey] = {
			...cacheEntry,
			files: nextFiles,
			updatedAt: Date.now(),
		};
	}

	if (changed) {
		await writeSimilarGroupDiskIndexCache(cache);
	}
};

const invalidateSimilarGroupDiskCachesContainingPath = async (
	filePath: string,
): Promise<void> => {
	const cache = await loadSimilarGroupDiskIndexCache();
	let changed = false;

	for (const [cacheKey, cacheEntry] of Object.entries(cache.records)) {
		if (
			isPathSameOrInside(cacheEntry.sourcePath, filePath) ||
			isPathSameOrInside(filePath, cacheEntry.sourcePath)
		) {
			delete cache.records[cacheKey];
			changed = true;
		}
	}

	if (changed) {
		await writeSimilarGroupDiskIndexCache(cache);
	}
};

const removeFileFromSimilarGroupCache = async (
	filePath: string,
): Promise<void> => {
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

	try {
		await removeFileFromSimilarGroupDiskCache(filePath);
	} catch (error) {
		console.warn("유사 그룹 디스크 캐시 파일 제거 실패:", error);
	}
};

const removeFileFromOrganizerCaches = async (
	filePath: string,
): Promise<void> => {
	await removeFileFromSimilarGroupCache(filePath);
};

const invalidateOrganizerCachesContainingPath = async (
	filePath: string,
): Promise<void> => {
	for (const [cacheKey, cacheEntry] of similarGroupIndexCache.entries()) {
		if (isPathSameOrInside(cacheEntry.sourcePath, filePath)) {
			similarGroupIndexCache.delete(cacheKey);
		}
	}

	try {
		await invalidateSimilarGroupDiskCachesContainingPath(filePath);
	} catch (error) {
		console.warn("유사 그룹 디스크 캐시 무효화 실패:", error);
	}
};

const invalidateOrganizerCachesForMove = (
	sourcePath: string,
	targetPath: string,
): Promise<void> => {
	return Promise.all([
		invalidateOrganizerCachesContainingPath(sourcePath),
		invalidateOrganizerCachesContainingPath(targetPath),
	]).then(() => undefined);
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
		await invalidateOrganizerCachesForMove(sourcePath, targetPath);
	} catch (error) {
		if (isErrnoException(error) && error.code === "EXDEV") {
			await fs.promises.copyFile(sourcePath, targetPath);
			await fs.promises.unlink(sourcePath);
			await invalidateOrganizerCachesForMove(sourcePath, targetPath);
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
	signal?: AbortSignal,
): Promise<ScanArchiveResult> => {
	if (!targetPath) {
		throw new Error("경로가 지정되지 않았습니다.");
	}

	const indexResult = await refreshScanIndex(
		{
			sourcePath: targetPath,
			recursive: true,
			indexKind: "archive",
			includeFile: isArchiveFile,
			errorLabel: "파일 스캔",
			signal,
		},
		onProgress,
	);

	return {
		files: indexResult.files.map(
			({ relativePath, searchText, ...file }) => file,
		),
		indexSummary: {
			cacheUsed: indexResult.cacheUsed,
			indexedAt: indexResult.indexedAt,
			indexedCount: indexResult.files.length,
			reusedCount: indexResult.reusedCount,
			refreshedCount: indexResult.refreshedCount,
			removedCount: indexResult.removedCount,
		},
	};
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
	const indexResult = await refreshScanIndex(
		{
			sourcePath,
			recursive: options.recursive,
			indexKind: "random-review-zip",
			includeFile: isZipFile,
			forceRefresh: options.forceRefresh,
			errorLabel: "재검토",
		},
		onProgress,
	);

	if (!indexResult) {
		throw new Error("재검토 인덱스를 생성하지 못했습니다.");
	}

	const selection = selectRandomReviewFiles(indexResult.files, options, limit);

	return {
		files: selection.files,
		matchedCount: selection.matchedCount,
		scannedCount: indexResult.files.length,
		sourcePath: indexResult.sourcePath,
		cacheUsed: indexResult.cacheUsed,
		indexedAt: indexResult.indexedAt,
		indexedCount: indexResult.files.length,
		reusedIndexCount: indexResult.reusedCount,
		refreshedIndexCount: indexResult.refreshedCount,
		removedIndexCount: indexResult.removedCount,
	};
};

const normalizeOrigin = (origin: string | undefined): string => {
	return normalizeOrganizationOrigin(origin ?? "");
};

const getSimilarGroupContentScanMode = (
	options: SimilarGroupOptions,
): ArchiveContentScanMode => options.contentScanMode ?? "smart";

const getInitialSimilarGroupContentScanMode = (
	contentScanMode: ArchiveContentScanMode,
): ArchiveContentScanMode =>
	contentScanMode === "smart" ? "metadata" : contentScanMode;

const getSimilarGroupCacheKey = (
	sourcePath: string,
	recursive: boolean,
	contentScanMode: ArchiveContentScanMode,
): string =>
	`${path.resolve(sourcePath).toLowerCase()}::similar::${recursive ? "recursive" : "flat"}::content:${contentScanMode}`;

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
	contentScanMode: ArchiveContentScanMode,
	forceContentRefresh = false,
	sourceMetadata?: GallerySourceMetadata,
	pathFallback?: { type?: string; origin?: string },
): Promise<SimilarGroupIndexedFile> => {
	const relativePath = path.relative(sourcePath, filePath);
	const parts = getRelativePathParts(relativePath);
	const type = pathFallback?.type ?? (parts.length >= 2 ? parts[0] : undefined);
	const origin =
		pathFallback?.origin ?? (parts.length >= 3 ? parts[1] : undefined);
	const parsedName = parseArchiveFileName(fileName);
	const stats = await fs.promises.stat(filePath);
	const content = await getArchiveContentSummary(
		filePath,
		stats,
		contentScanMode,
		forceContentRefresh,
	);
	const filenameArtist = parsedName.artist;
	const category = parsedName.category;
	const title = parsedName.title;
	const filenameType = type;
	const filenameOrigin = origin;
	const fallback = createOrganizationFileFallback(
		parsedName,
		filenameType,
		filenameOrigin,
	);
	const organizationMetadata = buildOrganizationMetadataEvidence(
		fallback,
		sourceMetadata,
	);
	const reviewIssues = findOrganizationMetadataConflicts(
		filePath,
		fallback,
		sourceMetadata,
	);
	const artist = organizationMetadata.effectiveArtists.join(", ") || undefined;
	const effectiveType = organizationMetadata.effectiveCategory ?? filenameType;
	const effectiveOrigin =
		organizationMetadata.effectiveParodies.join(" · ") || filenameOrigin;
	const normalizedType = normalizeOrganizationCategory(effectiveType ?? "");
	const normalizedOrigin = normalizeOrigin(effectiveOrigin);
	const normalizedArtist = normalizeArchiveText(artist ?? "");
	const normalizedCategory = normalizeArchiveText(category ?? "");
	const normalizedBaseTitle = parsedName.baseTitle;

	return {
		path: filePath,
		relativePath,
		name: fileName,
		size: stats.size,
		modifiedTimeMs: stats.mtimeMs,
		artist,
		category,
		title,
		code: parsedName.code,
		baseTitle: parsedName.baseTitle,
		seriesTokens: parsedName.seriesTokens,
		editionTokens: parsedName.editionTokens,
		content,
		searchText: normalizeArchiveText(
			`${relativePath} ${artist ?? ""} ${category ?? ""} ${title} ${parsedName.code ?? ""}`,
		),
		normalizedType,
		normalizedOrigin,
		normalizedArtist,
		normalizedBaseTitle,
		normalizedCategory,
		normalizedArtists:
			organizationMetadata.effectiveArtists.map(normalizeArchiveText),
		normalizedGroups: organizationMetadata.groups.map(normalizeArchiveText),
		normalizedParodies: organizationMetadata.effectiveParodies.map(
			normalizeOrganizationOrigin,
		),
		organizationMetadata,
		filenameType,
		filenameOrigin,
		filenameArtist,
		type: effectiveType,
		origin: effectiveOrigin,
		sourceMetadata,
		reviewIssues: reviewIssues.length > 0 ? reviewIssues : undefined,
	};
};

const hydrateSimilarGroupFilesWithMetadata = (
	files: SimilarGroupIndexedFile[],
	resolveMetadata?: GalleryMetadataResolver,
): SimilarGroupIndexedFile[] => {
	const galleryIds = files
		.map((file) => file.code)
		.filter((galleryId): galleryId is string => Boolean(galleryId));
	const metadataByGalleryId = resolveMetadata?.(galleryIds) ?? {};

	return files.map((file) => {
		const parsedName = parseArchiveFileName(file.name);
		const relativeParts = getRelativePathParts(file.relativePath);
		const filenameType =
			file.filenameType ??
			(relativeParts.length >= 2 ? relativeParts[0] : undefined);
		const filenameOrigin =
			file.filenameOrigin ??
			(relativeParts.length >= 3 ? relativeParts[1] : undefined);
		const filenameArtist = file.filenameArtist ?? parsedName.artist;
		const sourceMetadata = file.code
			? metadataByGalleryId[file.code]
			: undefined;
		const fallback = {
			galleryId: parsedName.code,
			artist: filenameArtist,
			type: filenameType,
			origin: filenameOrigin,
		};
		const organizationMetadata = buildOrganizationMetadataEvidence(
			fallback,
			sourceMetadata,
		);
		const reviewIssues = findOrganizationMetadataConflicts(
			file.path,
			fallback,
			sourceMetadata,
		);
		const artist =
			organizationMetadata.effectiveArtists.join(", ") || filenameArtist;
		const type = organizationMetadata.effectiveCategory ?? filenameType;
		const origin =
			organizationMetadata.effectiveParodies.join(" · ") || filenameOrigin;

		return {
			...file,
			type,
			origin,
			artist,
			sourceMetadata,
			reviewIssues: reviewIssues.length > 0 ? reviewIssues : undefined,
			normalizedType: normalizeOrganizationCategory(type ?? ""),
			normalizedOrigin: normalizeOrganizationOrigin(origin ?? ""),
			normalizedArtist: normalizeArchiveText(artist ?? ""),
			normalizedArtists:
				organizationMetadata.effectiveArtists.map(normalizeArchiveText),
			normalizedGroups: organizationMetadata.groups.map(normalizeArchiveText),
			normalizedParodies: organizationMetadata.effectiveParodies.map(
				normalizeOrganizationOrigin,
			),
			organizationMetadata,
			filenameType,
			filenameOrigin,
			filenameArtist,
		};
	});
};

const addSmartSampleCandidates = (
	candidatePaths: Set<string>,
	files: SimilarGroupIndexedFile[],
): void => {
	if (files.length < 2 || !files.some((file) => file.content?.imageCount)) {
		return;
	}

	for (const file of files) {
		if (
			file.content?.imageCount &&
			!file.content.sampleHashSignature &&
			file.content.status !== "failed"
		) {
			candidatePaths.add(file.path);
		}
	}
};

const collectSmartSampleCandidatePaths = (
	files: SimilarGroupIndexedFile[],
): Set<string> => {
	const candidatePaths = new Set<string>();
	const codeGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const exactGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const crcWindowGroups = new Map<string, SimilarGroupIndexedFile[]>();

	for (const file of files) {
		if (file.code) {
			const codeFiles = codeGroups.get(file.code) ?? [];
			codeFiles.push(file);
			codeGroups.set(file.code, codeFiles);
		}

		if (file.normalizedArtist && file.normalizedBaseTitle) {
			const exactKey = [
				file.normalizedType,
				file.normalizedOrigin,
				file.normalizedArtist,
				file.normalizedBaseTitle,
			].join("|");
			const exactFiles = exactGroups.get(exactKey) ?? [];
			exactFiles.push(file);
			exactGroups.set(exactKey, exactFiles);
		}

		const crcWindowSignature = file.content?.crcWindowSignature;
		if (crcWindowSignature && file.normalizedArtist && file.normalizedOrigin) {
			const crcWindowKey = [
				file.normalizedType,
				file.normalizedOrigin,
				file.normalizedArtist,
				crcWindowSignature,
			].join("|");
			const crcWindowFiles = crcWindowGroups.get(crcWindowKey) ?? [];
			crcWindowFiles.push(file);
			crcWindowGroups.set(crcWindowKey, crcWindowFiles);
		}
	}

	for (const groupedFiles of [
		...codeGroups.values(),
		...exactGroups.values(),
		...crcWindowGroups.values(),
	]) {
		addSmartSampleCandidates(candidatePaths, groupedFiles);
	}

	return candidatePaths;
};

const upgradeSmartSampleCandidates = async (
	sourcePath: string,
	files: SimilarGroupIndexedFile[],
	forceContentRefresh: boolean,
	onProgress?: ScanProgressCallback,
): Promise<void> => {
	const candidatePaths = collectSmartSampleCandidatePaths(files);
	if (candidatePaths.size === 0) {
		return;
	}

	const fileIndexes = new Map(
		files.map((file, index) => [getComparablePath(file.path), index]),
	);
	const totalWork = files.length + candidatePaths.size;
	let processed = 0;

	for (const filePath of candidatePaths) {
		const fileIndex = fileIndexes.get(getComparablePath(filePath));
		if (fileIndex === undefined) {
			continue;
		}

		const file = files[fileIndex];
		if (!file) {
			continue;
		}

		onProgress?.({
			phase: "content",
			processed: files.length + processed,
			total: totalWork,
			foundFiles: files.length,
			currentPath: path.dirname(file.path),
			currentFileName: `샘플 승격: ${file.name}`,
		});

		try {
			files[fileIndex] = await buildSimilarGroupFile(
				sourcePath,
				file.path,
				file.name,
				"sample",
				forceContentRefresh,
			);
		} catch (error) {
			console.warn(`유사 그룹 샘플 해시 읽기 실패: ${file.path}`, error);
		}

		processed += 1;
		onProgress?.({
			phase: "content",
			processed: files.length + processed,
			total: totalWork,
			foundFiles: files.length,
			currentPath: path.dirname(file.path),
			currentFileName: `샘플 승격: ${file.name}`,
		});
	}

	await flushArchiveContentCache();
};

const buildSimilarGroupIndex = async (
	sourcePath: string,
	recursive: boolean,
	contentScanMode: ArchiveContentScanMode,
	forceContentRefresh: boolean,
	onProgress?: ScanProgressCallback,
): Promise<SimilarGroupIndexCacheEntry> => {
	const initialContentScanMode =
		getInitialSimilarGroupContentScanMode(contentScanMode);
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
			phase: initialContentScanMode === "off" ? "reading" : "content",
			processed: index,
			total: candidates.length,
			foundFiles: files.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});

		try {
			files.push(
				await buildSimilarGroupFile(
					sourcePath,
					candidate.path,
					candidate.name,
					initialContentScanMode,
					forceContentRefresh,
				),
			);
		} catch (error) {
			console.warn(`유사 그룹 파일 정보 읽기 실패: ${candidate.path}`, error);
		}

		onProgress?.({
			phase: initialContentScanMode === "off" ? "reading" : "content",
			processed: index + 1,
			total: candidates.length,
			foundFiles: files.length,
			currentPath: path.dirname(candidate.path),
			currentFileName: candidate.name,
		});
	}

	await flushArchiveContentCache();

	if (contentScanMode === "smart") {
		await upgradeSmartSampleCandidates(
			sourcePath,
			files,
			forceContentRefresh,
			onProgress,
		);
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

const getDiceCoefficient = (left: string, right: string): number => {
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

const getTitleTokens = (value: string): string[] =>
	Array.from(
		new Set(
			normalizeArchiveText(value)
				.split(/\s+/)
				.filter((token) => token.length >= 2),
		),
	);

const getSetIntersectionSize = (
	leftSet: Set<string>,
	rightSet: Set<string>,
): number => {
	let intersectionSize = 0;
	for (const item of leftSet) {
		if (rightSet.has(item)) {
			intersectionSize += 1;
		}
	}
	return intersectionSize;
};

const getTokenSimilarity = (
	left: string,
	right: string,
): {
	jaccard: number;
	containment: number;
} => {
	const leftTokens = getTitleTokens(left);
	const rightTokens = getTitleTokens(right);
	if (leftTokens.length === 0 || rightTokens.length === 0) {
		return {
			jaccard: 0,
			containment: 0,
		};
	}

	const leftSet = new Set(leftTokens);
	const rightSet = new Set(rightTokens);
	const intersectionSize = getSetIntersectionSize(leftSet, rightSet);
	const unionSize = new Set([...leftSet, ...rightSet]).size;

	return {
		jaccard: unionSize === 0 ? 0 : intersectionSize / unionSize,
		containment: intersectionSize / Math.min(leftSet.size, rightSet.size),
	};
};

const getJaroWinklerSimilarity = (left: string, right: string): number => {
	if (left === right) {
		return 1;
	}

	const leftLength = left.length;
	const rightLength = right.length;
	if (leftLength === 0 || rightLength === 0) {
		return 0;
	}

	const matchDistance = Math.max(
		0,
		Math.floor(Math.max(leftLength, rightLength) / 2) - 1,
	);
	const leftMatches = new Array<boolean>(leftLength).fill(false);
	const rightMatches = new Array<boolean>(rightLength).fill(false);
	let matches = 0;

	for (let leftIndex = 0; leftIndex < leftLength; leftIndex += 1) {
		const start = Math.max(0, leftIndex - matchDistance);
		const end = Math.min(rightLength, leftIndex + matchDistance + 1);

		for (let rightIndex = start; rightIndex < end; rightIndex += 1) {
			if (rightMatches[rightIndex] || left[leftIndex] !== right[rightIndex]) {
				continue;
			}

			leftMatches[leftIndex] = true;
			rightMatches[rightIndex] = true;
			matches += 1;
			break;
		}
	}

	if (matches === 0) {
		return 0;
	}

	let rightCursor = 0;
	let transpositions = 0;
	for (let leftIndex = 0; leftIndex < leftLength; leftIndex += 1) {
		if (!leftMatches[leftIndex]) {
			continue;
		}

		while (!rightMatches[rightCursor]) {
			rightCursor += 1;
		}

		if (left[leftIndex] !== right[rightCursor]) {
			transpositions += 1;
		}
		rightCursor += 1;
	}

	const jaro =
		(matches / leftLength +
			matches / rightLength +
			(matches - transpositions / 2) / matches) /
		3;
	const commonPrefixLength = Math.min(4, leftLength, rightLength);
	let prefixLength = 0;
	for (let index = 0; index < commonPrefixLength; index += 1) {
		if (left[index] !== right[index]) {
			break;
		}
		prefixLength += 1;
	}

	return jaro + prefixLength * 0.1 * (1 - jaro);
};

const getTitleSimilarityScore = (
	left: string,
	right: string,
): TitleSimilarityScore => {
	const normalizedLeft = normalizeArchiveText(left);
	const normalizedRight = normalizeArchiveText(right);
	if (normalizedLeft === normalizedRight) {
		return {
			value: 1,
			dice: 1,
			jaroWinkler: 1,
			tokenJaccard: 1,
			tokenContainment: 1,
			lengthBalance: 1,
			reasons: ["같은 기준 제목"],
		};
	}

	if (normalizedLeft.length < 8 || normalizedRight.length < 8) {
		return {
			value: 0,
			dice: 0,
			jaroWinkler: 0,
			tokenJaccard: 0,
			tokenContainment: 0,
			lengthBalance: 0,
			reasons: ["짧은 제목 보수 판정"],
		};
	}

	const dice = getDiceCoefficient(normalizedLeft, normalizedRight);
	const jaroWinkler = getJaroWinklerSimilarity(normalizedLeft, normalizedRight);
	const tokenSimilarity = getTokenSimilarity(normalizedLeft, normalizedRight);
	const lengthBalance =
		Math.min(normalizedLeft.length, normalizedRight.length) /
		Math.max(normalizedLeft.length, normalizedRight.length);
	let value =
		dice * 0.46 +
		jaroWinkler * 0.34 +
		tokenSimilarity.jaccard * 0.14 +
		tokenSimilarity.containment * 0.06;

	if (tokenSimilarity.containment >= 0.95 && lengthBalance >= 0.78) {
		value = Math.max(value, 0.965);
	}

	if (dice >= 0.985 && jaroWinkler >= 0.985) {
		value = Math.max(value, 0.985);
	}

	if (lengthBalance < 0.58 && tokenSimilarity.containment < 0.8) {
		value = Math.min(value, 0.89);
	}

	const reasons: string[] = [];
	if (dice >= 0.96) {
		reasons.push("문자 배열 고유사도");
	}
	if (jaroWinkler >= 0.96) {
		reasons.push("제목 철자 유사도");
	}
	if (tokenSimilarity.jaccard >= 0.78 || tokenSimilarity.containment >= 0.9) {
		reasons.push("제목 토큰 일치");
	}

	return {
		value: Math.min(1, Math.max(0, value)),
		dice,
		jaroWinkler,
		tokenJaccard: tokenSimilarity.jaccard,
		tokenContainment: tokenSimilarity.containment,
		lengthBalance,
		reasons,
	};
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

const sanitizePathSegment = (
	value: string | undefined,
	fallback: string,
): string => {
	const normalizedSegment = (value ?? "")
		.normalize("NFKC")
		.split("")
		.map((char) =>
			char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? " " : char,
		)
		.join("")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/g, "");
	const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
	const safeSegment = normalizedSegment || fallback;
	const limitedSegment = safeSegment.slice(0, 120).trim() || fallback;

	return reservedNames.test(limitedSegment)
		? `${limitedSegment}_`
		: limitedSegment;
};

const getFolderSegmentsFromFile = (
	file: SimilarGroupIndexedFile | undefined,
	titleOverride?: string,
): SimilarGroupFolderSegments => {
	const hasMetadataConflict = file?.reviewIssues?.some(
		(issue) => issue.kind === "metadata-conflict",
	);
	return {
		type: sanitizePathSegment(
			hasMetadataConflict ? file?.filenameType : file?.type,
			UNKNOWN_TYPE_SEGMENT,
		),
		origin: sanitizePathSegment(
			hasMetadataConflict ? file?.filenameOrigin : file?.origin,
			UNKNOWN_ORIGIN_SEGMENT,
		),
		artist: sanitizePathSegment(
			hasMetadataConflict ? file?.filenameArtist : file?.artist,
			UNKNOWN_ARTIST_SEGMENT,
		),
		title: sanitizePathSegment(
			titleOverride ?? file?.title ?? file?.baseTitle,
			UNKNOWN_TITLE_SEGMENT,
		),
	};
};

const getGroupTargetPath = (
	sourcePath: string,
	folderSegments: SimilarGroupFolderSegments,
): string =>
	path.join(
		sourcePath,
		"_grouped",
		folderSegments.type,
		folderSegments.origin,
		folderSegments.artist,
		folderSegments.title,
	);

const getContentSignature = (files: SimilarGroupIndexedFile[]): string =>
	createStableId(
		[...files]
			.map(
				(file) =>
					`${file.relativePath}:${file.size}:${Math.round(file.modifiedTimeMs ?? 0)}`,
			)
			.sort()
			.join("|"),
	);

const getReviewKey = (
	files: SimilarGroupIndexedFile[],
	queue: Exclude<SimilarGroupQueue, "safe">,
	key: string,
): string => {
	const representative = files[0];
	return createStableId(
		[
			queue,
			representative?.normalizedType ?? "",
			representative?.normalizedOrigin ?? "",
			representative?.normalizedArtist ?? "",
			representative?.normalizedBaseTitle ?? "",
			key,
		].join("|"),
	);
};

const getSimilarGroupQueue = (
	groupType: SimilarGroupType,
	files: SimilarGroupIndexedFile[],
): Exclude<SimilarGroupQueue, "safe"> => {
	if (groupType === "merge") {
		return "merge";
	}

	if (groupType === "fuzzy") {
		return "suspicious";
	}
	if (groupType === "lineage") {
		return "suspicious";
	}

	if (groupType === "code" || groupType === "content") {
		return "cleanup";
	}

	if (hasDifferentTokens(files, "seriesTokens")) {
		return "series";
	}

	if (hasDifferentTokens(files, "editionTokens")) {
		return "cleanup";
	}

	return "cleanup";
};

const hasDisjointMetadataValues = (valueGroups: string[][]): boolean => {
	const populatedGroups = valueGroups.filter((values) => values.length > 0);
	if (populatedGroups.length < 2) return false;
	let intersection = new Set(populatedGroups[0]);
	for (const values of populatedGroups.slice(1)) {
		const nextValues = new Set(values);
		intersection = new Set(
			[...intersection].filter((value) => nextValues.has(value)),
		);
	}
	return intersection.size === 0;
};

const hasCommonMetadataValue = (valueGroups: string[][]): boolean => {
	const populatedGroups = valueGroups.filter((values) => values.length > 0);
	if (populatedGroups.length < 2) return false;
	let intersection = new Set(populatedGroups[0]);
	for (const values of populatedGroups.slice(1)) {
		const nextValues = new Set(values);
		intersection = new Set(
			[...intersection].filter((value) => nextValues.has(value)),
		);
	}
	return intersection.size > 0;
};

const getGroupMetadataAgreement = (
	files: SimilarGroupIndexedFile[],
): { boost: number; reasons: string[] } => {
	const groupMatch = hasCommonMetadataValue(
		files.map((file) => file.normalizedGroups),
	);
	const parodyMatch = hasCommonMetadataValue(
		files.map((file) =>
			file.organizationMetadata.parodies.map(normalizeOrganizationOrigin),
		),
	);
	const categoryMatch = hasCommonMetadataValue(
		files.map((file) =>
			file.organizationMetadata.category
				? [normalizeOrganizationCategory(file.organizationMetadata.category)]
				: [],
		),
	);
	return {
		boost:
			(groupMatch ? 3 : 0) + (parodyMatch ? 2 : 0) + (categoryMatch ? 1 : 0),
		reasons: [
			...(groupMatch ? ["원천 그룹 일치"] : []),
			...(parodyMatch ? ["원천 오리진 일치"] : []),
			...(categoryMatch ? ["원천 유형 일치"] : []),
		],
	};
};

const getGroupMetadataMismatchReasons = (
	files: SimilarGroupIndexedFile[],
): string[] => {
	const reasons: string[] = [];
	if (hasDisjointMetadataValues(files.map((file) => file.normalizedGroups))) {
		reasons.push("원천 그룹 불일치");
	}
	if (
		hasDisjointMetadataValues(
			files.map((file) =>
				file.organizationMetadata.parodies.map(normalizeOrganizationOrigin),
			),
		)
	) {
		reasons.push("원천 오리진 불일치");
	}
	if (
		hasDisjointMetadataValues(
			files.map((file) =>
				file.organizationMetadata.category
					? [normalizeOrganizationCategory(file.organizationMetadata.category)]
					: [],
			),
		)
	) {
		reasons.push("원천 유형 불일치");
	}
	return reasons;
};

const toSimilarGroup = (
	files: SimilarGroupIndexedFile[],
	groupType: SimilarGroupType,
	key: string,
	confidence: number,
	extraReasons: string[],
	targetGroup?: GroupFolderSummary,
): SimilarGroup => {
	const representative = [...files].sort((left, right) => {
		const lengthDelta = left.title.length - right.title.length;
		return lengthDelta === 0
			? left.name.localeCompare(right.name)
			: lengthDelta;
	})[0];
	const metadataIssues = files.flatMap((file) => file.reviewIssues ?? []);
	const metadataMismatchReasons = getGroupMetadataMismatchReasons(files);
	const hasMetadataIssue =
		metadataIssues.length > 0 || metadataMismatchReasons.length > 0;
	const reasons = [
		...extraReasons,
		...metadataIssues.map((issue) => issue.message),
		...metadataMismatchReasons,
	];
	const queue = hasMetadataIssue
		? "suspicious"
		: getSimilarGroupQueue(groupType, files);
	const recommendationAction =
		queue === "cleanup"
			? "trash"
			: queue === "series"
				? "group"
				: queue === "merge"
					? "merge"
					: "review";
	const riskLevel =
		queue === "suspicious"
			? "suspicious"
			: queue === "merge"
				? "review"
				: "safe";
	const representativeTitle = representative?.title ?? files[0]?.name ?? "그룹";
	const folderSegments =
		targetGroup?.folderSegments ??
		getFolderSegmentsFromFile(representative, representativeTitle);
	const reviewKey = getReviewKey(files, queue, key);

	if (hasDifferentTokens(files, "seriesTokens")) {
		reasons.push("시리즈 표식 차이");
	}

	if (hasDifferentTokens(files, "editionTokens")) {
		reasons.push("버전 표식 차이");
	}

	return {
		id: createStableId(`${groupType}:${key}:${getGroupSignature(files)}`),
		representativeTitle,
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
				normalizedArtists,
				normalizedGroups,
				normalizedParodies,
				organizationMetadata,
				filenameType,
				filenameOrigin,
				filenameArtist,
				...file
			}) => file,
		),
		totalSize: files.reduce((sum, file) => sum + file.size, 0),
		queue,
		recommendationAction,
		riskLevel,
		reviewKey,
		contentSignature: getContentSignature(files),
		folderSegments,
		targetGroupName: targetGroup?.groupName,
		targetGroupPath: targetGroup?.groupPath,
	};
};

const addGroupCandidate = (
	groups: SimilarGroup[],
	seenSignatures: Set<string>,
	files: SimilarGroupIndexedFile[],
	groupType: SimilarGroupType,
	key: string,
	confidence: number,
	reasons: string[],
	minGroupSize: number,
	minConfidence: number,
	targetGroup?: GroupFolderSummary,
): void => {
	if (files.length < minGroupSize || confidence < minConfidence) {
		return;
	}

	const signature = getGroupSignature(files);
	if (seenSignatures.has(signature)) {
		return;
	}

	seenSignatures.add(signature);
	groups.push(
		toSimilarGroup(files, groupType, key, confidence, reasons, targetGroup),
	);
};

const getOrganizationActorKey = (file: SimilarGroupIndexedFile): string =>
	(file.normalizedGroups.length > 0
		? file.normalizedGroups
		: file.normalizedArtists
	)
		.slice()
		.sort()
		.join("+");

const getExactGroupKey = (file: SimilarGroupIndexedFile): string =>
	[
		file.normalizedType,
		file.normalizedOrigin,
		getOrganizationActorKey(file),
		file.normalizedBaseTitle,
	].join("|");

const getFuzzyBucketKey = (file: SimilarGroupIndexedFile): string =>
	[
		file.normalizedType,
		file.normalizedOrigin,
		getOrganizationActorKey(file),
	].join("|");

const getCompactTitlePrefix = (title: string): string =>
	title.replace(/\s+/g, "").slice(0, 4);

const getFuzzyBlockKeys = (title: string): string[] => {
	const blockKeys = new Set<string>();
	const compactPrefix = getCompactTitlePrefix(title);
	if (compactPrefix.length >= 4) {
		blockKeys.add(`p:${compactPrefix}`);
	}

	for (const token of getTitleTokens(title)
		.filter((item) => item.length >= 3)
		.sort()
		.slice(0, 4)) {
		blockKeys.add(`t:${token.slice(0, 8)}`);
	}

	return [...blockKeys];
};

const FUZZY_MIN_BASE_TITLE_LENGTH = 10;
const FUZZY_TITLE_SIMILARITY_THRESHOLD = 0.975;
const GROUP_MERGE_TITLE_SIMILARITY_THRESHOLD = 0.94;

const isStrongFuzzyTitleMatch = (score: TitleSimilarityScore): boolean => {
	if (score.value >= 0.98) {
		return true;
	}

	if (score.value < FUZZY_TITLE_SIMILARITY_THRESHOLD) {
		return false;
	}

	if (score.lengthBalance < 0.76 && score.tokenContainment < 0.95) {
		return false;
	}

	return (
		score.tokenJaccard >= 0.8 ||
		score.tokenContainment >= 0.94 ||
		(score.dice >= 0.975 && score.jaroWinkler >= 0.97)
	);
};

const isStrongMergeTitleMatch = (score: TitleSimilarityScore): boolean => {
	if (score.value >= 0.97) {
		return true;
	}

	return (
		score.value >= GROUP_MERGE_TITLE_SIMILARITY_THRESHOLD &&
		score.lengthBalance >= 0.62 &&
		(score.tokenJaccard >= 0.68 ||
			score.tokenContainment >= 0.86 ||
			(score.dice >= 0.94 && score.jaroWinkler >= 0.94))
	);
};

const getFuzzyTitleConfidence = (score: TitleSimilarityScore): number =>
	Math.min(96, Math.max(90, Math.round(78 + score.value * 18)));

const getMergeTitleConfidence = (score: TitleSimilarityScore): number =>
	Math.min(95, Math.max(90, Math.round(80 + score.value * 16)));

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

		const hasIdentityEvidence = Boolean(
			file.code ||
				getContentFingerprintKey(file) ||
				file.organizationMetadata.lineageGalleryIds.length > 0,
		);
		return (
			hasIdentityEvidence ||
			Boolean(file.normalizedBaseTitle && getOrganizationActorKey(file))
		);
	});
};

const getContentFingerprintKey = (
	file: SimilarGroupIndexedFile,
): string | undefined =>
	file.content?.contentFingerprint && file.content.imageCount > 0
		? file.content.contentFingerprint
		: undefined;

const getDuplicatedContentReasons = (
	files: SimilarGroupIndexedFile[],
): string[] => {
	const reasons: string[] = [];
	const sampleHashOwners = new Map<string, string>();
	let hasSampleOverlap = false;

	for (const file of files) {
		for (const sampleHash of file.content?.sampleHashes ?? []) {
			const ownerPath = sampleHashOwners.get(sampleHash);
			if (ownerPath && ownerPath !== file.path) {
				hasSampleOverlap = true;
			}
			sampleHashOwners.set(sampleHash, file.path);
		}
	}

	if (hasSampleOverlap) {
		reasons.push("샘플 이미지 일치");
	}

	const crcWindowCounts = new Map<string, number>();
	for (const file of files) {
		const signature = file.content?.crcWindowSignature;
		if (signature) {
			crcWindowCounts.set(signature, (crcWindowCounts.get(signature) ?? 0) + 1);
		}
	}

	if ([...crcWindowCounts.values()].some((count) => count >= 2)) {
		reasons.push("내용 일부 중복");
	}

	const contentFiles = files.filter((file) => file.content?.imageCount);
	if (contentFiles.length >= 2) {
		const sortedByImageCount = [...contentFiles].sort(
			(left, right) =>
				(right.content?.imageCount ?? 0) - (left.content?.imageCount ?? 0),
		);
		const largest = sortedByImageCount[0]?.content;
		const secondLargest = sortedByImageCount[1]?.content;

		if (
			largest &&
			secondLargest &&
			(largest.imageCount >= secondLargest.imageCount + 5 ||
				largest.totalUncompressedSize >=
					secondLargest.totalUncompressedSize * 1.35)
		) {
			reasons.push("페이지 수 우세");
		}
	}

	return Array.from(new Set(reasons));
};

const findSimilarGroupsFromIndex = (
	files: SimilarGroupIndexedFile[],
	options: SimilarGroupOptions,
	groupSummaries: GroupFolderSummary[] = [],
): SimilarGroup[] => {
	const minGroupSize = Math.max(2, Math.floor(options.minGroupSize || 2));
	const minConfidence = Math.min(100, Math.max(0, options.minConfidence || 90));
	const filteredFiles = getFilteredSimilarGroupFiles(files, options);
	const groups: SimilarGroup[] = [];
	const seenSignatures = new Set<string>();
	const contentGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const codeGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const lineageGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const exactGroups = new Map<string, SimilarGroupIndexedFile[]>();
	const fuzzyBuckets = new Map<
		string,
		Map<string, SimilarGroupIndexedFile[]>
	>();

	for (const file of filteredFiles) {
		const contentKey = getContentFingerprintKey(file);
		if (contentKey) {
			const filesByContent = contentGroups.get(contentKey) ?? [];
			filesByContent.push(file);
			contentGroups.set(contentKey, filesByContent);
		}

		if (file.code) {
			const filesByCode = codeGroups.get(file.code) ?? [];
			filesByCode.push(file);
			codeGroups.set(file.code, filesByCode);
		}
		for (const galleryId of file.organizationMetadata.lineageGalleryIds) {
			const filesByLineage = lineageGroups.get(galleryId) ?? [];
			if (!filesByLineage.some((item) => item.path === file.path)) {
				filesByLineage.push(file);
			}
			lineageGroups.set(galleryId, filesByLineage);
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
			["같은 gallery id"],
			minGroupSize,
			minConfidence,
		);
	}

	for (const [contentKey, contentFiles] of contentGroups.entries()) {
		addGroupCandidate(
			groups,
			seenSignatures,
			contentFiles,
			"content",
			contentKey,
			100,
			["압축 내용 동일"],
			minGroupSize,
			minConfidence,
		);
	}

	for (const [galleryId, lineageFiles] of lineageGroups.entries()) {
		addGroupCandidate(
			groups,
			seenSignatures,
			lineageFiles,
			"lineage",
			galleryId,
			99,
			["같은 gallery 갱신 계보"],
			minGroupSize,
			minConfidence,
		);
	}

	for (const [exactKey, exactFiles] of exactGroups.entries()) {
		const metadataAgreement = getGroupMetadataAgreement(exactFiles);
		const contentReasons = getDuplicatedContentReasons(exactFiles);
		const hasSeriesDifference = hasDifferentTokens(exactFiles, "seriesTokens");
		const hasEditionDifference = hasDifferentTokens(
			exactFiles,
			"editionTokens",
		);
		const hasContentEvidence = contentReasons.length > 0;
		if (!hasContentEvidence && !hasSeriesDifference && !hasEditionDifference) {
			continue;
		}

		const baseConfidence = hasContentEvidence
			? contentReasons.includes("페이지 수 우세")
				? 98
				: 96
			: hasSeriesDifference
				? 96
				: hasEditionDifference
					? 94
					: 90;
		const confidence = Math.min(99, baseConfidence + metadataAgreement.boost);
		addGroupCandidate(
			groups,
			seenSignatures,
			exactFiles,
			"exact",
			exactKey,
			confidence,
			[
				"같은 작가/분류/기준 제목",
				...metadataAgreement.reasons,
				...contentReasons,
			],
			minGroupSize,
			minConfidence,
		);
	}

	for (const [bucketKey, titlesByBucket] of fuzzyBuckets.entries()) {
		const blockBuckets = new Map<
			string,
			Array<[string, SimilarGroupIndexedFile[]]>
		>();

		for (const entry of titlesByBucket.entries()) {
			const [baseTitle] = entry;
			if (baseTitle.length < FUZZY_MIN_BASE_TITLE_LENGTH) {
				continue;
			}

			for (const blockKey of getFuzzyBlockKeys(baseTitle)) {
				const entries = blockBuckets.get(blockKey) ?? [];
				entries.push(entry);
				blockBuckets.set(blockKey, entries);
			}
		}

		const seenTitlePairs = new Set<string>();
		for (const entries of blockBuckets.values()) {
			for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
				const [leftTitle, leftFiles] = entries[leftIndex];

				for (
					let rightIndex = leftIndex + 1;
					rightIndex < entries.length;
					rightIndex += 1
				) {
					const [rightTitle, rightFiles] = entries[rightIndex];
					const pairKey =
						leftTitle < rightTitle
							? `${leftTitle}\n${rightTitle}`
							: `${rightTitle}\n${leftTitle}`;
					if (seenTitlePairs.has(pairKey)) {
						continue;
					}
					seenTitlePairs.add(pairKey);

					const score = getTitleSimilarityScore(leftTitle, rightTitle);
					if (!isStrongFuzzyTitleMatch(score)) {
						continue;
					}

					const fuzzyFiles = [...leftFiles, ...rightFiles];
					const metadataAgreement = getGroupMetadataAgreement(fuzzyFiles);
					addGroupCandidate(
						groups,
						seenSignatures,
						fuzzyFiles,
						"fuzzy",
						`${bucketKey}:${leftTitle}:${rightTitle}`,
						Math.min(
							99,
							getFuzzyTitleConfidence(score) + metadataAgreement.boost,
						),
						["제목 고유사도", ...metadataAgreement.reasons, ...score.reasons],
						minGroupSize,
						minConfidence,
					);
				}
			}
		}
	}

	for (const file of filteredFiles) {
		let bestMatch:
			| {
					group: GroupFolderSummary;
					confidence: number;
					reasons: string[];
					requiresReview?: boolean;
			  }
			| undefined;

		for (const group of groupSummaries) {
			const score = scoreGroupMergeCandidate(file, group);
			if (!score) {
				continue;
			}
			const groupIssueReasons = group.reviewIssues.map(
				(issue) => issue.message,
			);

			if (!bestMatch || score.confidence > bestMatch.confidence) {
				bestMatch = {
					group,
					confidence: score.confidence,
					reasons: [...score.reasons, ...groupIssueReasons],
					requiresReview:
						Boolean(score.requiresReview) || groupIssueReasons.length > 0,
				};
			}
		}

		if (!bestMatch || bestMatch.confidence < 90) {
			continue;
		}

		const fileForGroup = bestMatch.requiresReview
			? {
					...file,
					reviewIssues: [
						...(file.reviewIssues ?? []),
						{
							filePath: file.path,
							kind: "metadata-conflict" as const,
							message: `${bestMatch.reasons.join(", ")} 관계는 직접 검토해야 합니다.`,
							blockedGroupPath: bestMatch.group.groupPath,
						},
					],
				}
			: file;
		addGroupCandidate(
			groups,
			seenSignatures,
			[fileForGroup],
			"merge",
			`${file.path}:${bestMatch.group.groupPath}`,
			bestMatch.confidence,
			["기존 그룹 편입 후보", ...bestMatch.reasons],
			1,
			minConfidence,
			bestMatch.group,
		);
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

const createQueueCounts = (): Record<SimilarGroupQueue, number> => ({
	safe: 0,
	cleanup: 0,
	series: 0,
	merge: 0,
	suspicious: 0,
});

const getSimilarGroupReviewStatePath = (): string =>
	path.join(app.getPath("userData"), "similar-group-review-state.json");

const getReviewStateRecordKey = (
	reviewKey: string,
	contentSignature: string,
): string => `${reviewKey}::${contentSignature}`;

const loadSimilarGroupReviewState =
	async (): Promise<SimilarGroupReviewState> => {
		try {
			const statePath = getSimilarGroupReviewStatePath();
			const exists = await pathExists(statePath);
			if (!exists) {
				return { records: {} };
			}

			const data = await fs.promises.readFile(statePath, "utf8");
			const parsedState = JSON.parse(data) as Partial<SimilarGroupReviewState>;
			return {
				records: parsedState.records ?? {},
			};
		} catch (error) {
			console.warn("유사 그룹 검토 상태를 불러오지 못했습니다:", error);
			return { records: {} };
		}
	};

const saveSimilarGroupReviewState = async (
	state: SimilarGroupReviewState,
): Promise<void> => {
	const statePath = getSimilarGroupReviewStatePath();
	await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
	await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2));
};

export const markSimilarGroupReviewState = async (
	input: SimilarGroupReviewStateInput,
): Promise<boolean> => {
	const state = await loadSimilarGroupReviewState();
	state.records[
		getReviewStateRecordKey(input.reviewKey, input.contentSignature)
	] = {
		reviewKey: input.reviewKey,
		contentSignature: input.contentSignature,
		status: input.status,
		updatedAt: Date.now(),
	};
	await saveSimilarGroupReviewState(state);
	return true;
};

export const clearSimilarGroupReviewState = async (
	reviewKey: string,
	contentSignature?: string,
): Promise<boolean> => {
	const state = await loadSimilarGroupReviewState();

	for (const [recordKey, record] of Object.entries(state.records)) {
		if (
			record.reviewKey === reviewKey &&
			(!contentSignature || record.contentSignature === contentSignature)
		) {
			delete state.records[recordKey];
		}
	}

	await saveSimilarGroupReviewState(state);
	return true;
};

const filterSimilarGroupsForOptions = (
	groups: SimilarGroup[],
	options: SimilarGroupOptions,
	reviewState: SimilarGroupReviewState,
): {
	groups: SimilarGroup[];
	countsByQueue: Record<SimilarGroupQueue, number>;
	hiddenReviewedCount: number;
	hiddenSuspiciousCount: number;
} => {
	const requestedQueue = options.queue ?? "cleanup";
	const includeReviewed = Boolean(options.includeReviewed);
	const includeSuspicious =
		Boolean(options.includeSuspicious) || requestedQueue === "suspicious";
	const countsByQueue = createQueueCounts();
	let hiddenReviewedCount = 0;
	let hiddenSuspiciousCount = 0;
	const visibleGroups: SimilarGroup[] = [];

	for (const group of groups) {
		countsByQueue[group.queue] += 1;

		const reviewRecord =
			reviewState.records[
				getReviewStateRecordKey(group.reviewKey, group.contentSignature)
			];
		if (reviewRecord && !includeReviewed) {
			hiddenReviewedCount += 1;
			continue;
		}

		if (group.queue === "suspicious" && !includeSuspicious) {
			hiddenSuspiciousCount += 1;
			continue;
		}

		const matchesQueue =
			requestedQueue === "safe"
				? group.queue === "cleanup" || group.queue === "series"
				: group.queue === requestedQueue;
		if (!matchesQueue) {
			continue;
		}

		visibleGroups.push({
			...group,
			reviewStatus: reviewRecord?.status,
		});
	}

	return {
		groups: visibleGroups,
		countsByQueue,
		hiddenReviewedCount,
		hiddenSuspiciousCount,
	};
};

export const findSimilarGroups = async (
	options: SimilarGroupOptions,
	onProgress?: ScanProgressCallback,
	resolveMetadata?: GalleryMetadataResolver,
): Promise<SimilarGroupResult> => {
	const sourcePath = options.sourcePath.trim();

	if (!sourcePath) {
		throw new Error("저장소 경로가 지정되지 않았습니다.");
	}

	await ensurePathExists(
		sourcePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const contentScanMode = getSimilarGroupContentScanMode(options);
	const cacheKey = getSimilarGroupCacheKey(
		sourcePath,
		options.recursive,
		contentScanMode,
	);
	let indexEntry = options.forceRefresh
		? undefined
		: similarGroupIndexCache.get(cacheKey);
	let cacheSource: "memory" | "disk" | undefined = indexEntry
		? "memory"
		: undefined;

	if (!indexEntry && !options.forceRefresh) {
		indexEntry = await getSimilarGroupDiskIndexCacheEntry(cacheKey);
		if (indexEntry) {
			cacheSource = "disk";
		}
	}

	const cacheUsed = Boolean(indexEntry);

	if (!indexEntry) {
		indexEntry = await buildSimilarGroupIndex(
			sourcePath,
			options.recursive,
			contentScanMode,
			Boolean(options.forceRefresh),
			onProgress,
		);
	}

	if (!indexEntry) {
		throw new Error("유사 그룹 인덱스를 생성하지 못했습니다.");
	}

	if (cacheUsed) {
		setSimilarGroupCacheEntry(cacheKey, indexEntry);
		onProgress?.({
			phase: "complete",
			processed: indexEntry.files.length,
			total: indexEntry.files.length,
			foundFiles: indexEntry.files.length,
			currentPath: sourcePath,
			currentFileName:
				cacheSource === "disk" ? "디스크 인덱스 캐시 사용" : "인덱스 캐시 사용",
		});
	} else {
		setSimilarGroupCacheEntry(cacheKey, indexEntry);
		await setSimilarGroupDiskIndexCacheEntry(
			cacheKey,
			indexEntry,
			contentScanMode,
		);
	}

	const hydratedFiles = hydrateSimilarGroupFilesWithMetadata(
		indexEntry.files,
		resolveMetadata,
	);
	const groupSummaries = await buildGroupFolderSummaries(
		sourcePath,
		contentScanMode === "off" ? "off" : "metadata",
		Boolean(options.forceRefresh),
		resolveMetadata,
	);
	const allGroups = findSimilarGroupsFromIndex(
		hydratedFiles,
		options,
		groupSummaries,
	);
	const reviewState = await loadSimilarGroupReviewState();
	const filteredResult = filterSimilarGroupsForOptions(
		allGroups,
		options,
		reviewState,
	);

	return {
		groups: filteredResult.groups,
		sourcePath: indexEntry.sourcePath,
		scannedCount: indexEntry.files.length,
		groupedFileCount: filteredResult.groups.reduce(
			(total, group) => total + group.files.length,
			0,
		),
		cacheUsed,
		indexedAt: indexEntry.indexedAt,
		countsByQueue: filteredResult.countsByQueue,
		hiddenReviewedCount: filteredResult.hiddenReviewedCount,
		hiddenSuspiciousCount: filteredResult.hiddenSuspiciousCount,
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

const collectGroupDirectoryPaths = async (
	groupRootPath: string,
): Promise<string[]> => {
	const groupPaths: string[] = [];
	const directories = [groupRootPath];

	while (directories.length > 0) {
		const currentPath = directories.pop();
		if (!currentPath) {
			continue;
		}

		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
		} catch {
			continue;
		}

		const directArchiveCount = entries.filter(
			(entry) => entry.isFile() && isArchiveFile(entry.name),
		).length;
		if (currentPath !== groupRootPath && directArchiveCount > 0) {
			groupPaths.push(currentPath);
			continue;
		}

		for (const entry of entries) {
			if (entry.isDirectory()) {
				directories.push(path.join(currentPath, entry.name));
			}
		}
	}

	return groupPaths;
};

const getSingleValue = (values: string[]): string | undefined => {
	const normalizedValues = new Map<string, string>();
	for (const value of values) {
		const normalizedValue = normalizeArchiveText(value);
		if (normalizedValue) {
			normalizedValues.set(normalizedValue, value);
		}
	}

	return normalizedValues.size === 1
		? normalizedValues.values().next().value
		: undefined;
};

const parseLegacyGroupFolderName = (
	groupName: string,
): { artist?: string; title?: string } => {
	const separatorIndex = groupName.indexOf(" - ");
	if (separatorIndex < 0) {
		return { title: groupName };
	}

	return {
		artist: groupName.slice(0, separatorIndex).trim() || undefined,
		title: groupName.slice(separatorIndex + 3).trim() || undefined,
	};
};

const getShortestNonEmpty = (values: string[]): string | undefined =>
	values
		.map((value) => value.trim())
		.filter(Boolean)
		.sort((left, right) => left.length - right.length)[0];

const inferLegacyGroupFolderSegments = (
	groupName: string,
	files: SimilarGroupIndexedFile[],
): SimilarGroupFolderSegments => {
	const folderNameParts = parseLegacyGroupFolderName(groupName);
	const artist =
		getSingleValue(files.map((file) => file.artist ?? "")) ??
		folderNameParts.artist;
	const origin = getSingleValue(files.map((file) => file.category ?? ""));
	const title =
		getShortestNonEmpty(files.map((file) => file.title)) ??
		folderNameParts.title;

	return {
		type: UNKNOWN_TYPE_SEGMENT,
		origin: sanitizePathSegment(origin, UNKNOWN_ORIGIN_SEGMENT),
		artist: sanitizePathSegment(artist, UNKNOWN_ARTIST_SEGMENT),
		title: sanitizePathSegment(title, UNKNOWN_TITLE_SEGMENT),
	};
};

const getFolderSegmentsFromGroupPath = (
	groupRootPath: string,
	groupPath: string,
	files: SimilarGroupIndexedFile[],
): SimilarGroupFolderSegments => {
	const relativeParts = path
		.relative(groupRootPath, groupPath)
		.split(path.sep)
		.filter(Boolean);

	if (relativeParts.length >= 4) {
		return {
			type: sanitizePathSegment(relativeParts[0], UNKNOWN_TYPE_SEGMENT),
			origin: sanitizePathSegment(relativeParts[1], UNKNOWN_ORIGIN_SEGMENT),
			artist: sanitizePathSegment(relativeParts[2], UNKNOWN_ARTIST_SEGMENT),
			title: sanitizePathSegment(
				relativeParts.slice(3).join(" "),
				UNKNOWN_TITLE_SEGMENT,
			),
		};
	}

	return inferLegacyGroupFolderSegments(path.basename(groupPath), files);
};

const buildGroupFolderSummaries = async (
	storePath: string,
	contentScanMode: ArchiveContentScanMode = "off",
	forceContentRefresh = false,
	resolveMetadata?: GalleryMetadataResolver,
): Promise<GroupFolderSummary[]> => {
	const groupRootPath = path.join(storePath, "_grouped");
	if (!(await pathExists(groupRootPath))) {
		return [];
	}

	const groupPaths = await collectGroupDirectoryPaths(groupRootPath);
	const summaries: GroupFolderSummary[] = [];
	const archivePathsByGroup = new Map<string, string[]>();
	const allGalleryIds: string[] = [];

	for (const groupPath of groupPaths) {
		const archivePaths = await collectArchiveFilesInDirectory(groupPath);
		archivePathsByGroup.set(groupPath, archivePaths);
		for (const filePath of archivePaths) {
			const galleryId = parseArchiveFileName(path.basename(filePath)).code;
			if (galleryId) allGalleryIds.push(galleryId);
		}
	}
	const metadataByGalleryId = resolveMetadata?.(allGalleryIds) ?? {};

	for (const groupPath of groupPaths) {
		const archivePaths = archivePathsByGroup.get(groupPath) ?? [];
		if (archivePaths.length === 0) {
			continue;
		}

		const relativeGroupParts = getRelativePathParts(
			path.relative(groupRootPath, groupPath),
		);
		const pathFallback =
			relativeGroupParts.length >= 4
				? {
						type: relativeGroupParts[0],
						origin: relativeGroupParts[1],
					}
				: undefined;
		const files = await Promise.all(
			archivePaths.map((filePath) =>
				buildSimilarGroupFile(
					groupRootPath,
					filePath,
					path.basename(filePath),
					contentScanMode,
					forceContentRefresh,
					metadataByGalleryId[
						parseArchiveFileName(path.basename(filePath)).code ?? ""
					],
					pathFallback,
				),
			),
		);

		summaries.push({
			groupName: path.relative(groupRootPath, groupPath),
			groupPath,
			folderSegments: getFolderSegmentsFromGroupPath(
				groupRootPath,
				groupPath,
				files,
			),
			files,
			codes: new Set(
				files.map((file) => file.code).filter((code): code is string => !!code),
			),
			artists: new Set(
				files.flatMap((file) => file.normalizedArtists).filter(Boolean),
			),
			groups: new Set(files.flatMap((file) => file.normalizedGroups)),
			parodies: new Set(
				files.flatMap((file) =>
					file.organizationMetadata.parodies.map(normalizeOrganizationOrigin),
				),
			),
			categories: new Set(
				files
					.map((file) => file.organizationMetadata.category)
					.filter((value): value is string => Boolean(value))
					.map(normalizeOrganizationCategory)
					.filter(Boolean),
			),
			lineageGalleryIds: new Set(
				files.flatMap((file) => file.organizationMetadata.lineageGalleryIds),
			),
			baseTitles: new Set(
				files
					.map((file) => file.normalizedBaseTitle)
					.filter((title) => title.length > 0),
			),
			contentFingerprints: new Set(
				files
					.map((file) => file.content?.contentFingerprint)
					.filter((signature): signature is string => !!signature),
			),
			sampleHashes: new Set(
				files.flatMap((file) => file.content?.sampleHashes ?? []),
			),
			crcWindowSignatures: new Set(
				files
					.map((file) => file.content?.crcWindowSignature)
					.filter((signature): signature is string => !!signature),
			),
			sampleFiles: files.slice(0, 3).map((file) => file.name),
			reviewIssues: files.flatMap((file) => file.reviewIssues ?? []),
		});
	}

	await flushArchiveContentCache();

	return summaries;
};

const scoreGroupMergeCandidate = (
	file: SimilarGroupIndexedFile,
	group: GroupFolderSummary,
): {
	confidence: number;
	reasons: string[];
	requiresReview?: boolean;
} | null => {
	const artistMatches = file.normalizedArtists.some((artist) =>
		group.artists.has(artist),
	);
	const metadataCompatibility = evaluateOrganizationMetadataCompatibility({
		leftGroups: file.organizationMetadata.groups,
		rightGroups: [...group.groups],
		leftParodies: file.organizationMetadata.parodies,
		rightParodies: [...group.parodies],
		leftCategory: file.organizationMetadata.category,
		rightCategories: [...group.categories],
	});
	const groupMatches = metadataCompatibility.reasons.includes("원천 그룹 일치");
	const metadataReasons = metadataCompatibility.reasons;
	const withMetadataBoost = (confidence: number): number =>
		Math.min(99, confidence + metadataCompatibility.boost);
	const galleryRelation = getOrganizationGalleryRelation(
		file.organizationMetadata,
		group.codes,
		group.lineageGalleryIds,
	);

	if (galleryRelation === "exact") {
		return {
			confidence: 100,
			reasons: ["같은 gallery id", ...metadataReasons],
			requiresReview: metadataCompatibility.hasMismatch,
		};
	}

	if (
		file.content?.contentFingerprint &&
		group.contentFingerprints.has(file.content.contentFingerprint)
	) {
		return {
			confidence: 100,
			reasons: ["압축 내용 동일", ...metadataReasons],
			requiresReview: metadataCompatibility.hasMismatch,
		};
	}

	if (galleryRelation === "lineage") {
		return {
			confidence: 99,
			reasons: ["같은 gallery 갱신 계보", ...metadataReasons],
			requiresReview: true,
		};
	}

	if (metadataCompatibility.hasMismatch) return null;

	if (
		file.content?.sampleHashes?.some((sampleHash) =>
			group.sampleHashes.has(sampleHash),
		)
	) {
		return {
			confidence: withMetadataBoost(98),
			reasons: ["샘플 이미지 일치", ...metadataReasons],
		};
	}

	if (
		file.content?.crcWindowSignature &&
		group.crcWindowSignatures.has(file.content.crcWindowSignature)
	) {
		return {
			confidence: withMetadataBoost(96),
			reasons: ["내용 일부 중복", ...metadataReasons],
		};
	}

	if (!artistMatches && !groupMatches) {
		return null;
	}
	const actorReason = groupMatches ? "같은 원천 그룹" : "같은 작가";

	if (
		file.normalizedBaseTitle &&
		group.baseTitles.has(file.normalizedBaseTitle)
	) {
		return {
			confidence: withMetadataBoost(96),
			reasons: [actorReason, "같은 기준 제목", ...metadataReasons],
		};
	}

	if (file.normalizedBaseTitle.length < 8) {
		return null;
	}

	let bestScore: TitleSimilarityScore | null = null;
	for (const groupTitle of group.baseTitles) {
		if (groupTitle.length < 8) {
			continue;
		}

		const score = getTitleSimilarityScore(file.normalizedBaseTitle, groupTitle);
		if (!bestScore || score.value > bestScore.value) {
			bestScore = score;
		}
	}

	if (!bestScore || !isStrongMergeTitleMatch(bestScore)) {
		return null;
	}

	return {
		confidence: withMetadataBoost(getMergeTitleConfidence(bestScore)),
		reasons: [
			actorReason,
			"제목 고유사도",
			...metadataReasons,
			...bestScore.reasons,
		],
	};
};

export const findGroupMergeCandidates = async (
	fileList: GroupMergeSourceFile[],
	scanPath: string,
	storePath: string,
	resolveMetadata?: GalleryMetadataResolver,
): Promise<GroupMergeCandidateResult> => {
	if (!storePath) {
		return { candidates: [], issues: [] };
	}

	const resolvedScanPath = path.resolve(scanPath);
	const resolvedStorePath = path.resolve(storePath);
	await ensurePathExists(
		resolvedStorePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const groupSummaries = await buildGroupFolderSummaries(
		resolvedStorePath,
		"metadata",
		false,
		resolveMetadata,
	);
	if (groupSummaries.length === 0) {
		return { candidates: [], issues: [] };
	}

	const candidates: GroupMergeCandidate[] = [];
	const issues: OrganizationReviewIssue[] = [];

	const hydratedFileList = hydrateOrganizerSourceFiles(
		fileList,
		resolveMetadata,
	);
	for (const file of hydratedFileList) {
		if (!(await pathExists(file.path))) {
			continue;
		}

		const indexedFile = await buildSimilarGroupFile(
			resolvedScanPath,
			file.path,
			file.name,
			"metadata",
			false,
			file.sourceMetadata,
		);
		const hasFileConflict = Boolean(indexedFile.reviewIssues?.length);
		if (indexedFile.reviewIssues?.length) {
			issues.push(...indexedFile.reviewIssues);
		}
		let bestCandidate: GroupMergeCandidate | null = null;

		for (const group of groupSummaries) {
			const score = scoreGroupMergeCandidate(indexedFile, group);
			if (!score) {
				continue;
			}
			const groupIssueReasons = group.reviewIssues.map(
				(issue) => issue.message,
			);
			if (
				hasFileConflict ||
				score.requiresReview ||
				groupIssueReasons.length > 0
			) {
				issues.push({
					filePath: file.path,
					kind: "metadata-conflict",
					message: `${[...score.reasons, ...groupIssueReasons].join(", ")} 관계가 있지만 자동 그룹 편입은 차단했습니다.`,
					blockedGroupPath: group.groupPath,
				});
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

	await flushArchiveContentCache();

	return {
		candidates: candidates.sort(
			(left, right) => right.confidence - left.confidence,
		),
		issues,
	};
};

type FavoriteArtistFolderMatch = Pick<
	FavoriteArtistCandidate,
	"artistFolderName" | "targetDirectory" | "relativeTargetDirectory"
>;

const buildFavoriteArtistFolderIndex = async (
	favoriteArtistPath: string,
): Promise<Map<string, FavoriteArtistFolderMatch | null>> => {
	const favoriteArtistRootPath = path.resolve(favoriteArtistPath);
	if (!(await pathExists(favoriteArtistRootPath))) {
		return new Map();
	}

	const rootStats = await fs.promises.stat(favoriteArtistRootPath);
	if (!rootStats.isDirectory()) {
		return new Map();
	}

	const foldersByArtist = new Map<string, FavoriteArtistFolderMatch | null>();
	const entries = await fs.promises.readdir(favoriteArtistRootPath, {
		withFileTypes: true,
	});

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const normalizedFolderName = normalizeArchiveText(entry.name);
		if (!normalizedFolderName) {
			continue;
		}

		const targetDirectory = path.join(favoriteArtistRootPath, entry.name);
		const folderMatch: FavoriteArtistFolderMatch = {
			artistFolderName: entry.name,
			targetDirectory,
			relativeTargetDirectory: path.join(
				path.basename(favoriteArtistRootPath),
				entry.name,
			),
		};

		foldersByArtist.set(
			normalizedFolderName,
			foldersByArtist.has(normalizedFolderName) ? null : folderMatch,
		);
	}

	return foldersByArtist;
};

export const findFavoriteArtistCandidates = async (
	fileList: GroupMergeSourceFile[],
	favoriteArtistPath: string,
	resolveMetadata?: GalleryMetadataResolver,
): Promise<FavoriteArtistCandidateResult> => {
	if (!favoriteArtistPath) {
		return { candidates: [], issues: [] };
	}

	const folderIndex = await buildFavoriteArtistFolderIndex(favoriteArtistPath);
	if (folderIndex.size === 0) {
		return { candidates: [], issues: [] };
	}

	const candidates: FavoriteArtistCandidate[] = [];
	const issues: OrganizationReviewIssue[] = [];

	const hydratedFileList = hydrateOrganizerSourceFiles(
		fileList,
		resolveMetadata,
	);
	for (const file of hydratedFileList) {
		if (!(await pathExists(file.path))) {
			continue;
		}

		const parsedName = parseArchiveFileName(file.name);
		const fallback = {
			galleryId: parsedName.code,
			artist: file.artist?.trim() || parsedName.artist,
			type: file.type,
			origin: file.origin,
		};
		const conflicts = findOrganizationMetadataConflicts(
			file.path,
			fallback,
			file.sourceMetadata,
		);
		if (conflicts.length > 0) {
			issues.push(...conflicts);
			continue;
		}
		const metadata = buildOrganizationMetadataEvidence(
			fallback,
			file.sourceMetadata,
		);
		const targetResolution = resolveFavoriteArtistTargets(
			metadata.effectiveArtists,
			folderIndex,
		);

		if (targetResolution.status === "ambiguous") {
			issues.push({
				filePath: file.path,
				kind: "favorite-target-ambiguous",
				message:
					"일치하는 Favorite Artist 대상 폴더가 하나로 확정되지 않습니다.",
				sourceValues: metadata.effectiveArtists,
				candidatePaths: targetResolution.matches.map(
					(match) => match.target.targetDirectory,
				),
			});
			continue;
		}

		const folderMatch = targetResolution.matches[0];
		if (!folderMatch || targetResolution.status !== "matched") {
			continue;
		}

		candidates.push({
			filePath: file.path,
			fileName: file.name,
			artist: folderMatch.matchedArtists.join(", "),
			matchedArtists: folderMatch.matchedArtists,
			metadataSource: metadata.artistSource,
			...folderMatch.target,
		});
	}

	return {
		candidates: candidates.sort((left, right) =>
			left.fileName.localeCompare(right.fileName),
		),
		issues,
	};
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

const getAvailableDirectoryPath = async (
	targetPath: string,
): Promise<string> => {
	let counter = 1;
	let nextPath = targetPath;

	while (await pathExists(nextPath)) {
		nextPath = `${targetPath}_${counter}`;
		counter += 1;
	}

	return nextPath;
};

const isHierarchicalGroupedRoot = (directoryName: string): boolean => {
	const normalizedName = directoryName.toLowerCase();
	return (
		normalizedName.startsWith("_") ||
		HIERARCHICAL_GROUP_ROOTS.has(normalizedName)
	);
};

const hasDirectArchiveFiles = async (
	directoryPath: string,
): Promise<boolean> => {
	const entries = await fs.promises.readdir(directoryPath, {
		withFileTypes: true,
	});
	return entries.some((entry) => entry.isFile() && isArchiveFile(entry.name));
};

const collectFlatGroupedFolderPaths = async (
	groupRootPath: string,
): Promise<string[]> => {
	const entries = await fs.promises.readdir(groupRootPath, {
		withFileTypes: true,
	});
	const groupPaths: string[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() || isHierarchicalGroupedRoot(entry.name)) {
			continue;
		}

		const groupPath = path.join(groupRootPath, entry.name);
		if (!(await hasDirectArchiveFiles(groupPath))) {
			continue;
		}

		const archivePaths = await collectArchiveFilesInDirectory(groupPath);
		if (archivePaths.length > 0) {
			groupPaths.push(groupPath);
		}
	}

	return groupPaths;
};

const createMigrationItem = async (
	groupRootPath: string,
	groupPath: string,
): Promise<GroupedFolderMigrationPreview["items"][number] | null> => {
	const archivePaths = await collectArchiveFilesInDirectory(groupPath);
	if (archivePaths.length === 0) {
		return null;
	}

	const files = await Promise.all(
		archivePaths.map((filePath) =>
			buildSimilarGroupFile(
				groupPath,
				filePath,
				path.basename(filePath),
				"off",
			),
		),
	);
	const folderSegments = inferLegacyGroupFolderSegments(
		path.basename(groupPath),
		files,
	);
	const baseTargetPath = path.join(
		groupRootPath,
		folderSegments.type,
		folderSegments.origin,
		folderSegments.artist,
		folderSegments.title,
	);
	const targetExists = await pathExists(baseTargetPath);
	const targetPath = await getAvailableDirectoryPath(baseTargetPath);

	return {
		sourcePath: groupPath,
		targetPath,
		relativeSourcePath: path.relative(groupRootPath, groupPath),
		relativeTargetPath: path.relative(groupRootPath, targetPath),
		folderSegments,
		fileCount: archivePaths.length,
		targetExists,
	};
};

export const previewGroupedFolderMigration = async (
	sourcePath: string,
): Promise<GroupedFolderMigrationPreview> => {
	const resolvedSourcePath = path.resolve(sourcePath);
	await ensurePathExists(
		resolvedSourcePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const groupRootPath = path.join(resolvedSourcePath, "_grouped");
	if (!(await pathExists(groupRootPath))) {
		return {
			sourcePath: resolvedSourcePath,
			groupRootPath,
			items: [],
			skippedCount: 0,
			totalFiles: 0,
		};
	}

	const flatGroupPaths = await collectFlatGroupedFolderPaths(groupRootPath);
	const items: GroupedFolderMigrationPreview["items"] = [];
	let skippedCount = 0;

	for (const groupPath of flatGroupPaths) {
		const item = await createMigrationItem(groupRootPath, groupPath);
		if (item) {
			items.push(item);
		} else {
			skippedCount += 1;
		}
	}

	return {
		sourcePath: resolvedSourcePath,
		groupRootPath,
		items,
		skippedCount,
		totalFiles: items.reduce((sum, item) => sum + item.fileCount, 0),
	};
};

export const executeGroupedFolderMigration = async (
	sourcePath: string,
): Promise<GroupedFolderMigrationResult> => {
	const preview = await previewGroupedFolderMigration(sourcePath);
	const results: GroupedFolderMigrationResult["results"] = [];

	for (const item of preview.items) {
		try {
			await ensurePathExists(item.sourcePath, "기존 그룹 폴더가 없습니다.");
			const targetPath = await getAvailableDirectoryPath(item.targetPath);
			await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.promises.rename(item.sourcePath, targetPath);
			await invalidateOrganizerCachesForMove(item.sourcePath, targetPath);
			results.push({
				sourcePath: item.sourcePath,
				targetPath,
				success: true,
			});
		} catch (error) {
			results.push({
				sourcePath: item.sourcePath,
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

export const trashFilesToRecycleBin = async (
	filePaths: string[],
): Promise<GroupOperationResult> => {
	const results: GroupOperationResult["results"] = [];

	for (const filePath of filePaths) {
		try {
			await ensurePathExists(filePath, "파일이 존재하지 않습니다.");
			await shell.trashItem(filePath);
			await removeFileFromOrganizerCaches(filePath);
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
	folderSegments?: SimilarGroupFolderSegments,
): Promise<GroupOperationResult> => {
	const resolvedSourcePath = path.resolve(sourcePath);
	await ensurePathExists(
		resolvedSourcePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const fallbackNameParts = parseLegacyGroupFolderName(groupName);
	const resolvedFolderSegments =
		folderSegments ??
		({
			type: UNKNOWN_TYPE_SEGMENT,
			origin: UNKNOWN_ORIGIN_SEGMENT,
			artist: sanitizePathSegment(
				fallbackNameParts.artist,
				UNKNOWN_ARTIST_SEGMENT,
			),
			title: sanitizePathSegment(
				fallbackNameParts.title,
				UNKNOWN_TITLE_SEGMENT,
			),
		} satisfies SimilarGroupFolderSegments);
	const groupFolderPath = await createNumberedDirectory(
		getGroupTargetPath(resolvedSourcePath, resolvedFolderSegments),
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

export const mergeFilesToExistingGroup = async (
	sourcePath: string,
	filePaths: string[],
	targetGroupPath: string,
): Promise<GroupOperationResult> => {
	const resolvedSourcePath = path.resolve(sourcePath);
	const resolvedTargetGroupPath = path.resolve(targetGroupPath);
	await ensurePathExists(
		resolvedSourcePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);
	await ensurePathExists(
		resolvedTargetGroupPath,
		"편입 대상 그룹 폴더가 존재하지 않습니다.",
	);

	const groupRootPath = path.join(resolvedSourcePath, "_grouped");
	if (!isPathInside(groupRootPath, resolvedTargetGroupPath)) {
		throw new Error("저장소 그룹 폴더 밖으로는 편입할 수 없습니다.");
	}

	const results: GroupOperationResult["results"] = [];

	for (const filePath of filePaths) {
		try {
			if (!isPathInside(resolvedSourcePath, filePath)) {
				throw new Error("저장소 밖의 파일은 기존 그룹으로 편입할 수 없습니다.");
			}

			await ensurePathExists(filePath, "파일이 존재하지 않습니다.");
			const targetPath = await createNumberedPath(
				path.join(resolvedTargetGroupPath, path.basename(filePath)),
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
	await removeFileFromOrganizerCaches(filePath);

	return { success: true, message: "파일이 성공적으로 삭제되었습니다." };
};

export const checkDuplicateFiles = async (
	fileList: FileEntry[],
	scanPath: string,
	storePath: string,
	resolveMetadata?: GalleryMetadataResolver,
): Promise<DuplicateCheckResult> => {
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
	const issues: OrganizationReviewIssue[] = [];
	const storeFiles = (await scanArchiveFiles(storePath)).files;
	const storeFilesByGalleryId = new Map<string, FileEntry[]>();
	for (const storeFile of storeFiles) {
		const galleryId = parseArchiveFileName(storeFile.name).code;
		if (!galleryId) continue;
		const matches = storeFilesByGalleryId.get(galleryId) ?? [];
		matches.push(storeFile);
		storeFilesByGalleryId.set(galleryId, matches);
	}

	const hydratedFileList = hydrateOrganizerSourceFiles(
		fileList,
		resolveMetadata,
	);
	for (const file of hydratedFileList) {
		const relativePath = path.relative(scanPath, file.path);
		const targetPath = path.join(storePath, relativePath);
		const parsedName = parseArchiveFileName(file.name);
		const relativeParts = getRelativePathParts(relativePath);
		issues.push(
			...findOrganizationMetadataConflicts(
				file.path,
				{
					galleryId: parsedName.code,
					artist: file.artist ?? parsedName.artist,
					type:
						file.type ??
						(relativeParts.length >= 2 ? relativeParts[0] : undefined),
					origin:
						file.origin ??
						(relativeParts.length >= 3 ? relativeParts[1] : undefined),
				},
				file.sourceMetadata,
			),
		);
		const exactTargetExists =
			!isSamePath(targetPath, file.path) && (await pathExists(targetPath));
		const galleryMatches = parsedName.code
			? (storeFilesByGalleryId.get(parsedName.code) ?? []).filter(
					(storeFile) => !isSamePath(storeFile.path, file.path),
				)
			: [];

		const targetResolution = resolveDuplicateTarget({
			galleryId: parsedName.code,
			galleryTargetPaths: galleryMatches.map((item) => item.path),
			exactTargetPath: targetPath,
			exactTargetExists,
			isSamePath,
		});
		if (targetResolution.status === "ambiguous") {
			issues.push({
				filePath: file.path,
				kind: "duplicate-target-ambiguous",
				message:
					targetResolution.message ?? "중복 대상을 하나로 확정하지 못했습니다.",
				candidatePaths: targetResolution.candidatePaths,
			});
			continue;
		}
		if (
			targetResolution.status !== "matched" ||
			!targetResolution.targetPath ||
			!targetResolution.matchKind
		) {
			continue;
		}
		const duplicateTargetPath = targetResolution.targetPath;
		const matchKind = targetResolution.matchKind;

		try {
			const targetStats = await fs.promises.stat(duplicateTargetPath);
			duplicates.push({
				sourceFile: file.name,
				sourcePath: file.path,
				sourceSize: file.size,
				targetPath: duplicateTargetPath,
				targetSize: targetStats.size,
				relativePath,
				galleryId: parsedName.code,
				matchKind,
			});
		} catch (error) {
			console.warn(`기존 파일 정보 읽기 실패: ${duplicateTargetPath}`, error);
			duplicates.push({
				sourceFile: file.name,
				sourcePath: file.path,
				sourceSize: file.size,
				targetPath: duplicateTargetPath,
				targetSize: -1,
				relativePath,
				galleryId: parsedName.code,
				matchKind,
			});
		}
	}

	return {
		hasDuplicates: duplicates.length > 0,
		duplicates,
		issues,
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
						sourcePath: file.path,
						relativePath,
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
						sourcePath: file.path,
						relativePath,
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
						sourcePath: file.path,
						relativePath,
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
					sourcePath: file.path,
					relativePath,
					success: true,
					action: "이름 변경",
					targetPath: path.relative(storePath, renamedTargetPath),
				});
				continue;
			}

			await moveFileWithFallback(file.path, targetPath);
			results.push({
				file: file.name,
				sourcePath: file.path,
				relativePath,
				success: true,
				action: isGroupMerge ? "그룹 편입" : "이동",
				targetPath: path.relative(storePath, targetPath),
			});
		} catch (error) {
			console.error(`파일 이동 실패: ${file.name}`, error);
			results.push({
				file: file.name,
				sourcePath: file.path,
				relativePath: path.relative(scanPath, file.path),
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
	await invalidateOrganizerCachesContainingPath(targetPath);

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

export const moveFileToFavorite = async (
	filePath: string,
	keepPath: string,
): Promise<FileMutationResult> => {
	if (!keepPath) {
		throw new Error(
			"Favorite 폴더 경로가 설정되지 않았습니다. 설정에서 Favorite 폴더 경로를 먼저 설정해주세요.",
		);
	}

	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensurePathExists(
		keepPath,
		"Favorite 폴더 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const fileName = path.basename(filePath);
	const targetPath = await createNumberedPath(path.join(keepPath, fileName));
	await moveFileWithFallback(filePath, targetPath);

	return {
		success: true,
		message: "파일이 Favorite 폴더로 이동되었습니다.",
		targetPath,
	};
};

export const moveFileToFavoriteArtist = async (
	filePath: string,
	artistFolderName: string,
	favoriteArtistPath: string,
): Promise<FileMutationResult> => {
	if (!favoriteArtistPath) {
		throw new Error(
			"Favorite Artist 폴더 경로가 설정되지 않았습니다. 설정에서 Favorite Artist 폴더 경로를 먼저 설정해주세요.",
		);
	}

	const normalizedArtistFolderName = artistFolderName.trim();
	if (!normalizedArtistFolderName) {
		throw new Error("Favorite Artist 작가 폴더명이 비어 있습니다.");
	}
	if (
		normalizedArtistFolderName === "." ||
		normalizedArtistFolderName === ".." ||
		/[\\/]/.test(normalizedArtistFolderName)
	) {
		throw new Error(
			"Favorite Artist 작가 폴더명은 1단계 하위 폴더명만 지정할 수 있습니다.",
		);
	}

	const favoriteArtistRootPath = path.resolve(favoriteArtistPath);
	const targetDirectory = path.resolve(
		favoriteArtistRootPath,
		normalizedArtistFolderName,
	);
	if (!isPathInside(favoriteArtistRootPath, targetDirectory)) {
		throw new Error("Favorite Artist 폴더 밖으로는 이동할 수 없습니다.");
	}

	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensurePathExists(
		favoriteArtistRootPath,
		"Favorite Artist 폴더가 존재하지 않거나 접근할 수 없습니다.",
	);
	await ensurePathExists(
		targetDirectory,
		"Favorite Artist 작가 폴더가 존재하지 않거나 접근할 수 없습니다.",
	);

	const targetStats = await fs.promises.stat(targetDirectory);
	if (!targetStats.isDirectory()) {
		throw new Error("Favorite Artist 대상 경로가 폴더가 아닙니다.");
	}

	const fileName = path.basename(filePath);
	const targetPath = await createNumberedPath(
		path.join(targetDirectory, fileName),
	);
	await moveFileWithFallback(filePath, targetPath);

	return {
		success: true,
		message: "파일이 Favorite Artist 작가 폴더로 이동되었습니다.",
		targetPath,
	};
};
