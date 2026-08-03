import type { ArchiveGalleryRecoveryEntry } from "./crawler";
import type { GallerySourceMetadata } from "./gallery-metadata";
import type {
	OrganizationMetadataSource,
	OrganizationReviewIssue,
} from "./organization-metadata";
import type { TagPreferenceIdentity } from "./tag-preferences";

export interface FileThumbnail {
	dataUrl: string;
	source: "archive-image" | "file-thumbnail" | "file-icon";
}

export interface ScanArchiveProgress {
	phase: "searching" | "reading" | "content" | "complete";
	processed: number;
	total: number;
	foundFiles: number;
	currentPath?: string;
	currentFileName?: string;
}

export interface ScanIndexSummary {
	cacheUsed: boolean;
	indexedAt: number;
	indexedCount: number;
	reusedCount: number;
	refreshedCount: number;
	removedCount: number;
}

export interface ScanArchiveResult {
	files: Array<{
		path: string;
		name: string;
		size: number;
		modifiedTimeMs?: number;
		isGrouped?: boolean;
		groupName?: string;
		sourceMetadata?: GallerySourceMetadata;
		archiveRecovery?: ArchiveGalleryRecoveryEntry;
	}>;
	indexSummary: ScanIndexSummary;
}

export interface RandomReviewOptions {
	sourcePath: string;
	limit: number;
	modifiedBeforeMs?: number;
	includeKeyword?: string;
	excludeKeyword?: string;
	minSizeBytes?: number;
	maxSizeBytes?: number;
	recursive: boolean;
	forceRefresh?: boolean;
	preferredTags?: TagPreferenceIdentity[];
}

export interface RandomReviewResult {
	files: Array<{
		path: string;
		name: string;
		size: number;
		modifiedTimeMs?: number;
		isGrouped?: boolean;
		groupName?: string;
		sourceMetadata?: GallerySourceMetadata;
		archiveRecovery?: ArchiveGalleryRecoveryEntry;
	}>;
	matchedCount: number;
	scannedCount: number;
	sourcePath: string;
	cacheUsed: boolean;
	indexedAt: number;
	indexedCount: number;
	reusedIndexCount: number;
	refreshedIndexCount: number;
	removedIndexCount: number;
}

export type SimilarGroupQueue =
	| "safe"
	| "cleanup"
	| "series"
	| "merge"
	| "suspicious";

export type SimilarGroupRecommendationAction =
	| "trash"
	| "group"
	| "merge"
	| "review";

export type SimilarGroupRiskLevel = "safe" | "review" | "suspicious";

export type SimilarGroupReviewStatus = "ignored" | "confirmed";

export type ArchiveContentScanMode = "off" | "metadata" | "smart" | "sample";

export interface ArchiveContentSummary {
	status: "scanned" | "metadata-only" | "unsupported" | "failed";
	entryCount: number;
	imageCount: number;
	totalCompressedSize: number;
	totalUncompressedSize: number;
	contentFingerprint?: string;
	orderedCrcSignature?: string;
	crcSetSignature?: string;
	crcWindowSignature?: string;
	sampleHashSignature?: string;
	sampleHashes?: string[];
	scanError?: string;
}

export interface SimilarGroupFolderSegments {
	type: string;
	origin: string;
	artist: string;
	title: string;
}

export interface SimilarGroupOptions {
	sourcePath: string;
	recursive: boolean;
	forceRefresh?: boolean;
	minGroupSize: number;
	minConfidence: number;
	includeKeyword?: string;
	excludeKeyword?: string;
	queue?: SimilarGroupQueue;
	includeReviewed?: boolean;
	includeSuspicious?: boolean;
	contentScanMode?: ArchiveContentScanMode;
}

export interface SimilarGroupFile {
	path: string;
	relativePath: string;
	name: string;
	size: number;
	modifiedTimeMs?: number;
	type?: string;
	origin?: string;
	artist?: string;
	category?: string;
	title: string;
	code?: string;
	baseTitle: string;
	seriesTokens: string[];
	editionTokens: string[];
	content?: ArchiveContentSummary;
	sourceMetadata?: GallerySourceMetadata;
	reviewIssues?: OrganizationReviewIssue[];
}

export interface SimilarGroup {
	id: string;
	representativeTitle: string;
	artist?: string;
	type?: string;
	origin?: string;
	confidence: number;
	reasons: string[];
	files: SimilarGroupFile[];
	totalSize: number;
	queue: Exclude<SimilarGroupQueue, "safe">;
	recommendationAction: SimilarGroupRecommendationAction;
	riskLevel: SimilarGroupRiskLevel;
	reviewKey: string;
	contentSignature: string;
	folderSegments: SimilarGroupFolderSegments;
	targetGroupName?: string;
	targetGroupPath?: string;
	reviewStatus?: SimilarGroupReviewStatus;
}

