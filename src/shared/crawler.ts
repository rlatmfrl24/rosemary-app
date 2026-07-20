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
}

export interface CrawlDatabaseResetResult {
	itemCount: number;
	runCount: number;
	stateCount: number;
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

export interface CrawlerDatabaseApi {
	getSummary: () => Promise<CrawlDatabaseSummary>;
	listItems: (options?: CrawlItemListOptions) => Promise<CrawlItem[]>;
	createItem: (input: CrawlItemMutationInput) => Promise<CrawlItem>;
	updateItem: (
		originalCode: string,
		input: CrawlItemMutationInput,
	) => Promise<CrawlItem>;
	deleteItem: (code: string) => Promise<void>;
	resetDatabase: () => Promise<CrawlDatabaseResetResult>;
	startMetadataBackfill: () => Promise<MetadataBackfillSnapshot>;
	pauseMetadataBackfill: () => Promise<MetadataBackfillSnapshot>;
	resumeMetadataBackfill: () => Promise<MetadataBackfillSnapshot>;
	getMetadataBackfillStatus: () => Promise<MetadataBackfillSnapshot>;
	listMetadataBackfillFailures: (
		limit?: number,
	) => Promise<MetadataBackfillFailure[]>;
	retryMetadataBackfillFailures: () => Promise<MetadataBackfillSnapshot>;
}

export interface CrawlerApi {
	start: (options: StartCrawlOptions) => Promise<CrawlerStatusSnapshot>;
	stop: () => Promise<CrawlerStatusSnapshot>;
	getStatus: () => Promise<CrawlerStatusSnapshot>;
	getRecentItems: (options?: GetRecentItemsOptions) => Promise<CrawlItem[]>;
}
