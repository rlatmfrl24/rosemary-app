import type { ArchiveGalleryRecoveryEntry } from "../../../shared/crawler";
import type {
	DuplicateFileInfo,
	FavoriteArtistCandidate,
	FileThumbnail,
	GroupMergeCandidate,
} from "../../../shared/file-organizer";
import type { GallerySourceMetadata } from "../../../shared/gallery-metadata";
import type { OrganizationReviewIssue } from "../../../shared/organization-metadata";

export interface FileInfo {
	path: string;
	name: string;
	size: number;
	modifiedTimeMs?: number;
	isGrouped?: boolean;
	groupName?: string;
	thumbnail?: FileThumbnail;
	thumbnailLoadState?: "loading" | "failed";
	type?: string; // 유형 (예: Artistcg)
	origin?: string; // 오리진 (예: Genshin Impact)
	artist?: string; // 작가명 (예: Ttptt)
	category?: string; // 2차 분류 (예: N/A)
	title?: string; // 작품 제목 (예: Hotaru)
	code?: string; // 코드 (예: 3421843)
	sourceMetadata?: GallerySourceMetadata;
	archiveRecovery?: ArchiveGalleryRecoveryEntry;
}

export type DuplicateAction = "overwrite" | "skip" | "keep";

export type FileReviewStatus =
	| "checking"
	| "ready"
	| "duplicate"
	| "group-merge"
	| "review-needed";

export type FileReviewFilter =
	| "all"
	| "ready"
	| "favorite-artist"
	| "duplicate"
	| "group-merge"
	| "review-needed";

export interface ReviewFileInfo extends FileInfo {
	reviewStatus: FileReviewStatus;
	reviewChecks: {
		duplicates: boolean;
		groups: boolean;
		favoriteArtists: boolean;
	};
	duplicate?: DuplicateFileInfo;
	duplicateAction?: DuplicateAction;
	groupCandidate?: GroupMergeCandidate;
	favoriteArtistCandidate?: FavoriteArtistCandidate;
	useGroupTarget?: boolean;
	reviewError?: string;
	reviewIssues?: OrganizationReviewIssue[];
}

export type { DuplicateFileInfo } from "../../../shared/file-organizer";

export interface AppState {
	selectedPath: string | null;
	fileList: FileInfo[];
	isScanning: boolean;
	scanComplete: boolean;
	selectedRowIndex: number;
}

export type {
	CrawlerStatusSnapshot,
	CrawlItem,
	CrawlPhase,
	CrawlRunStatus,
} from "../../../shared/crawler";
