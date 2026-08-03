import type { GallerySourceMetadata } from "./gallery-metadata";
import type {
	TagPreference,
	TagPreferenceIdentity,
	TagPreferenceInput,
} from "./tag-preferences";

export const CRAWLER_TARGET_URL =
	"https://e-hentai.org/?f_search=korean&f_srdd=3";

export const DEFAULT_CRAWL_MAX_PAGES = 10;

export type CrawlRunStatus =
	| "idle"
	| "running"
	| "completed"
	| "partial"
	| "cancelled"
	| "failed";

export type CrawlPhase = "idle" | "front";

export interface CrawlItem {
	code: string;
	targetUrl: string;
	type: string;
	name: string;
	link: string;
	sourceCursor: string | null;
	createdRunId: number;
	discoveredAt: string;
}

export interface StartCrawlOptions {
	maxPages: number;
}

export interface GetRecentItemsOptions {
	runId?: number;
	limit?: number;
}

export interface CrawlItemListOptions {
	query?: string;
	type?: string;
	limit?: number;
}

export interface CrawlItemMutationInput {
	code: string;
	type: string;
	name: string;
	link: string;
	sourceCursor?: string | null;
	discoveredAt?: string;
}

export interface CrawlDatabaseSummary {
	itemCount: number;
	runCount: number;
	typeCount: number;
	types: string[];
	lastDiscoveredAt: string | null;
	defaultMaxPages: number;
	lastRunId: number | null;
	metadataCount: number;
	metadataMissingCount: number;
	metadataInvalidLinkCount: number;
	archiveIndexedCount: number;
	archiveOfficialMetadataCount: number;
	archiveCatalogMetadataCount: number;
	archiveMetadataMissingCount: number;
}

export interface CrawlDatabaseResetResult {
	itemCount: number;
	runCount: number;
	stateCount: number;
}

export interface HitomiCatalogIndexStatus {
	status: "idle" | "building" | "ready" | "error";
	fingerprint?: string;
	catalogUpdatedAt?: string;
	recordCount: number;
	minGalleryId?: string;
	maxGalleryId?: string;
	packCount: number;
	processedPackCount: number;
	builtAt?: string;
	error?: string;
}

export interface CrawlerStatusSnapshot {
	status: CrawlRunStatus;
	phase: CrawlPhase;
	runId: number | null;
	targetUrl: string;
	maxPages: number;
	pagesVisited: number;
	itemsSeen: number;
	newItems: number;
	duplicateItems: number;
	skippedItems: number;
	metadataRequested: number;
	metadataUpdated: number;
	metadataFailed: number;
	downloadRequested: number;
	downloadSent: number;
	downloadInvalid: number;
	downloadFailed: number;
	downloadExcluded: number;
	downloadLastError: string | null;
	currentCursor: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
	isStopping: boolean;
}

export type MetadataBackfillStatus =
	| "idle"
	| "running"
	| "paused"
	| "completed"
	| "completed_with_errors";

export interface MetadataBackfillSnapshot {
	jobId: number | null;
	status: MetadataBackfillStatus;
	totalCount: number;
	processedCount: number;
	updatedCount: number;
	failedCount: number;
	retryCount: number;
	remainingCount: number;
	alreadyPresentCount: number;
	invalidLinkCount: number;
	startedAt: string | null;
	updatedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
	isPausing: boolean;
}

export interface MetadataBackfillFailure {
	galleryId: string;
	attemptCount: number;
	error: string;
	updatedAt: string;
}

export type ArchiveMetadataRecoveryPhase =
	| "idle"
	| "indexing"
	| "catalog"
	| "search"
	| "metadata";

export type ArchiveMetadataRecoveryStatus =
	| "idle"
	| "running"
	| "paused"
	| "completed"
	| "completed_with_errors";

export type ArchiveMetadataRecoveryScope =
	| "file"
	| "folder"
	| "legacy-full"
	| "retry";

