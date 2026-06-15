export interface FileThumbnail {
	dataUrl: string;
	source: "archive-image" | "file-thumbnail" | "file-icon";
}

export interface ScanArchiveProgress {
	phase: "searching" | "reading" | "complete";
	processed: number;
	total: number;
	foundFiles: number;
	currentPath?: string;
	currentFileName?: string;
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
}

export interface RandomReviewResult {
	files: Array<{
		path: string;
		name: string;
		size: number;
		modifiedTimeMs?: number;
		isGrouped?: boolean;
		groupName?: string;
	}>;
	matchedCount: number;
	scannedCount: number;
	sourcePath: string;
	cacheUsed: boolean;
	indexedAt: number;
	indexedCount: number;
}

export interface SimilarGroupOptions {
	sourcePath: string;
	recursive: boolean;
	forceRefresh?: boolean;
	minGroupSize: number;
	minConfidence: number;
	includeKeyword?: string;
	excludeKeyword?: string;
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
}

export interface SimilarGroupResult {
	groups: SimilarGroup[];
	sourcePath: string;
	scannedCount: number;
	groupedFileCount: number;
	cacheUsed: boolean;
	indexedAt: number;
}

export interface GroupMergeSourceFile {
	path: string;
	name: string;
	size: number;
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
	) => Promise<GroupOperationResult>;
	findGroupMergeCandidates: (
		files: GroupMergeSourceFile[],
		scanPath: string,
	) => Promise<GroupMergeCandidate[]>;
	onRandomReviewProgress: (
		callback: (progress: ScanArchiveProgress) => void,
	) => () => void;
	onSimilarGroupsProgress: (
		callback: (progress: ScanArchiveProgress) => void,
	) => () => void;
}