export interface SimilarGroupResult {
	groups: SimilarGroup[];
	sourcePath: string;
	scannedCount: number;
	groupedFileCount: number;
	cacheUsed: boolean;
	indexedAt: number;
	countsByQueue: Record<SimilarGroupQueue, number>;
	hiddenReviewedCount: number;
	hiddenSuspiciousCount: number;
}

export interface GroupMergeSourceFile {
	path: string;
	name: string;
	size: number;
	artist?: string;
	type?: string;
	origin?: string;
	sourceMetadata?: GallerySourceMetadata;
}

export interface GroupMergeCandidate {
	filePath: string;
	fileName: string;
	relativePath: string;
	groupName: string;
	groupPath: string;
	confidence: number;
	reasons: string[];
	sampleFiles: string[];
}

export interface FavoriteArtistCandidate {
	filePath: string;
	fileName: string;
	artist: string;
	artistFolderName: string;
	targetDirectory: string;
	relativeTargetDirectory: string;
	matchedArtists: string[];
	metadataSource: OrganizationMetadataSource;
}

export interface FavoriteArtistCandidateResult {
	candidates: FavoriteArtistCandidate[];
	issues: OrganizationReviewIssue[];
}

export interface GroupMergeCandidateResult {
	candidates: GroupMergeCandidate[];
	issues: OrganizationReviewIssue[];
}

export type DuplicateMatchKind =
	| "gallery-id"
	| "gallery-id-and-path"
	| "relative-path";

export interface DuplicateFileInfo {
	sourceFile: string;
	sourcePath: string;
	sourceSize: number;
	targetPath: string;
	targetSize: number;
	relativePath: string;
	galleryId?: string;
	matchKind: DuplicateMatchKind;
}

export interface DuplicateCheckResult {
	hasDuplicates: boolean;
	duplicates: DuplicateFileInfo[];
	issues: OrganizationReviewIssue[];
	totalFiles: number;
}

export interface GroupOperationResult {
	success: boolean;
	results: Array<{
		path: string;
		success: boolean;
		targetPath?: string;
		error?: string;
	}>;
	summary: {
		total: number;
		success: number;
		failed: number;
	};
}

export interface SimilarGroupReviewStateInput {
	reviewKey: string;
	contentSignature: string;
	status: SimilarGroupReviewStatus;
}

export interface GroupedFolderMigrationItem {
	sourcePath: string;
	targetPath: string;
	relativeSourcePath: string;
	relativeTargetPath: string;
	folderSegments: SimilarGroupFolderSegments;
	fileCount: number;
	targetExists: boolean;
}

export interface GroupedFolderMigrationPreview {
	sourcePath: string;
	groupRootPath: string;
	items: GroupedFolderMigrationItem[];
	skippedCount: number;
	totalFiles: number;
}

export interface GroupedFolderMigrationResult {
	success: boolean;
	results: Array<{
		sourcePath: string;
		targetPath?: string;
		success: boolean;
		error?: string;
	}>;
	summary: {
		total: number;
		success: number;
		failed: number;
	};
}

export interface FileOrganizerApi {
	randomReview: (options: RandomReviewOptions) => Promise<RandomReviewResult>;
	findSimilarGroups: (
		options: SimilarGroupOptions,
	) => Promise<SimilarGroupResult>;
	trashFiles: (filePaths: string[]) => Promise<GroupOperationResult>;
	moveGroupToFolder: (
		sourcePath: string,
		filePaths: string[],
		groupName: string,
		folderSegments?: SimilarGroupFolderSegments,
	) => Promise<GroupOperationResult>;
	mergeFilesToGroup: (
		sourcePath: string,
		filePaths: string[],
		targetGroupPath: string,
	) => Promise<GroupOperationResult>;
	findGroupMergeCandidates: (
		files: GroupMergeSourceFile[],
		scanPath: string,
	) => Promise<GroupMergeCandidateResult>;
	findFavoriteArtistCandidates: (
		files: GroupMergeSourceFile[],
	) => Promise<FavoriteArtistCandidateResult>;
	moveFileToFavoriteArtist: (
		filePath: string,
		artistFolderName: string,
	) => Promise<{
		success: boolean;
		message: string;
		targetPath?: string;
	}>;
	markSimilarGroupReviewState: (
		input: SimilarGroupReviewStateInput,
	) => Promise<boolean>;
	clearSimilarGroupReviewState: (
		reviewKey: string,
		contentSignature?: string,
	) => Promise<boolean>;
	previewGroupedFolderMigration: (
		sourcePath: string,
	) => Promise<GroupedFolderMigrationPreview>;
	executeGroupedFolderMigration: (
		sourcePath: string,
	) => Promise<GroupedFolderMigrationResult>;
	onRandomReviewProgress: (
		callback: (progress: ScanArchiveProgress) => void,
	) => () => void;
	onSimilarGroupsProgress: (
		callback: (progress: ScanArchiveProgress) => void,
	) => () => void;
}