export type ArchiveGalleryRecoveryStatus =
	| "pending"
	| "official"
	| "expunged"
	| "catalog-only"
	| "access-denied"
	| "token-not-found"
	| "failed";

export interface ArchiveGalleryRecoveryEntry {
	galleryId: string;
	canonicalGalleryId?: string;
	status: ArchiveGalleryRecoveryStatus;
	reasonCode?: string;
	error?: string;
	hasToken: boolean;
	searchAttemptCount: number;
	metadataAttemptCount: number;
	updatedAt: string;
	metadata?: GallerySourceMetadata;
}

export interface ArchiveMetadataRecoverySnapshot {
	jobId: number | null;
	status: ArchiveMetadataRecoveryStatus;
	phase: ArchiveMetadataRecoveryPhase;
	scope: ArchiveMetadataRecoveryScope | null;
	scopePath: string | null;
	totalCount: number;
	processedCount: number;
	officialCount: number;
	catalogCount: number;
	unresolvedCount: number;
	failedCount: number;
	expungedCount: number;
	accessDeniedCount: number;
	tokenNotFoundCount: number;
	retryCount: number;
	priorityCount: number;
	remainingCount: number;
	startedAt: string | null;
	updatedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
	isPausing: boolean;
}

export interface ArchiveMetadataRecoveryFailure {
	galleryId: string;
	status: "access-denied" | "token-not-found" | "failed";
	phase: ArchiveMetadataRecoveryPhase;
	attemptCount: number;
	error: string;
	updatedAt: string;
}

export interface CrawlerDatabaseApi {
	getSummary: () => Promise<CrawlDatabaseSummary>;
	getHitomiCatalogStatus: () => Promise<HitomiCatalogIndexStatus>;
	listItems: (options?: CrawlItemListOptions) => Promise<CrawlItem[]>;
	createItem: (input: CrawlItemMutationInput) => Promise<CrawlItem>;
	updateItem: (
		originalCode: string,
		input: CrawlItemMutationInput,
	) => Promise<CrawlItem>;
	deleteItem: (code: string) => Promise<void>;
	resetDatabase: () => Promise<CrawlDatabaseResetResult>;
	listTagPreferences: () => Promise<TagPreference[]>;
	upsertTagPreference: (input: TagPreferenceInput) => Promise<TagPreference>;
	deleteTagPreference: (input: TagPreferenceIdentity) => Promise<void>;
	startArchiveMetadataRecovery: () => Promise<ArchiveMetadataRecoverySnapshot>;
	enqueueArchiveMetadataRecoveryFiles: (
		filePaths: string[],
	) => Promise<ArchiveMetadataRecoverySnapshot>;
	getArchiveMetadataRecoveryEntries: (
		galleryIds: string[],
	) => Promise<Record<string, ArchiveGalleryRecoveryEntry>>;
	pauseArchiveMetadataRecovery: () => Promise<ArchiveMetadataRecoverySnapshot>;
	resumeArchiveMetadataRecovery: () => Promise<ArchiveMetadataRecoverySnapshot>;
	getArchiveMetadataRecoveryStatus: () => Promise<ArchiveMetadataRecoverySnapshot>;
	listArchiveMetadataRecoveryFailures: (
		limit?: number,
	) => Promise<ArchiveMetadataRecoveryFailure[]>;
	retryArchiveMetadataRecoveryUnresolved: () => Promise<ArchiveMetadataRecoverySnapshot>;
}

export interface CrawlerApi {
	start: (options: StartCrawlOptions) => Promise<CrawlerStatusSnapshot>;
	stop: () => Promise<CrawlerStatusSnapshot>;
	getStatus: () => Promise<CrawlerStatusSnapshot>;
	getRecentItems: (options?: GetRecentItemsOptions) => Promise<CrawlItem[]>;
	retryFailedDownloads: (runId?: number) => Promise<CrawlerStatusSnapshot>;
}
