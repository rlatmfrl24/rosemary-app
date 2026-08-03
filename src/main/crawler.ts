import { randomInt } from "node:crypto";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as cheerio from "cheerio";
import { net } from "electron";
import { collectArchiveRecoveryCandidates } from "../shared/archive-metadata-recovery";
import { parseArchiveFileName } from "../shared/archive-name";
import {
	type ArchiveGalleryRecoveryEntry,
	type ArchiveGalleryRecoveryStatus,
	type ArchiveMetadataRecoveryFailure,
	type ArchiveMetadataRecoveryPhase,
	type ArchiveMetadataRecoveryScope,
	type ArchiveMetadataRecoverySnapshot,
	type ArchiveMetadataRecoveryStatus,
	CRAWLER_TARGET_URL,
	type CrawlDatabaseResetResult,
	type CrawlDatabaseSummary,
	type CrawlerStatusSnapshot,
	type CrawlItem,
	type CrawlItemListOptions,
	type CrawlItemMutationInput,
	type CrawlPhase,
	type CrawlRunStatus,
	DEFAULT_CRAWL_MAX_PAGES,
	type GetRecentItemsOptions,
	type HitomiCatalogIndexStatus,
	type MetadataBackfillFailure,
	type MetadataBackfillSnapshot,
	type MetadataBackfillStatus,
	type StartCrawlOptions,
} from "../shared/crawler";
import {
	createGalleryMetadataRequestPayload,
	type GalleryIdentity,
	type GalleryMetadataBatchResult,
	type GallerySourceMetadata,
	mapGalleryMetadataBatchResponse,
} from "../shared/gallery-metadata";
import {
	getMatchingTagPreferences,
	getTagPreferenceKey,
	type TagPreference,
	type TagPreferenceIdentity,
	type TagPreferenceInput,
} from "../shared/tag-preferences";
import {
	clearCrawlerDatabaseContent,
	getMetadataBackfillFailedGalleryIds,
	initializeCrawlerDatabase,
} from "./crawler-database";
import {
	applyDownloadDispatchResult,
	type DownloadDispatchStatus,
	getDownloadDispatchSummary,
	markDownloadDispatchRowsExcluded,
	markDownloadDispatchRowsFailed,
	selectDownloadDispatchRows,
} from "./crawler-download-dispatch";
import {
	collectAndPersistCrawlerGalleryMetadata,
	type GalleryMetadataPageStats,
	persistCatalogMetadataWithOfficialFallback,
} from "./crawler-metadata";
import {
	executeRetryableRequest,
	isRetryableHttpStatusCode,
} from "./crawler-request-policy";
import { scanArchiveFiles } from "./files";
import { sendCodesToHitomiApi } from "./hitomi-api";
import { getHitomiCatalogPath } from "./hitomi-catalog";
import { HitomiCatalogIndex } from "./hitomi-catalog-index";
import { loadSettings } from "./settings";
import {
	deleteTagPreference as deleteStoredTagPreference,
	listTagPreferences as listStoredTagPreferences,
	upsertTagPreference as upsertStoredTagPreference,
} from "./tag-preferences";

const BASE_DELAY_MIN_MS = 1500;
const BASE_DELAY_MAX_MS = 4000;
const RETRY_DELAY_MIN_MS = 8000;
const RETRY_DELAY_MAX_MS = 15000;
const MAX_RETRY_COUNT = 2;
const GALLERY_METADATA_API_URL = "https://api.e-hentai.org/api.php";
const GALLERY_METADATA_BATCHES_PER_WINDOW = 4;
const GALLERY_METADATA_COOLDOWN_MS = 5000;
const RECENT_ITEMS_LIMIT = 50;
const DB_ITEM_LIST_LIMIT = 100;
const MANUAL_RUN_TAG = "manual-entry";
const CRAWLER_REQUEST_HEADERS = {
	Accept: "text/html,application/xhtml+xml",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
};

interface CrawlStateRow {
	target_url: string;
	default_max_pages: number;
	last_run_id: number | null;
	updated_at: string;
}

interface CrawlRunRow {
	id: number;
	target_url: string;
	status: CrawlRunStatus;
	phase: CrawlPhase;
	max_pages: number;
	pages_visited: number;
	items_seen: number;
	new_items: number;
	duplicate_items: number;
	skipped_items: number;
	metadata_requested: number;
	metadata_updated: number;
	metadata_failed: number;
	download_requested: number;
	download_sent: number;
	download_invalid: number;
	download_failed: number;
	download_excluded: number;
	download_last_error: string | null;
	resume_cursor_before: string | null;
	resume_cursor_after: string | null;
	started_at: string;
	finished_at: string | null;
	last_error: string | null;
}

interface CrawlItemMetadataRow {
	gallery_id: string;
	token: string | null;
	source_kind: "ehentai-api" | "hitomi-catalog";
	title: string;
	title_japanese: string | null;
	category: string;
	uploader: string | null;
	posted_at: string | null;
	file_count: number | null;
	file_size: number | null;
	rating: number | null;
	expunged: number | null;
	parent_gallery_id: string | null;
	parent_token: string | null;
	current_gallery_id: string | null;
	current_token: string | null;
	first_gallery_id: string | null;
	first_token: string | null;
	fetched_at: string;
}

interface CrawlItemTagRow {
	gallery_id: string;
	namespace: string;
	value: string;
	position: number;
}

interface ArchiveGalleryMetadataRow extends CrawlItemMetadataRow {
	canonical_gallery_id: string | null;
	token: string | null;
	expunged: number | null;
}

interface CrawlItemRow {
	code: string;
	target_url: string;
	type: string;
	name: string;
	link: string;
	source_cursor: string | null;
	created_run_id: number;
	discovered_at: string;
}

interface ParsedPageItem {
	code: string;
	type: string;
	name: string;
	link: string;
	sourceCursor: string | null;
}

interface ParsedPage {
	items: ParsedPageItem[];
	nextCursor: string | null;
	skippedCount: number;
}

interface CrawlerHttpResponse {
	statusCode: number;
	body: string;
}

interface MetadataCoverage {
	metadataCount: number;
	missingGalleryIds: string[];
	invalidLinkCount: number;
}

interface MetadataBackfillJobRow {
	id: number;
	status: MetadataBackfillStatus;
	total_count: number;
	processed_count: number;
	updated_count: number;
	failed_count: number;
	retry_count: number;
	remaining_count: number;
	already_present_count: number;
	invalid_link_count: number;
	started_at: string;
	updated_at: string;
	finished_at: string | null;
	last_error: string | null;
}

interface MetadataBackfillItemRow {
	gallery_id: string;
	attempt_count: number;
}

interface ArchiveMetadataRecoveryJobRow {
	id: number;
	status: ArchiveMetadataRecoveryStatus;
	phase: ArchiveMetadataRecoveryPhase;
	scope_kind: ArchiveMetadataRecoveryScope;
	scope_path: string | null;
	total_count: number;
	processed_count: number;
	official_count: number;
	catalog_count: number;
	unresolved_count: number;
	failed_count: number;
	expunged_count: number;
	access_denied_count: number;
	token_not_found_count: number;
	retry_count: number;
	remaining_count: number;
	started_at: string;
	updated_at: string;
	finished_at: string | null;
	last_error: string | null;
}

interface ArchiveGalleryRecoveryStateRow {
	gallery_id: string;
	canonical_gallery_id: string | null;
	token: string | null;
	status: ArchiveGalleryRecoveryStatus;
	reason_code: string | null;
	last_error: string | null;
	search_attempt_count: number;
	metadata_attempt_count: number;
	updated_at: string;
}

class RetryableFetchError extends Error {
	constructor(
		message: string,
		options?: {
			statusCode?: number;
			cause?: unknown;
		},
	) {
		super(message, { cause: options?.cause });
		this.name = "RetryableFetchError";
		this.statusCode = options?.statusCode;
	}

	public readonly statusCode?: number;
}

export class CrawlerService {
	private readonly db: DatabaseSync;
	private readonly hitomiCatalogIndex: HitomiCatalogIndex;

	private currentStatus: CrawlerStatusSnapshot | null = null;

	private currentRunPromise: Promise<void> | null = null;

	private abortController: AbortController | null = null;

	private currentBackfillPromise: Promise<void> | null = null;

	private backfillAbortController: AbortController | null = null;

	private isBackfillPausing = false;

	private currentArchiveRecoveryPromise: Promise<void> | null = null;

	private archiveRecoveryAbortController: AbortController | null = null;

	private isArchiveRecoveryPausing = false;
	private metadataBatchesInWindow = 0;

	constructor(userDataPath: string) {
		const databasePath = path.join(userDataPath, "crawler.sqlite");
		this.db = new DatabaseSync(databasePath);
		this.hitomiCatalogIndex = new HitomiCatalogIndex(userDataPath);
		this.initializeDatabase();
	}

	public start(options: StartCrawlOptions): CrawlerStatusSnapshot {
		if (this.currentRunPromise) {
			throw new Error("이미 크롤링이 진행 중입니다.");
		}
		if (this.currentBackfillPromise) {
			throw new Error("원천 메타데이터 백필이 진행 중입니다.");
		}
		if (this.currentArchiveRecoveryPromise) {
			throw new Error("보관분 메타데이터 복구가 진행 중입니다.");
		}

		const maxPages = this.validateMaxPages(options.maxPages);
		this.metadataBatchesInWindow = 0;
		this.getOrCreateState();
		const startedAt = new Date().toISOString();

		this.db
			.prepare(
				`
					UPDATE crawl_state
					SET default_max_pages = ?, updated_at = ?
					WHERE target_url = ?
				`,
			)
			.run(maxPages, startedAt, CRAWLER_TARGET_URL);

		const runResult = this.db
			.prepare(
				`
					INSERT INTO crawl_runs (
						target_url,
						status,
						phase,
						max_pages,
						pages_visited,
						items_seen,
						new_items,
						duplicate_items,
						skipped_items,
						metadata_requested,
						metadata_updated,
						metadata_failed,
						resume_cursor_before,
						resume_cursor_after,
						started_at,
						finished_at,
						last_error
					) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?, NULL, NULL)
				`,
			)
			.run(
				CRAWLER_TARGET_URL,
				"running",
				"front",
				maxPages,
				null,
				null,
				startedAt,
			);

		const runId = Number(runResult.lastInsertRowid);
		this.abortController = new AbortController();
		this.currentStatus = {
			status: "running",
			phase: "front",
			runId,
			targetUrl: CRAWLER_TARGET_URL,
			maxPages,
			pagesVisited: 0,
			itemsSeen: 0,
			newItems: 0,
			duplicateItems: 0,
			skippedItems: 0,
			metadataRequested: 0,
			metadataUpdated: 0,
			metadataFailed: 0,
			downloadRequested: 0,
			downloadSent: 0,
			downloadInvalid: 0,
			downloadFailed: 0,
			downloadExcluded: 0,
			downloadLastError: null,
			currentCursor: null,
			startedAt,
			finishedAt: null,
			lastError: null,
			isStopping: false,
		};

		this.currentRunPromise = this.runCrawl(runId, maxPages)
			.catch((error) => {
				console.error("크롤링 작업 실패:", error);
			})
			.finally(() => {
				this.currentRunPromise = null;
				this.abortController = null;
				if (this.currentStatus) {
					this.currentStatus.isStopping = false;
					this.currentStatus.currentCursor = null;
				}
			});

		return { ...this.currentStatus };
	}

	public async stop(): Promise<CrawlerStatusSnapshot> {
		if (!this.currentRunPromise || !this.currentStatus) {
			return this.getStatus();
		}

		this.currentStatus.isStopping = true;
		this.abortController?.abort(new DOMException("manual-stop", "AbortError"));

		return { ...this.currentStatus };
	}

	public getStatus(): CrawlerStatusSnapshot {
		if (this.currentStatus) {
			return { ...this.currentStatus };
		}

		const crawlState = this.getOrCreateState();
		const lastRun = crawlState.last_run_id
			? ((this.db
					.prepare("SELECT * FROM crawl_runs WHERE id = ?")
					.get(crawlState.last_run_id) as CrawlRunRow | undefined) ?? null)
			: null;

		if (!lastRun) {
			return this.createIdleStatus({
				maxPages: crawlState.default_max_pages,
			});
		}

		return {
			status: lastRun.status,
			phase: "idle",
			runId: lastRun.id,
			targetUrl: CRAWLER_TARGET_URL,
			maxPages: lastRun.max_pages || crawlState.default_max_pages,
			pagesVisited: lastRun.pages_visited,
			itemsSeen: lastRun.items_seen,
			newItems: lastRun.new_items,
			duplicateItems: lastRun.duplicate_items,
			skippedItems: lastRun.skipped_items,
			metadataRequested: lastRun.metadata_requested,
			metadataUpdated: lastRun.metadata_updated,
			metadataFailed: lastRun.metadata_failed,
			downloadRequested: lastRun.download_requested,
			downloadSent: lastRun.download_sent,
			downloadInvalid: lastRun.download_invalid,
			downloadFailed: lastRun.download_failed,
			downloadExcluded: lastRun.download_excluded,
			downloadLastError: lastRun.download_last_error,
			currentCursor: null,
			startedAt: lastRun.started_at,
			finishedAt: lastRun.finished_at,
			lastError: lastRun.last_error,
			isStopping: false,
		};
	}

	public getRecentItems(options?: GetRecentItemsOptions): CrawlItem[] {
		const crawlState = this.getOrCreateState();
		const runId = options?.runId ?? crawlState.last_run_id;
		if (!runId) {
			return [];
		}

		const limit = this.normalizeLimit(options?.limit);
		const rows = this.db
			.prepare(
				`
					SELECT
						code,
						target_url,
						type,
						name,
						link,
						source_cursor,
						created_run_id,
						discovered_at
					FROM crawl_items
					WHERE created_run_id = ?
					ORDER BY discovered_at DESC, rowid DESC
					LIMIT ?
				`,
			)
			.all(runId, limit) as unknown as CrawlItemRow[];

		return rows.map((row) => this.mapItemRow(row));
	}

	public async retryFailedDownloads(
		runId?: number,
	): Promise<CrawlerStatusSnapshot> {
		if (this.currentRunPromise) {
			throw new Error(
				"크롤링 실행 중에는 다운로드 요청을 재시도할 수 없습니다.",
			);
		}
		const targetRunId = runId ?? this.getOrCreateState().last_run_id;
		if (!targetRunId) throw new Error("재시도할 크롤링 실행이 없습니다.");
		await this.dispatchDownloads(targetRunId, ["failed"]);
		return this.getStatus();
	}

	public getMetadataByGalleryIds(
		galleryIds: string[],
	): Record<string, GallerySourceMetadata> {
		const normalizedGalleryIds = [
			...new Set(
				galleryIds
					.map((galleryId) => galleryId.trim())
					.filter((galleryId) => /^\d+$/.test(galleryId)),
			),
		];
		const metadataByGalleryId: Record<string, GallerySourceMetadata> = {};

		for (let offset = 0; offset < normalizedGalleryIds.length; offset += 500) {
			const batch = normalizedGalleryIds.slice(offset, offset + 500);
			const placeholders = batch.map(() => "?").join(", ");
			const metadataRows = this.db
				.prepare(
					`SELECT * FROM crawl_item_metadata WHERE gallery_id IN (${placeholders})`,
				)
				.all(...batch) as unknown as CrawlItemMetadataRow[];
			const tagRows = this.db
				.prepare(
					`SELECT gallery_id, namespace, value, position
					 FROM crawl_item_tags
					 WHERE gallery_id IN (${placeholders})
					 ORDER BY gallery_id ASC, position ASC`,
				)
				.all(...batch) as unknown as CrawlItemTagRow[];
			const tagsByGalleryId = new Map<string, CrawlItemTagRow[]>();

			for (const tagRow of tagRows) {
				const tags = tagsByGalleryId.get(tagRow.gallery_id) ?? [];
				tags.push(tagRow);
				tagsByGalleryId.set(tagRow.gallery_id, tags);
			}

			for (const row of metadataRows) {
				metadataByGalleryId[row.gallery_id] = this.mapMetadataRow(
					row,
					tagsByGalleryId.get(row.gallery_id) ?? [],
				);
			}

			const archiveIds = batch.filter(
				(galleryId) => metadataByGalleryId[galleryId] === undefined,
			);
			if (archiveIds.length > 0) {
				const archivePlaceholders = archiveIds.map(() => "?").join(", ");
				const archiveRows = this.db
					.prepare(
						`SELECT * FROM archive_gallery_metadata
						 WHERE gallery_id IN (${archivePlaceholders})`,
					)
					.all(...archiveIds) as unknown as ArchiveGalleryMetadataRow[];
				const archiveTagRows = this.db
					.prepare(
						`SELECT gallery_id, namespace, value, position
						 FROM archive_gallery_tags
						 WHERE gallery_id IN (${archivePlaceholders})
						 ORDER BY gallery_id ASC, position ASC`,
					)
					.all(...archiveIds) as unknown as CrawlItemTagRow[];
				const archiveTagsByGalleryId = new Map<string, CrawlItemTagRow[]>();
				for (const tagRow of archiveTagRows) {
					const tags = archiveTagsByGalleryId.get(tagRow.gallery_id) ?? [];
					tags.push(tagRow);
					archiveTagsByGalleryId.set(tagRow.gallery_id, tags);
				}
				for (const row of archiveRows) {
					metadataByGalleryId[row.gallery_id] = this.mapArchiveMetadataRow(
						row,
						archiveTagsByGalleryId.get(row.gallery_id) ?? [],
					);
				}
			}
		}

		return metadataByGalleryId;
	}

	public listTagPreferences(): TagPreference[] {
		return listStoredTagPreferences(this.db);
	}

	public upsertTagPreference(input: TagPreferenceInput): TagPreference {
		return upsertStoredTagPreference(this.db, input);
	}

	public deleteTagPreference(input: TagPreferenceIdentity): void {
		deleteStoredTagPreference(this.db, input);
	}

	public getDatabaseSummary(): CrawlDatabaseSummary {
		const crawlState = this.getOrCreateState();
		const metadataCoverage = this.getMetadataCoverage();
		const itemCount = this.db
			.prepare("SELECT COUNT(*) AS count FROM crawl_items")
			.get() as { count: number };
		const runCount = this.db
			.prepare("SELECT COUNT(*) AS count FROM crawl_runs")
			.get() as { count: number };
		const lastDiscovered = this.db
			.prepare(
				"SELECT MAX(discovered_at) AS last_discovered_at FROM crawl_items",
			)
			.get() as { last_discovered_at: string | null };
		const typeRows = this.db
			.prepare(
				`
					SELECT DISTINCT type
					FROM crawl_items
					WHERE type IS NOT NULL AND TRIM(type) <> ''
					ORDER BY type ASC
				`,
			)
			.all() as unknown as Array<{ type: string }>;
		const latestArchiveJob = this.getLatestArchiveMetadataRecoveryJob();
		const archiveCounts = latestArchiveJob
			? (this.db
					.prepare(
						`SELECT
							SUM(CASE WHEN metadata.source_kind = 'ehentai-api' THEN 1 ELSE 0 END) AS official_count,
							SUM(CASE WHEN metadata.source_kind = 'hitomi-catalog' THEN 1 ELSE 0 END) AS catalog_count
						 FROM archive_metadata_recovery_items AS item
						 LEFT JOIN archive_gallery_metadata AS metadata
						   ON metadata.gallery_id = item.gallery_id
						 WHERE item.job_id = ?`,
					)
					.get(latestArchiveJob.id) as {
					official_count: number | null;
					catalog_count: number | null;
				})
			: { official_count: 0, catalog_count: 0 };
		const archiveIndexedCount = latestArchiveJob?.total_count ?? 0;
		const archiveOfficialMetadataCount = archiveCounts.official_count ?? 0;
		const archiveCatalogMetadataCount = archiveCounts.catalog_count ?? 0;

		return {
			itemCount: itemCount.count,
			runCount: runCount.count,
			typeCount: typeRows.length,
			types: typeRows.map((row) => row.type),
			lastDiscoveredAt: lastDiscovered.last_discovered_at,
			defaultMaxPages: crawlState.default_max_pages,
			lastRunId: crawlState.last_run_id,
			metadataCount: metadataCoverage.metadataCount,
			metadataMissingCount: metadataCoverage.missingGalleryIds.length,
			metadataInvalidLinkCount: metadataCoverage.invalidLinkCount,
			archiveIndexedCount,
			archiveOfficialMetadataCount,
			archiveCatalogMetadataCount,
			archiveMetadataMissingCount: Math.max(
				0,
				archiveIndexedCount -
					archiveOfficialMetadataCount -
					archiveCatalogMetadataCount,
			),
		};
	}

	public getHitomiCatalogStatus(): HitomiCatalogIndexStatus {
		return this.hitomiCatalogIndex.getStatus();
	}

	public startMetadataBackfill(): MetadataBackfillSnapshot {
		this.assertMetadataBackfillCanStart();
		const latestJob = this.getLatestMetadataBackfillJob();
		if (latestJob?.status === "paused") {
			throw new Error("일시 중단된 백필 작업을 먼저 재개해주세요.");
		}

		return this.createAndStartMetadataBackfill();
	}

	public retryMetadataBackfillFailures(): MetadataBackfillSnapshot {
		this.assertMetadataBackfillCanStart();
		const latestJob = this.getLatestMetadataBackfillJob();
		if (!latestJob) {
			throw new Error("재시도할 백필 작업이 없습니다.");
		}
		if (latestJob?.status === "paused") {
			throw new Error("일시 중단된 백필 작업을 먼저 재개해주세요.");
		}
		const failedGalleryIds = getMetadataBackfillFailedGalleryIds(
			this.db,
			latestJob.id,
		);
		if (failedGalleryIds.length === 0) {
			throw new Error("재시도할 실패 항목이 없습니다.");
		}
		return this.createAndStartMetadataBackfill(new Set(failedGalleryIds));
	}

	public resumeMetadataBackfill(): MetadataBackfillSnapshot {
		this.assertMetadataBackfillCanStart();
		const job = this.getLatestMetadataBackfillJob();
		if (!job || job.status !== "paused") {
			throw new Error("재개할 백필 작업이 없습니다.");
		}

		const updatedAt = new Date().toISOString();
		this.db
			.prepare(
				`UPDATE crawl_metadata_backfill_jobs
				 SET status = 'running', updated_at = ?, finished_at = NULL,
				     last_error = NULL
				 WHERE id = ?`,
			)
			.run(updatedAt, job.id);
		this.beginMetadataBackfill(job.id);

		return this.getMetadataBackfillStatus();
	}

	public pauseMetadataBackfill(): MetadataBackfillSnapshot {
		if (!this.currentBackfillPromise) {
			return this.getMetadataBackfillStatus();
		}

		this.isBackfillPausing = true;
		this.backfillAbortController?.abort(
			new DOMException("metadata-backfill-pause", "AbortError"),
		);

		return this.getMetadataBackfillStatus();
	}

	public getMetadataBackfillStatus(): MetadataBackfillSnapshot {
		const job = this.getLatestMetadataBackfillJob();
		if (!job) {
			return this.createIdleMetadataBackfillStatus();
		}

		return this.mapMetadataBackfillJobRow(job);
	}

	public listMetadataBackfillFailures(limit = 50): MetadataBackfillFailure[] {
		const job = this.getLatestMetadataBackfillJob();
		if (!job) {
			return [];
		}

		const normalizedLimit = Math.min(
			Math.max(Number.isFinite(limit) ? Math.floor(limit) : 50, 1),
			200,
		);
		const rows = this.db
			.prepare(
				`SELECT gallery_id, attempt_count, last_error, updated_at
				 FROM crawl_metadata_backfill_items
				 WHERE job_id = ? AND status = 'failed'
				 ORDER BY updated_at DESC, CAST(gallery_id AS INTEGER) DESC
				 LIMIT ?`,
			)
			.all(job.id, normalizedLimit) as unknown as Array<{
			gallery_id: string;
			attempt_count: number;
			last_error: string | null;
			updated_at: string;
		}>;

		return rows.map((row) => ({
			galleryId: row.gallery_id,
			attemptCount: row.attempt_count,
			error: row.last_error ?? "알 수 없는 오류",
			updatedAt: row.updated_at,
		}));
	}

	public async startArchiveMetadataRecovery(): Promise<ArchiveMetadataRecoverySnapshot> {
		this.assertArchiveMetadataRecoveryCanStart();
		const latestJob = this.getLatestArchiveMetadataRecoveryJob();
		if (latestJob?.status === "paused") {
			throw new Error("일시 중단된 보관분 복구 작업을 먼저 재개해주세요.");
		}
		const settings = await loadSettings();
		const storePath = settings.storePath.trim();
		if (!storePath) {
			throw new Error("설정에서 기본 저장소 경로를 먼저 지정해주세요.");
		}
		return this.createAndStartArchiveMetadataRecovery(
			"legacy-full",
			path.resolve(storePath),
			"indexing",
		);
	}

	public enqueueArchiveMetadataRecoveryFiles(
		filePaths: string[],
	): ArchiveMetadataRecoverySnapshot {
		if (this.currentRunPromise) throw new Error("일반 크롤링이 진행 중입니다.");
		if (this.currentBackfillPromise)
			throw new Error("원천 메타데이터 백필이 진행 중입니다.");
		const candidates = new Map<string, string>();
		for (const filePath of filePaths) {
			const galleryId = parseArchiveFileName(path.basename(filePath)).code;
			if (galleryId) candidates.set(galleryId, filePath);
		}
		if (candidates.size === 0)
			throw new Error("파일명에서 gallery id를 찾지 못했습니다.");

		let job = this.getLatestArchiveMetadataRecoveryJob();
		let shouldStart = false;
		if (!job || !["running", "paused"].includes(job.status)) {
			const snapshot = this.createArchiveMetadataRecoveryJob(
				"file",
				null,
				"catalog",
			);
			job = this.getArchiveMetadataRecoveryJob(snapshot.jobId ?? -1);
			shouldStart = true;
		}
		if (!job) throw new Error("보관분 복구 작업을 생성하지 못했습니다.");
		this.insertArchiveRecoveryCandidates(job.id, candidates, 100);
		if (shouldStart) this.beginArchiveMetadataRecovery(job.id);
		return this.getArchiveMetadataRecoveryStatus();
	}

	public getArchiveMetadataRecoveryEntries(
		galleryIds: string[],
	): Record<string, ArchiveGalleryRecoveryEntry> {
		const uniqueIds = [...new Set(galleryIds.filter((id) => /^\d+$/.test(id)))];
		const metadataByGalleryId = this.getMetadataByGalleryIds(uniqueIds);
		const result: Record<string, ArchiveGalleryRecoveryEntry> = {};
		for (let offset = 0; offset < uniqueIds.length; offset += 500) {
			const batch = uniqueIds.slice(offset, offset + 500);
			if (batch.length === 0) continue;
			const placeholders = batch.map(() => "?").join(", ");
			const rows = this.db
				.prepare(
					`SELECT * FROM archive_gallery_recovery_state
					 WHERE gallery_id IN (${placeholders})`,
				)
				.all(...batch) as unknown as ArchiveGalleryRecoveryStateRow[];
			for (const row of rows) {
				const metadata = metadataByGalleryId[row.gallery_id];
				result[row.gallery_id] = {
					galleryId: row.gallery_id,
					canonicalGalleryId:
						metadata?.canonicalGalleryId ??
						row.canonical_gallery_id ??
						undefined,
					status:
						metadata?.sourceKind === "ehentai-api"
							? metadata.expunged
								? "expunged"
								: "official"
							: row.status,
					reasonCode: row.reason_code ?? undefined,
					error: row.last_error ?? undefined,
					hasToken: Boolean(metadata?.token ?? row.token),
					searchAttemptCount: row.search_attempt_count,
					metadataAttemptCount: row.metadata_attempt_count,
					updatedAt: row.updated_at,
					metadata,
				};
			}
		}
		for (const galleryId of uniqueIds) {
			if (result[galleryId]) continue;
			const metadata = metadataByGalleryId[galleryId];
			if (!metadata) continue;
			result[galleryId] = {
				galleryId,
				canonicalGalleryId: metadata.canonicalGalleryId,
				status:
					metadata.sourceKind === "ehentai-api"
						? metadata.expunged
							? "expunged"
							: "official"
						: "catalog-only",
				hasToken: Boolean(metadata.token),
				searchAttemptCount: 0,
				metadataAttemptCount: 0,
				updatedAt: metadata.fetchedAt,
				metadata,
			};
		}
		return result;
	}

	public retryArchiveMetadataRecoveryUnresolved(): ArchiveMetadataRecoverySnapshot {
		this.assertArchiveMetadataRecoveryCanStart();
		const latestJob = this.getLatestArchiveMetadataRecoveryJob();
		if (!latestJob) throw new Error("재시도할 보관분 복구 작업이 없습니다.");
		if (latestJob?.status === "paused") {
			throw new Error("일시 중단된 보관분 복구 작업을 먼저 재개해주세요.");
		}
		const rows = this.db
			.prepare(
				`SELECT gallery_id, representative_path
				 FROM archive_metadata_recovery_items
				 WHERE job_id = ?
				   AND status IN ('unresolved', 'token-not-found', 'access-denied', 'failed')`,
			)
			.all(latestJob.id) as unknown as Array<{
			gallery_id: string;
			representative_path: string | null;
		}>;
		if (rows.length === 0) throw new Error("재시도할 미복구 항목이 없습니다.");
		const snapshot = this.createArchiveMetadataRecoveryJob(
			"retry",
			latestJob.scope_path,
			"catalog",
		);
		this.insertArchiveRecoveryCandidates(
			snapshot.jobId ?? -1,
			new Map(
				rows.map((row) => [row.gallery_id, row.representative_path ?? ""]),
			),
			50,
		);
		this.beginArchiveMetadataRecovery(snapshot.jobId ?? -1);
		return this.getArchiveMetadataRecoveryStatus();
	}

	public resumeArchiveMetadataRecovery(): ArchiveMetadataRecoverySnapshot {
		this.assertArchiveMetadataRecoveryCanStart();
		const job = this.getLatestArchiveMetadataRecoveryJob();
		if (!job || job.status !== "paused") {
			throw new Error("재개할 보관분 복구 작업이 없습니다.");
		}
		const updatedAt = new Date().toISOString();
		this.db
			.prepare(
				`UPDATE archive_metadata_recovery_jobs
				 SET status = 'running', updated_at = ?, finished_at = NULL,
				     last_error = NULL
				 WHERE id = ?`,
			)
			.run(updatedAt, job.id);
		this.beginArchiveMetadataRecovery(job.id);
		return this.getArchiveMetadataRecoveryStatus();
	}

	public pauseArchiveMetadataRecovery(): ArchiveMetadataRecoverySnapshot {
		if (!this.currentArchiveRecoveryPromise) {
			return this.getArchiveMetadataRecoveryStatus();
		}
		this.isArchiveRecoveryPausing = true;
		this.archiveRecoveryAbortController?.abort(
			new DOMException("archive-metadata-recovery-pause", "AbortError"),
		);
		return this.getArchiveMetadataRecoveryStatus();
	}

	public getArchiveMetadataRecoveryStatus(): ArchiveMetadataRecoverySnapshot {
		const job = this.getLatestArchiveMetadataRecoveryJob();
		return job
			? this.mapArchiveMetadataRecoveryJobRow(job)
			: this.createIdleArchiveMetadataRecoveryStatus();
	}

	public listArchiveMetadataRecoveryFailures(
		limit = 50,
	): ArchiveMetadataRecoveryFailure[] {
		const job = this.getLatestArchiveMetadataRecoveryJob();
		if (!job) return [];
		const normalizedLimit = Math.min(
			Math.max(Number.isFinite(limit) ? Math.floor(limit) : 50, 1),
			200,
		);
		const rows = this.db
			.prepare(
				`SELECT gallery_id, status, last_phase, search_attempt_count,
				        metadata_attempt_count, last_error, updated_at
				 FROM archive_metadata_recovery_items
				 WHERE job_id = ?
				   AND status IN ('access-denied', 'token-not-found', 'failed')
				 ORDER BY updated_at DESC, CAST(gallery_id AS INTEGER) DESC
				 LIMIT ?`,
			)
			.all(job.id, normalizedLimit) as unknown as Array<{
			gallery_id: string;
			status: "access-denied" | "token-not-found" | "failed";
			last_phase: ArchiveMetadataRecoveryPhase;
			search_attempt_count: number;
			metadata_attempt_count: number;
			last_error: string | null;
			updated_at: string;
		}>;
		return rows.map((row) => ({
			galleryId: row.gallery_id,
			status: row.status,
			phase: row.last_phase,
			attemptCount: row.search_attempt_count + row.metadata_attempt_count,
			error:
				row.last_error ??
				(row.status === "token-not-found"
					? "Hitomi 로컬 카탈로그에서 gallery id를 찾지 못했습니다."
					: row.status === "access-denied"
						? "과거 원격 복구에서 접근할 수 없었던 상태입니다."
						: "알 수 없는 오류"),
			updatedAt: row.updated_at,
		}));
	}

	public listItems(options?: CrawlItemListOptions): CrawlItem[] {
		const clauses = ["1 = 1"];
		const params: Array<string | number> = [];
		const query = options?.query?.trim();
		const type = options?.type?.trim();
		const limit = this.normalizeDbListLimit(options?.limit);

		if (query) {
			clauses.push("(code LIKE ? OR name LIKE ? OR link LIKE ?)");
			const likeQuery = `%${query}%`;
			params.push(likeQuery, likeQuery, likeQuery);
		}

		if (type) {
			clauses.push("type = ?");
			params.push(type);
		}

		params.push(limit);

		const rows = this.db
			.prepare(
				`
					SELECT
						code,
						target_url,
						type,
						name,
						link,
						source_cursor,
						created_run_id,
						discovered_at
					FROM crawl_items
					WHERE ${clauses.join(" AND ")}
					ORDER BY discovered_at DESC, rowid DESC
					LIMIT ?
				`,
			)
			.all(...params) as unknown as CrawlItemRow[];

		return rows.map((row) => this.mapItemRow(row));
	}

	public createItem(input: CrawlItemMutationInput): CrawlItem {
		this.assertDatabaseWritable();
		const payload = this.normalizeMutationInput(input);
		const existing = this.getItemRow(payload.code);
		if (existing) {
			throw new Error("같은 코드의 크롤링 항목이 이미 존재합니다.");
		}

		const manualRunId = this.getOrCreateManualRunId();
		this.db
			.prepare(
				`
					INSERT INTO crawl_items (
						code,
						target_url,
						type,
						name,
						link,
						source_cursor,
						created_run_id,
						discovered_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`,
			)
			.run(
				payload.code,
				CRAWLER_TARGET_URL,
				payload.type,
				payload.name,
				payload.link,
				payload.sourceCursor,
				manualRunId,
				payload.discoveredAt,
			);

		this.syncRunItemCounters(manualRunId);
		const created = this.getItemRow(payload.code);
		if (!created) {
			throw new Error("DB 항목 생성 후 조회에 실패했습니다.");
		}

		return this.mapItemRow(created);
	}

	public updateItem(
		originalCode: string,
		input: CrawlItemMutationInput,
	): CrawlItem {
		this.assertDatabaseWritable();
		const existing = this.getItemRow(originalCode);
		if (!existing) {
			throw new Error("수정할 크롤링 항목을 찾을 수 없습니다.");
		}

		const payload = this.normalizeMutationInput(input);
		if (payload.code !== originalCode && this.getItemRow(payload.code)) {
			throw new Error("변경하려는 코드가 이미 다른 항목에서 사용 중입니다.");
		}

		this.db
			.prepare(
				`
					UPDATE crawl_items
					SET
						code = ?,
						target_url = ?,
						type = ?,
						name = ?,
						link = ?,
						source_cursor = ?,
						discovered_at = ?
					WHERE code = ?
				`,
			)
			.run(
				payload.code,
				CRAWLER_TARGET_URL,
				payload.type,
				payload.name,
				payload.link,
				payload.sourceCursor,
				payload.discoveredAt,
				originalCode,
			);

		if (payload.code !== originalCode || payload.link !== existing.link) {
			this.db
				.prepare("DELETE FROM crawl_item_metadata WHERE gallery_id = ?")
				.run(payload.code);
		}

		const updated = this.getItemRow(payload.code);
		if (!updated) {
			throw new Error("DB 항목 수정 후 조회에 실패했습니다.");
		}

		return this.mapItemRow(updated);
	}

	public deleteItem(code: string): void {
		this.assertDatabaseWritable();
		const existing = this.getItemRow(code);
		if (!existing) {
			throw new Error("삭제할 크롤링 항목을 찾을 수 없습니다.");
		}

		this.db.prepare("DELETE FROM crawl_items WHERE code = ?").run(code);

		if (this.isManualRun(existing.created_run_id)) {
			this.syncRunItemCounters(existing.created_run_id);
		}
	}

	public resetDatabase(): CrawlDatabaseResetResult {
		this.assertDatabaseWritable();
		const itemCount = this.db
			.prepare("SELECT COUNT(*) AS count FROM crawl_items")
			.get() as { count: number };
		const runCount = this.db
			.prepare("SELECT COUNT(*) AS count FROM crawl_runs")
			.get() as { count: number };
		const stateCount = this.db
			.prepare("SELECT COUNT(*) AS count FROM crawl_state")
			.get() as { count: number };

		clearCrawlerDatabaseContent(this.db);

		const now = new Date().toISOString();
		this.db
			.prepare(
				`
					INSERT INTO crawl_state (
						target_url,
						resume_cursor,
						default_max_pages,
						last_run_id,
						updated_at
					) VALUES (?, NULL, ?, NULL, ?)
				`,
			)
			.run(CRAWLER_TARGET_URL, DEFAULT_CRAWL_MAX_PAGES, now);

		this.currentStatus = this.createIdleStatus({
			maxPages: DEFAULT_CRAWL_MAX_PAGES,
		});

		return {
			itemCount: itemCount.count,
			runCount: runCount.count,
			stateCount: stateCount.count,
		};
	}

	private async runCrawl(runId: number, maxPages: number): Promise<void> {
		const seenCodes = new Set<string>();
		let pagesVisited = 0;
		let itemsSeen = 0;
		let newItems = 0;
		let duplicateItems = 0;
		let skippedItems = 0;
		let metadataRequested = 0;
		let metadataUpdated = 0;
		let metadataFailed = 0;
		let finalStatus: Exclude<CrawlRunStatus, "idle" | "running"> = "failed";

		try {
			const result = await this.runPhase({
				runId,
				phase: "front",
				startCursor: null,
				maxPages,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
				seenCodes,
			});

			pagesVisited = result.pagesVisited;
			itemsSeen = result.itemsSeen;
			newItems = result.newItems;
			duplicateItems = result.duplicateItems;
			skippedItems = result.skippedItems;
			metadataRequested = result.metadataRequested;
			metadataUpdated = result.metadataUpdated;
			metadataFailed = result.metadataFailed;
			finalStatus = result.outcome === "partial" ? "partial" : "completed";

			await this.finishRun({
				runId,
				status: finalStatus,
				maxPages,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
				lastError: null,
			});
		} catch (error) {
			const wasAborted = this.isAbortError(error);
			const errorMessage = this.toErrorMessage(error);
			finalStatus = wasAborted ? "cancelled" : "failed";
			if (this.currentStatus?.runId === runId) {
				pagesVisited = this.currentStatus.pagesVisited;
				itemsSeen = this.currentStatus.itemsSeen;
				newItems = this.currentStatus.newItems;
				duplicateItems = this.currentStatus.duplicateItems;
				skippedItems = this.currentStatus.skippedItems;
				metadataRequested = this.currentStatus.metadataRequested;
				metadataUpdated = this.currentStatus.metadataUpdated;
				metadataFailed = this.currentStatus.metadataFailed;
			}

			await this.finishRun({
				runId,
				status: finalStatus,
				maxPages,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
				lastError: wasAborted ? null : errorMessage,
			});
		}

		if (finalStatus !== "completed" && finalStatus !== "partial") {
			return;
		}

		try {
			await this.dispatchDownloads(runId, ["pending"]);
		} catch (error) {
			console.error("Hitomi Downloader 자동 전송 실패:", error);
			this.markDownloadDispatchFailed(
				runId,
				["pending"],
				this.toErrorMessage(error),
			);
		}
	}

	private async runPhase(params: {
		runId: number;
		phase: Exclude<CrawlPhase, "idle">;
		startCursor: string | null;
		maxPages: number;
		pagesVisited: number;
		itemsSeen: number;
		newItems: number;
		duplicateItems: number;
		skippedItems: number;
		metadataRequested: number;
		metadataUpdated: number;
		metadataFailed: number;
		seenCodes: Set<string>;
	}): Promise<{
		outcome: "completed" | "partial";
		pagesVisited: number;
		itemsSeen: number;
		newItems: number;
		duplicateItems: number;
		skippedItems: number;
		metadataRequested: number;
		metadataUpdated: number;
		metadataFailed: number;
		currentCursor: string | null;
	}> {
		let currentCursor = params.startCursor;
		let pagesVisited = params.pagesVisited;
		let itemsSeen = params.itemsSeen;
		let newItems = params.newItems;
		let duplicateItems = params.duplicateItems;
		let skippedItems = params.skippedItems;
		let metadataRequested = params.metadataRequested;
		let metadataUpdated = params.metadataUpdated;
		let metadataFailed = params.metadataFailed;

		while (pagesVisited < params.maxPages) {
			this.throwIfStopped();
			this.updateCurrentStatus({
				phase: params.phase,
				currentCursor,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
			});

			const page = await this.fetchPage(
				currentCursor,
				this.abortController?.signal,
			);
			const pageStats = this.persistPageItems(
				params.runId,
				currentCursor,
				page.items,
				params.seenCodes,
			);
			pagesVisited += 1;
			itemsSeen += page.items.length;
			newItems += pageStats.newItems;
			duplicateItems += pageStats.duplicateItems;
			skippedItems += page.skippedCount;
			this.persistRunProgress({
				runId: params.runId,
				phase: params.phase,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
			});
			this.updateCurrentStatus({
				phase: params.phase,
				currentCursor,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
			});

			const metadataStats = await this.collectAndPersistGalleryMetadata(
				pageStats.newItemList,
				this.abortController?.signal,
			);
			metadataRequested += metadataStats.requested;
			metadataUpdated += metadataStats.updated;
			metadataFailed += metadataStats.failed;

			this.persistRunProgress({
				runId: params.runId,
				phase: params.phase,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
			});

			this.updateCurrentStatus({
				phase: params.phase,
				currentCursor,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
				metadataRequested,
				metadataUpdated,
				metadataFailed,
			});

			if (pageStats.newItems === 0) {
				return {
					outcome: "completed",
					pagesVisited,
					itemsSeen,
					newItems,
					duplicateItems,
					skippedItems,
					metadataRequested,
					metadataUpdated,
					metadataFailed,
					currentCursor,
				};
			}

			if (!page.nextCursor) {
				return {
					outcome: "completed",
					pagesVisited,
					itemsSeen,
					newItems,
					duplicateItems,
					skippedItems,
					metadataRequested,
					metadataUpdated,
					metadataFailed,
					currentCursor,
				};
			}

			if (pagesVisited >= params.maxPages) {
				return {
					outcome: "partial",
					pagesVisited,
					itemsSeen,
					newItems,
					duplicateItems,
					skippedItems,
					metadataRequested,
					metadataUpdated,
					metadataFailed,
					currentCursor,
				};
			}

			currentCursor = page.nextCursor;
		}

		return {
			outcome: "partial",
			pagesVisited,
			itemsSeen,
			newItems,
			duplicateItems,
			skippedItems,
			metadataRequested,
			metadataUpdated,
			metadataFailed,
			currentCursor,
		};
	}

	private persistPageItems(
		runId: number,
		sourceCursor: string | null,
		items: ParsedPageItem[],
		seenCodes: Set<string>,
	): {
		newItems: number;
		duplicateItems: number;
		newItemList: ParsedPageItem[];
	} {
		let newItems = 0;
		let duplicateItems = 0;
		const newItemList: ParsedPageItem[] = [];
		const discoveredAt = new Date().toISOString();
		const insertItem = this.db.prepare(
			`
				INSERT INTO crawl_items (
					code,
					target_url,
					type,
					name,
					link,
					source_cursor,
					created_run_id,
					discovered_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`,
		);
		const findItem = this.db.prepare(
			"SELECT code FROM crawl_items WHERE code = ? LIMIT 1",
		);
		const insertDispatchItem = this.db.prepare(
			`INSERT INTO crawl_download_dispatch_items (
				run_id, gallery_id, status, attempt_count, last_error, updated_at
			 ) VALUES (?, ?, 'pending', 0, NULL, ?)`,
		);

		this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			for (const item of items) {
				if (seenCodes.has(item.code)) {
					duplicateItems += 1;
					continue;
				}

				const existing = findItem.get(item.code) as
					| { code: string }
					| undefined;
				if (existing) {
					seenCodes.add(item.code);
					duplicateItems += 1;
					continue;
				}

				insertItem.run(
					item.code,
					CRAWLER_TARGET_URL,
					item.type,
					item.name,
					item.link,
					sourceCursor,
					runId,
					discoveredAt,
				);
				insertDispatchItem.run(runId, item.code, discoveredAt);
				seenCodes.add(item.code);
				newItems += 1;
				newItemList.push(item);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}

		return { newItems, duplicateItems, newItemList };
	}

	private async collectAndPersistGalleryMetadata(
		items: ParsedPageItem[],
		signal?: AbortSignal,
	): Promise<GalleryMetadataPageStats> {
		return await collectAndPersistCrawlerGalleryMetadata({
			database: this.db,
			items,
			fetchBatch: (identities, batchSignal) =>
				this.fetchGalleryMetadataBatch(identities, batchSignal),
			signal,
			isAbortError: (error) => this.isAbortError(error),
			onBatchError: (error) =>
				console.warn("E-Hentai 메타데이터 수집 실패:", error),
		});
	}

	private async fetchGalleryMetadataBatch(
		identities: GalleryIdentity[],
		signal?: AbortSignal,
	): Promise<GalleryMetadataBatchResult> {
		return await executeRetryableRequest({
			maxRetryCount: MAX_RETRY_COUNT,
			signal,
			request: async () => {
				await this.waitForMetadataRequestWindow(signal);
				const response = await this.fetchJson(
					new URL(GALLERY_METADATA_API_URL),
					createGalleryMetadataRequestPayload(identities),
					signal,
				);
				if (isRetryableHttpStatusCode(response.statusCode)) {
					throw new RetryableFetchError(
						`메타데이터 요청이 일시적으로 실패했습니다. (${response.statusCode})`,
						{ statusCode: response.statusCode },
					);
				}
				if (response.statusCode < 200 || response.statusCode >= 300) {
					throw new Error(
						`메타데이터 요청에 실패했습니다. (${response.statusCode})`,
					);
				}
				const payload = JSON.parse(response.body) as { gmetadata?: unknown };
				return mapGalleryMetadataBatchResponse(
					Array.isArray(payload.gmetadata) ? payload.gmetadata : [],
					identities,
					new Date().toISOString(),
				);
			},
			shouldRetry: (error) => error instanceof RetryableFetchError,
			waitBeforeRetry: async () => {
				await this.delayRandom(RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS, signal);
			},
		});
	}

	private async waitForMetadataRequestWindow(
		signal?: AbortSignal,
	): Promise<void> {
		if (this.metadataBatchesInWindow >= GALLERY_METADATA_BATCHES_PER_WINDOW) {
			await this.delay(GALLERY_METADATA_COOLDOWN_MS, signal);
			this.metadataBatchesInWindow = 0;
		}
		this.metadataBatchesInWindow += 1;
	}

	private async fetchJson(
		url: URL,
		body: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CrawlerHttpResponse> {
		return await new Promise<CrawlerHttpResponse>((resolve, reject) => {
			const request = net.request({ method: "POST", url: url.toString() });
			let settled = false;
			const cleanup = () => signal?.removeEventListener("abort", handleAbort);
			const resolveOnce = (response: CrawlerHttpResponse) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(response);
			};
			const rejectOnce = (error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			};
			const handleAbort = () => {
				request.abort();
				rejectOnce(
					signal?.reason ?? new DOMException("manual-stop", "AbortError"),
				);
			};
			if (signal?.aborted) {
				handleAbort();
				return;
			}
			signal?.addEventListener("abort", handleAbort, { once: true });
			request.setHeader("Accept", "application/json");
			request.setHeader("Content-Type", "application/json");
			request.on("response", (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
				response.on("end", () =>
					resolveOnce({
						statusCode: response.statusCode,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
				response.on("error", (error) =>
					rejectOnce(this.createRetryableNetworkError(error)),
				);
			});
			request.on("error", (error) =>
				rejectOnce(this.createRetryableNetworkError(error)),
			);
			request.write(JSON.stringify(body));
			request.end();
		});
	}

	private async lookupHitomiCatalogMetadata(
		galleryIds: Iterable<string>,
		signal?: AbortSignal,
	): Promise<Map<string, GallerySourceMetadata>> {
		const settings = await loadSettings();
		const catalogPath = getHitomiCatalogPath(settings.hitomiDownloaderPath);
		if (!catalogPath)
			throw new Error("Hitomi Downloader 경로가 설정되지 않았습니다.");
		return await this.hitomiCatalogIndex.lookup(
			catalogPath,
			galleryIds,
			new Date().toISOString(),
			signal,
		);
	}

	private assertMetadataBackfillCanStart(): void {
		if (this.currentRunPromise) {
			throw new Error("일반 크롤링이 진행 중입니다.");
		}
		if (this.currentBackfillPromise) {
			throw new Error("원천 메타데이터 백필이 이미 진행 중입니다.");
		}
		if (this.currentArchiveRecoveryPromise) {
			throw new Error("보관분 메타데이터 복구가 진행 중입니다.");
		}
	}

	private createAndStartMetadataBackfill(
		targetGalleryIds?: ReadonlySet<string>,
	): MetadataBackfillSnapshot {
		const coverage = this.getMetadataCoverage(targetGalleryIds);
		const now = new Date().toISOString();
		const status: MetadataBackfillStatus =
			coverage.missingGalleryIds.length > 0 ? "running" : "completed";
		let jobId: number;

		this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			const jobResult = this.db
				.prepare(
					`INSERT INTO crawl_metadata_backfill_jobs (
						status, total_count, processed_count, updated_count,
						failed_count, retry_count, remaining_count, already_present_count,
						invalid_link_count, started_at, updated_at, finished_at,
						last_error
					) VALUES (?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, NULL)`,
				)
				.run(
					status,
					coverage.missingGalleryIds.length,
					coverage.missingGalleryIds.length,
					coverage.metadataCount,
					coverage.invalidLinkCount,
					now,
					now,
					status === "completed" ? now : null,
				);
			jobId = Number(jobResult.lastInsertRowid);
			const insertItem = this.db.prepare(
				`INSERT INTO crawl_metadata_backfill_items (
					job_id, gallery_id, status, attempt_count, last_error, updated_at
				) VALUES (?, ?, 'pending', 0, NULL, ?)`,
			);
			for (const galleryId of coverage.missingGalleryIds) {
				insertItem.run(jobId, galleryId, now);
			}

			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		if (status === "running") {
			this.beginMetadataBackfill(jobId);
		}

		return this.getMetadataBackfillStatus();
	}

	private beginMetadataBackfill(jobId: number): void {
		this.isBackfillPausing = false;
		this.backfillAbortController = new AbortController();
		this.currentBackfillPromise = this.runMetadataBackfill(
			jobId,
			this.backfillAbortController.signal,
		)
			.catch((error) => {
				console.error("원천 메타데이터 백필 실패:", error);
			})
			.finally(() => {
				this.currentBackfillPromise = null;
				this.backfillAbortController = null;
				this.isBackfillPausing = false;
			});
	}

	private async runMetadataBackfill(
		jobId: number,
		signal: AbortSignal,
	): Promise<void> {
		try {
			while (true) {
				this.throwIfSignalAborted(signal);
				const pendingItems = this.getPendingMetadataBackfillItems(jobId);
				if (pendingItems.length === 0) {
					this.completeMetadataBackfill(jobId);
					return;
				}

				this.throwIfSignalAborted(signal);
				try {
					const galleryIds = pendingItems.map((item) => item.gallery_id);
					const metadata = await this.lookupHitomiCatalogMetadata(
						galleryIds,
						signal,
					);
					this.persistArchiveMetadataItems([...metadata.values()]);
					this.persistMetadataBackfillOutcomes(
						jobId,
						galleryIds.map((galleryId) => ({
							galleryId,
							status: metadata.has(galleryId) ? "succeeded" : "failed",
							error: metadata.has(galleryId)
								? null
								: "Hitomi 로컬 카탈로그에 해당 gallery id가 없습니다.",
						})),
						true,
					);
				} catch (error) {
					if (this.isAbortError(error)) {
						throw error;
					}
					const message = this.getErrorMessage(error);
					this.persistMetadataBackfillOutcomes(
						jobId,
						pendingItems.map((item) => ({
							galleryId: item.gallery_id,
							status: "failed",
							error: message,
						})),
						true,
					);
				}
			}
		} catch (error) {
			const pausedAt = new Date().toISOString();
			const wasAborted = this.isAbortError(error);
			this.db
				.prepare(
					`UPDATE crawl_metadata_backfill_jobs
					 SET status = 'paused', updated_at = ?, finished_at = NULL,
					     last_error = ?
					 WHERE id = ?`,
				)
				.run(
					pausedAt,
					wasAborted
						? "사용자가 백필 작업을 일시 중단했습니다."
						: this.getErrorMessage(error),
					jobId,
				);
		}
	}

	private getPendingMetadataBackfillItems(
		jobId: number,
	): MetadataBackfillItemRow[] {
		return this.db
			.prepare(
				`SELECT gallery_id, attempt_count
				 FROM crawl_metadata_backfill_items
				 WHERE job_id = ? AND status = 'pending'
				 ORDER BY CAST(gallery_id AS INTEGER) ASC
				 LIMIT ?`,
			)
			.all(jobId, 500) as unknown as MetadataBackfillItemRow[];
	}

	private persistMetadataBackfillOutcomes(
		jobId: number,
		outcomes: Array<{
			galleryId: string;
			status: "succeeded" | "failed";
			error: string | null;
		}>,
		incrementAttempt: boolean,
	): void {
		this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			const updatedAt = new Date().toISOString();
			const updateItem = this.db.prepare(
				`UPDATE crawl_metadata_backfill_items
				 SET status = ?,
				     attempt_count = attempt_count + ?,
				     last_error = ?, updated_at = ?
				 WHERE job_id = ? AND gallery_id = ? AND status = 'pending'`,
			);
			for (const outcome of outcomes) {
				updateItem.run(
					outcome.status,
					incrementAttempt ? 1 : 0,
					outcome.error,
					updatedAt,
					jobId,
					outcome.galleryId,
				);
			}
			this.syncMetadataBackfillCounters(jobId, updatedAt);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private syncMetadataBackfillCounters(jobId: number, updatedAt: string): void {
		const counts = this.db
			.prepare(
				`SELECT
					SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS updated_count,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
					SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS remaining_count
				 FROM crawl_metadata_backfill_items
				 WHERE job_id = ?`,
			)
			.get(jobId) as {
			updated_count: number | null;
			failed_count: number | null;
			remaining_count: number | null;
		};
		const updatedCount = counts.updated_count ?? 0;
		const failedCount = counts.failed_count ?? 0;
		this.db
			.prepare(
				`UPDATE crawl_metadata_backfill_jobs
				 SET processed_count = ?, updated_count = ?, failed_count = ?,
				     remaining_count = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				updatedCount + failedCount,
				updatedCount,
				failedCount,
				counts.remaining_count ?? 0,
				updatedAt,
				jobId,
			);
	}

	private completeMetadataBackfill(jobId: number): void {
		const job = this.getMetadataBackfillJob(jobId);
		if (!job) {
			throw new Error("완료할 백필 작업을 찾지 못했습니다.");
		}

		const finishedAt = new Date().toISOString();
		const status: MetadataBackfillStatus =
			job.failed_count > 0 ? "completed_with_errors" : "completed";
		this.db
			.prepare(
				`UPDATE crawl_metadata_backfill_jobs
				 SET status = ?, updated_at = ?, finished_at = ?, last_error = ?
				 WHERE id = ?`,
			)
			.run(
				status,
				finishedAt,
				finishedAt,
				job.failed_count > 0
					? `${job.failed_count}개 항목의 메타데이터를 수집하지 못했습니다.`
					: null,
				jobId,
			);
	}

	private getMetadataCoverage(
		targetGalleryIds?: ReadonlySet<string>,
	): MetadataCoverage {
		const rows = this.db
			.prepare(
				`SELECT item.code,
				        CASE WHEN official.gallery_id IS NOT NULL OR catalog.gallery_id IS NOT NULL
				             THEN 1 ELSE 0 END AS has_metadata
				 FROM crawl_items AS item
				 LEFT JOIN crawl_item_metadata AS official
				   ON official.gallery_id = item.code
				 LEFT JOIN archive_gallery_metadata AS catalog
				   ON catalog.gallery_id = item.code`,
			)
			.all() as unknown as Array<{
			code: string;
			has_metadata: number;
		}>;
		const filtered = targetGalleryIds
			? rows.filter((row) => targetGalleryIds.has(row.code))
			: rows;
		return {
			metadataCount: filtered.filter((row) => row.has_metadata === 1).length,
			missingGalleryIds: filtered
				.filter((row) => row.has_metadata !== 1)
				.map((row) => row.code),
			invalidLinkCount: 0,
		};
	}

	private getLatestMetadataBackfillJob(): MetadataBackfillJobRow | null {
		const row = this.db
			.prepare(
				"SELECT * FROM crawl_metadata_backfill_jobs ORDER BY id DESC LIMIT 1",
			)
			.get() as MetadataBackfillJobRow | undefined;
		return row ?? null;
	}

	private getMetadataBackfillJob(jobId: number): MetadataBackfillJobRow | null {
		const row = this.db
			.prepare("SELECT * FROM crawl_metadata_backfill_jobs WHERE id = ?")
			.get(jobId) as MetadataBackfillJobRow | undefined;
		return row ?? null;
	}

	private mapMetadataBackfillJobRow(
		row: MetadataBackfillJobRow,
	): MetadataBackfillSnapshot {
		return {
			jobId: row.id,
			status: row.status,
			totalCount: row.total_count,
			processedCount: row.processed_count,
			updatedCount: row.updated_count,
			failedCount: row.failed_count,
			retryCount: row.retry_count,
			remainingCount: row.remaining_count,
			alreadyPresentCount: row.already_present_count,
			invalidLinkCount: row.invalid_link_count,
			startedAt: row.started_at,
			updatedAt: row.updated_at,
			finishedAt: row.finished_at,
			lastError: row.last_error,
			isPausing: row.status === "running" && this.isBackfillPausing,
		};
	}

	private createIdleMetadataBackfillStatus(): MetadataBackfillSnapshot {
		return {
			jobId: null,
			status: "idle",
			totalCount: 0,
			processedCount: 0,
			updatedCount: 0,
			failedCount: 0,
			retryCount: 0,
			remainingCount: 0,
			alreadyPresentCount: 0,
			invalidLinkCount: 0,
			startedAt: null,
			updatedAt: null,
			finishedAt: null,
			lastError: null,
			isPausing: false,
		};
	}

	private assertArchiveMetadataRecoveryCanStart(): void {
		if (this.currentRunPromise) {
			throw new Error("일반 크롤링이 진행 중입니다.");
		}
		if (this.currentBackfillPromise) {
			throw new Error("원천 메타데이터 백필이 진행 중입니다.");
		}
		if (this.currentArchiveRecoveryPromise) {
			throw new Error("보관분 메타데이터 복구가 이미 진행 중입니다.");
		}
	}

	private createArchiveMetadataRecoveryJob(
		scope: ArchiveMetadataRecoveryScope,
		scopePath: string | null,
		phase: ArchiveMetadataRecoveryPhase,
	): ArchiveMetadataRecoverySnapshot {
		const now = new Date().toISOString();
		this.db
			.prepare(
				`INSERT INTO archive_metadata_recovery_jobs (
					status, phase, scope_kind, scope_path,
					total_count, processed_count, official_count,
					catalog_count, unresolved_count, failed_count, remaining_count,
					started_at, updated_at, finished_at, last_error
				) VALUES ('running', ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, NULL, NULL)`,
			)
			.run(phase, scope, scopePath, now, now);
		return this.getArchiveMetadataRecoveryStatus();
	}

	private createAndStartArchiveMetadataRecovery(
		scope: ArchiveMetadataRecoveryScope,
		scopePath: string | null,
		phase: ArchiveMetadataRecoveryPhase,
	): ArchiveMetadataRecoverySnapshot {
		const snapshot = this.createArchiveMetadataRecoveryJob(
			scope,
			scopePath,
			phase,
		);
		if (snapshot.jobId) this.beginArchiveMetadataRecovery(snapshot.jobId);
		return snapshot;
	}

	private beginArchiveMetadataRecovery(jobId: number): void {
		this.archiveRecoveryAbortController = new AbortController();
		this.isArchiveRecoveryPausing = false;
		this.currentArchiveRecoveryPromise = this.runArchiveMetadataRecovery(
			jobId,
			this.archiveRecoveryAbortController.signal,
		).finally(() => {
			this.currentArchiveRecoveryPromise = null;
			this.archiveRecoveryAbortController = null;
			this.isArchiveRecoveryPausing = false;
		});
	}

	private async runArchiveMetadataRecovery(
		jobId: number,
		signal: AbortSignal,
	): Promise<void> {
		try {
			let job = this.getArchiveMetadataRecoveryJob(jobId);
			if (!job) return;

			if (job.phase === "indexing") {
				await this.prepareArchiveMetadataRecoveryItems(jobId, signal);
				this.setArchiveMetadataRecoveryPhase(jobId, "catalog");
				job = this.getArchiveMetadataRecoveryJob(jobId);
				if (!job || job.total_count === 0) {
					this.completeArchiveMetadataRecovery(jobId);
					return;
				}
			}

			if (job?.phase === "catalog") {
				await this.importArchiveCatalogMetadata(jobId, signal);
			}

			this.completeArchiveMetadataRecovery(jobId);
		} catch (error) {
			const now = new Date().toISOString();
			if (this.isAbortError(error)) {
				this.syncArchiveMetadataRecoveryCounters(jobId);
				this.db
					.prepare(
						`UPDATE archive_metadata_recovery_jobs
						 SET status = 'paused', updated_at = ?, finished_at = NULL,
						     last_error = ?
						 WHERE id = ?`,
					)
					.run(now, "사용자가 보관분 복구 작업을 일시 중단했습니다.", jobId);
				return;
			}

			this.db
				.prepare(
					`UPDATE archive_metadata_recovery_jobs
					 SET status = 'completed_with_errors', updated_at = ?, finished_at = ?,
					     last_error = ?
					 WHERE id = ?`,
				)
				.run(now, now, this.getErrorMessage(error), jobId);
			console.error("보관분 메타데이터 복구 실패:", error);
		}
	}

	private async prepareArchiveMetadataRecoveryItems(
		jobId: number,
		signal: AbortSignal,
	): Promise<void> {
		const job = this.getArchiveMetadataRecoveryJob(jobId);
		if (!job) throw new Error("보관분 복구 작업을 찾지 못했습니다.");
		let sourcePath = job.scope_path?.trim() ?? "";
		if (!sourcePath && job.scope_kind === "legacy-full") {
			const settings = await loadSettings();
			sourcePath = settings.storePath.trim();
		}
		if (!sourcePath) throw new Error("보강할 폴더 경로가 없습니다.");
		const scanResult = await scanArchiveFiles(sourcePath, undefined, signal);
		this.throwIfSignalAborted(signal);
		const candidates = collectArchiveRecoveryCandidates(scanResult.files);
		this.insertArchiveRecoveryCandidates(jobId, candidates, 0);
	}

	private insertArchiveRecoveryCandidates(
		jobId: number,
		candidates: Map<string, string>,
		priority: number,
	): void {
		const now = new Date().toISOString();
		this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			const insertItem = this.db.prepare(
				`INSERT INTO archive_metadata_recovery_items (
					job_id, gallery_id, canonical_gallery_id, token,
					representative_path, priority, status, catalog_found,
					search_completed, search_attempt_count, metadata_attempt_count,
					last_phase, reason_code, last_error, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, NULL, ?)
				ON CONFLICT(job_id, gallery_id) DO UPDATE SET
					representative_path = COALESCE(excluded.representative_path, representative_path),
					priority = MAX(priority, excluded.priority),
					updated_at = excluded.updated_at`,
			);
			const upsertState = this.db.prepare(
				`INSERT INTO archive_gallery_recovery_state (
					gallery_id, canonical_gallery_id, token, status,
					reason_code, last_error, updated_at
				) VALUES (?, ?, ?, 'pending', NULL, NULL, ?)
				ON CONFLICT(gallery_id) DO UPDATE SET
					canonical_gallery_id = COALESCE(excluded.canonical_gallery_id, canonical_gallery_id),
					token = COALESCE(excluded.token, token),
					status = CASE WHEN status IN ('official', 'expunged')
					              THEN status ELSE 'pending' END,
					reason_code = NULL, last_error = NULL, updated_at = excluded.updated_at`,
			);
			for (const [galleryId, representativePath] of candidates) {
				const hasOfficial = this.hasOfficialGalleryMetadata(galleryId);
				const hasCatalog = this.hasArchiveCatalogMetadata(galleryId);
				insertItem.run(
					jobId,
					galleryId,
					null,
					null,
					representativePath || null,
					priority,
					hasOfficial ? "official" : hasCatalog ? "catalog" : "pending",
					hasCatalog ? 1 : 0,
					0,
					"catalog",
					now,
				);
				upsertState.run(galleryId, null, null, now);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		this.syncArchiveMetadataRecoveryCounters(jobId);
	}

	private async importArchiveCatalogMetadata(
		jobId: number,
		signal: AbortSignal,
	): Promise<void> {
		const rows = this.db
			.prepare(
				`SELECT gallery_id FROM archive_metadata_recovery_items
				 WHERE job_id = ? ORDER BY priority DESC, CAST(gallery_id AS INTEGER) DESC`,
			)
			.all(jobId) as unknown as Array<{ gallery_id: string }>;
		const galleryIds = rows.map((row) => row.gallery_id);
		const metadata = await this.lookupHitomiCatalogMetadata(galleryIds, signal);
		persistCatalogMetadataWithOfficialFallback(this.db, [...metadata.values()]);
		const now = new Date().toISOString();
		const updateItem = this.db.prepare(
			`UPDATE archive_metadata_recovery_items
			 SET catalog_found = ?, status = ?, search_completed = 1,
			     last_phase = 'catalog', reason_code = ?, last_error = NULL, updated_at = ?
			 WHERE job_id = ? AND gallery_id = ?`,
		);
		const updateState = this.db.prepare(
			`INSERT INTO archive_gallery_recovery_state (
				gallery_id, status, reason_code, last_error, updated_at
			) VALUES (?, ?, ?, NULL, ?)
			ON CONFLICT(gallery_id) DO UPDATE SET
				status = CASE WHEN status IN ('official', 'expunged')
				              THEN status ELSE excluded.status END,
				reason_code = excluded.reason_code,
				last_error = NULL, updated_at = excluded.updated_at`,
		);
		this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			for (const galleryId of galleryIds) {
				const found = metadata.has(galleryId);
				const hasOfficial = this.hasOfficialGalleryMetadata(galleryId);
				updateItem.run(
					found ? 1 : 0,
					hasOfficial ? "official" : found ? "catalog" : "unresolved",
					hasOfficial || found ? null : "catalog-not-found",
					now,
					jobId,
					galleryId,
				);
				updateState.run(
					galleryId,
					hasOfficial ? "official" : found ? "catalog-only" : "token-not-found",
					hasOfficial || found ? null : "catalog-not-found",
					now,
				);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		this.syncArchiveMetadataRecoveryCounters(jobId);
	}

	private persistArchiveMetadataItems(
		metadataItems: GallerySourceMetadata[],
		manageTransaction = true,
	): void {
		const upsertMetadata = this.db.prepare(`
			INSERT INTO archive_gallery_metadata (
				gallery_id, canonical_gallery_id, token, source_kind, title,
				title_japanese, category, uploader, posted_at, file_count,
				file_size, rating, expunged, parent_gallery_id, parent_token,
				current_gallery_id, current_token, first_gallery_id, first_token,
				fetched_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(gallery_id) DO UPDATE SET
				canonical_gallery_id = excluded.canonical_gallery_id,
				token = excluded.token, source_kind = excluded.source_kind,
				title = excluded.title, title_japanese = excluded.title_japanese,
				category = excluded.category, uploader = excluded.uploader,
				posted_at = excluded.posted_at, file_count = excluded.file_count,
				file_size = excluded.file_size, rating = excluded.rating,
				expunged = excluded.expunged,
				parent_gallery_id = excluded.parent_gallery_id,
				parent_token = excluded.parent_token,
				current_gallery_id = excluded.current_gallery_id,
				current_token = excluded.current_token,
				first_gallery_id = excluded.first_gallery_id,
				first_token = excluded.first_token, fetched_at = excluded.fetched_at
			WHERE archive_gallery_metadata.source_kind <> 'ehentai-api'
			   OR excluded.source_kind = 'ehentai-api'
		`);
		const deleteTags = this.db.prepare(
			"DELETE FROM archive_gallery_tags WHERE gallery_id = ?",
		);
		const insertTag = this.db.prepare(
			`INSERT OR REPLACE INTO archive_gallery_tags
			 (gallery_id, namespace, value, position) VALUES (?, ?, ?, ?)`,
		);
		if (manageTransaction) this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			for (const metadata of metadataItems) {
				const result = upsertMetadata.run(
					metadata.galleryId,
					metadata.canonicalGalleryId ?? metadata.galleryId,
					metadata.token ?? null,
					metadata.sourceKind,
					metadata.title,
					metadata.titleJapanese ?? null,
					metadata.category,
					metadata.uploader ?? null,
					metadata.postedAt ?? null,
					metadata.fileCount ?? null,
					metadata.fileSize ?? null,
					metadata.rating ?? null,
					metadata.expunged === undefined ? null : metadata.expunged ? 1 : 0,
					metadata.parentGalleryId ?? null,
					metadata.parentToken ?? null,
					metadata.currentGalleryId ?? null,
					metadata.currentToken ?? null,
					metadata.firstGalleryId ?? null,
					metadata.firstToken ?? null,
					metadata.fetchedAt,
				);
				if (result.changes === 0) continue;
				deleteTags.run(metadata.galleryId);
				for (const tag of metadata.tags) {
					insertTag.run(
						metadata.galleryId,
						tag.namespace,
						tag.value,
						tag.position,
					);
				}
			}
			if (manageTransaction) this.db.exec("COMMIT");
		} catch (error) {
			if (manageTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private setArchiveMetadataRecoveryPhase(
		jobId: number,
		phase: ArchiveMetadataRecoveryPhase,
	): void {
		this.db
			.prepare(
				`UPDATE archive_metadata_recovery_jobs
				 SET phase = ?, updated_at = ? WHERE id = ?`,
			)
			.run(phase, new Date().toISOString(), jobId);
	}

	private syncArchiveMetadataRecoveryCounters(jobId: number): void {
		const counts = this.db
			.prepare(
				`SELECT
					COUNT(*) AS total_count,
					SUM(CASE WHEN status = 'official' THEN 1 ELSE 0 END) AS official_count,
					SUM(CASE WHEN status = 'catalog' THEN 1 ELSE 0 END) AS catalog_count,
					SUM(CASE WHEN status IN ('unresolved', 'token-not-found') THEN 1 ELSE 0 END) AS unresolved_count,
					SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
					SUM(CASE WHEN status = 'expunged' THEN 1 ELSE 0 END) AS expunged_count,
					SUM(CASE WHEN status = 'access-denied' THEN 1 ELSE 0 END) AS access_denied_count,
					SUM(CASE WHEN status = 'token-not-found' OR reason_code = 'token-not-found' THEN 1 ELSE 0 END) AS token_not_found_count,
					SUM(CASE WHEN search_completed = 0 OR status = 'token' THEN 1 ELSE 0 END) AS remaining_count
				 FROM archive_metadata_recovery_items WHERE job_id = ?`,
			)
			.get(jobId) as Record<string, number | null>;
		const official = counts.official_count ?? 0;
		const total = counts.total_count ?? 0;
		const catalog = counts.catalog_count ?? 0;
		const unresolved = counts.unresolved_count ?? 0;
		const failed = counts.failed_count ?? 0;
		const expunged = counts.expunged_count ?? 0;
		const accessDenied = counts.access_denied_count ?? 0;
		const tokenNotFound = counts.token_not_found_count ?? 0;
		const remaining = counts.remaining_count ?? 0;
		this.db
			.prepare(
				`UPDATE archive_metadata_recovery_jobs
				 SET total_count = ?, processed_count = MAX(? - ?, 0),
				     official_count = ?, catalog_count = ?,
				     unresolved_count = ?, failed_count = ?,
				     expunged_count = ?, access_denied_count = ?,
				     token_not_found_count = ?, remaining_count = ?,
				     updated_at = ? WHERE id = ?`,
			)
			.run(
				total,
				total,
				remaining,
				official,
				catalog,
				unresolved,
				failed,
				expunged,
				accessDenied,
				tokenNotFound,
				remaining,
				new Date().toISOString(),
				jobId,
			);
	}

	private completeArchiveMetadataRecovery(jobId: number): void {
		this.syncArchiveMetadataRecoveryCounters(jobId);
		const job = this.getArchiveMetadataRecoveryJob(jobId);
		if (!job) return;
		const now = new Date().toISOString();
		const status: ArchiveMetadataRecoveryStatus =
			job.failed_count > 0 ? "completed_with_errors" : "completed";
		this.db
			.prepare(
				`UPDATE archive_metadata_recovery_jobs
				 SET status = ?, phase = 'idle', updated_at = ?, finished_at = ?,
				     last_error = ? WHERE id = ?`,
			)
			.run(
				status,
				now,
				now,
				job.failed_count > 0
					? `${job.failed_count}개 항목의 원격 복구에 실패했습니다.`
					: job.last_error,
				jobId,
			);
	}

	private hasOfficialGalleryMetadata(galleryId: string): boolean {
		return Boolean(
			this.db
				.prepare(
					`SELECT 1 FROM (
						SELECT gallery_id FROM crawl_item_metadata WHERE gallery_id = ?
						UNION ALL
						SELECT gallery_id FROM archive_gallery_metadata
						 WHERE gallery_id = ? AND source_kind = 'ehentai-api'
					) LIMIT 1`,
				)
				.get(galleryId, galleryId),
		);
	}

	private hasArchiveCatalogMetadata(galleryId: string): boolean {
		return Boolean(
			this.db
				.prepare(
					`SELECT 1 FROM archive_gallery_metadata
					 WHERE gallery_id = ? AND source_kind = 'hitomi-catalog' LIMIT 1`,
				)
				.get(galleryId),
		);
	}

	private getLatestArchiveMetadataRecoveryJob(): ArchiveMetadataRecoveryJobRow | null {
		return (
			(this.db
				.prepare(
					"SELECT * FROM archive_metadata_recovery_jobs ORDER BY id DESC LIMIT 1",
				)
				.get() as ArchiveMetadataRecoveryJobRow | undefined) ?? null
		);
	}

	private getArchiveMetadataRecoveryJob(
		jobId: number,
	): ArchiveMetadataRecoveryJobRow | null {
		return (
			(this.db
				.prepare("SELECT * FROM archive_metadata_recovery_jobs WHERE id = ?")
				.get(jobId) as ArchiveMetadataRecoveryJobRow | undefined) ?? null
		);
	}

	private mapArchiveMetadataRecoveryJobRow(
		row: ArchiveMetadataRecoveryJobRow,
	): ArchiveMetadataRecoverySnapshot {
		const priorityCount = (
			this.db
				.prepare(
					`SELECT COUNT(*) AS count
					 FROM archive_metadata_recovery_items
					 WHERE job_id = ? AND priority > 0
					   AND (search_completed = 0 OR status = 'token')`,
				)
				.get(row.id) as { count: number }
		).count;
		return {
			jobId: row.id,
			status: row.status,
			phase: row.phase,
			scope: row.scope_kind,
			scopePath: row.scope_path,
			totalCount: row.total_count,
			processedCount: row.processed_count,
			officialCount: row.official_count,
			catalogCount: row.catalog_count,
			unresolvedCount: row.unresolved_count,
			failedCount: row.failed_count,
			expungedCount: row.expunged_count,
			accessDeniedCount: row.access_denied_count,
			tokenNotFoundCount: row.token_not_found_count,
			retryCount: row.retry_count,
			priorityCount,
			remainingCount: row.remaining_count,
			startedAt: row.started_at,
			updatedAt: row.updated_at,
			finishedAt: row.finished_at,
			lastError: row.last_error,
			isPausing: row.status === "running" && this.isArchiveRecoveryPausing,
		};
	}

	private createIdleArchiveMetadataRecoveryStatus(): ArchiveMetadataRecoverySnapshot {
		return {
			jobId: null,
			status: "idle",
			phase: "idle",
			scope: null,
			scopePath: null,
			totalCount: 0,
			processedCount: 0,
			officialCount: 0,
			catalogCount: 0,
			unresolvedCount: 0,
			failedCount: 0,
			expungedCount: 0,
			accessDeniedCount: 0,
			tokenNotFoundCount: 0,
			retryCount: 0,
			priorityCount: 0,
			remainingCount: 0,
			startedAt: null,
			updatedAt: null,
			finishedAt: null,
			lastError: null,
			isPausing: false,
		};
	}

	private throwIfSignalAborted(signal: AbortSignal): void {
		if (signal.aborted) {
			throw signal.reason ?? new DOMException("aborted", "AbortError");
		}
	}

	private getErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private async fetchPage(
		cursor: string | null,
		signal?: AbortSignal,
	): Promise<ParsedPage> {
		const url = new URL(CRAWLER_TARGET_URL);
		if (cursor) {
			url.searchParams.set("next", cursor);
		}

		for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt += 1) {
			await this.delayRandom(BASE_DELAY_MIN_MS, BASE_DELAY_MAX_MS, signal);

			try {
				const response = await this.fetchHtml(url, signal);

				if (isRetryableHttpStatusCode(response.statusCode)) {
					throw new RetryableFetchError(
						`크롤링 요청이 일시적으로 실패했습니다. (${response.statusCode})`,
						{ statusCode: response.statusCode },
					);
				}

				if (response.statusCode < 200 || response.statusCode >= 300) {
					throw new Error(
						`크롤링 요청에 실패했습니다. (${response.statusCode})`,
					);
				}

				return this.parsePage(response.body, cursor);
			} catch (error) {
				if (this.isAbortError(error)) {
					throw error;
				}

				const isRetryable = error instanceof RetryableFetchError;
				if (!isRetryable || attempt === MAX_RETRY_COUNT) {
					throw error;
				}

				await this.delayRandom(RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS, signal);
			}
		}

		throw new Error("알 수 없는 크롤링 오류가 발생했습니다.");
	}

	private async fetchHtml(
		url: URL,
		signal?: AbortSignal,
	): Promise<CrawlerHttpResponse> {
		return await new Promise<CrawlerHttpResponse>((resolve, reject) => {
			const request = net.request({
				method: "GET",
				url: url.toString(),
			});
			let settled = false;

			const cleanup = () => {
				signal?.removeEventListener("abort", handleAbort);
			};

			const resolveOnce = (response: CrawlerHttpResponse) => {
				if (settled) {
					return;
				}

				settled = true;
				cleanup();
				resolve(response);
			};

			const rejectOnce = (error: unknown) => {
				if (settled) {
					return;
				}

				settled = true;
				cleanup();
				reject(error);
			};

			const handleAbort = () => {
				request.abort();
				rejectOnce(
					signal?.reason ?? new DOMException("manual-stop", "AbortError"),
				);
			};

			if (signal?.aborted) {
				handleAbort();
				return;
			}

			signal?.addEventListener("abort", handleAbort, { once: true });

			for (const [name, value] of Object.entries(CRAWLER_REQUEST_HEADERS)) {
				request.setHeader(name, value);
			}

			request.on("response", (response) => {
				const chunks: Buffer[] = [];

				response.on("data", (chunk: Buffer) => {
					chunks.push(Buffer.from(chunk));
				});

				response.on("end", () => {
					resolveOnce({
						statusCode: response.statusCode,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});

				response.on("error", (error) => {
					rejectOnce(this.createRetryableNetworkError(error));
				});
			});

			request.on("error", (error) => {
				rejectOnce(this.createRetryableNetworkError(error));
			});

			request.end();
		});
	}

	private createRetryableNetworkError(error: unknown): RetryableFetchError {
		return new RetryableFetchError("크롤링 요청 연결에 실패했습니다.", {
			cause: error,
		});
	}

	private parsePage(html: string, sourceCursor: string | null): ParsedPage {
		const $ = cheerio.load(html);
		const galleryTable = $("table.itg.gltc").first();
		const candidateRows = galleryTable.find("tbody tr");
		const rows =
			candidateRows.length > 0
				? candidateRows.toArray()
				: galleryTable.find("tr").toArray();

		const items: ParsedPageItem[] = [];
		let skippedCount = 0;

		for (const row of rows.slice(2)) {
			const rowElement = $(row);
			const nameContainer = rowElement.find(".gl3c.glname").first();
			const link = nameContainer.find("a").first().attr("href")?.trim() ?? "";
			const code = link.match(/\/g\/(\d+)\//)?.[1];
			const name = nameContainer.find(".glink").first().text().trim();
			const type = rowElement.find(".gl1c.glcat").first().text().trim();

			if (!link || !code) {
				skippedCount += 1;
				continue;
			}

			items.push({
				code,
				type,
				name,
				link,
				sourceCursor,
			});
		}

		const nextLink = $("#dnext").attr("href") ?? "";
		const nextCursor = nextLink.match(/[?&]next=(\d+)/)?.[1] ?? null;

		return {
			items,
			nextCursor,
			skippedCount,
		};
	}

	private async dispatchDownloads(
		runId: number,
		statuses: DownloadDispatchStatus[],
	): Promise<void> {
		const rows = selectDownloadDispatchRows(this.db, runId, statuses);
		if (rows.length === 0) {
			this.syncDownloadDispatchCounters(runId);
			return;
		}
		const excludedPreferences = this.listTagPreferences().filter(
			(preference) => preference.kind === "excluded",
		);
		const metadataByGalleryId =
			excludedPreferences.length > 0
				? this.getMetadataByGalleryIds(rows.map((row) => row.galleryId))
				: {};
		const excludedRows: Array<{ galleryId: string; tagKey: string }> = [];
		const sendRows = rows.filter((row) => {
			const metadata = metadataByGalleryId[row.galleryId];
			if (!metadata) return true;
			const [matchedPreference] = getMatchingTagPreferences(
				metadata.tags,
				excludedPreferences,
			);
			if (!matchedPreference) return true;
			const tagKey = getTagPreferenceKey(matchedPreference);
			if (!tagKey) return true;
			excludedRows.push({ galleryId: row.galleryId, tagKey });
			return false;
		});
		markDownloadDispatchRowsExcluded(this.db, runId, excludedRows);
		if (sendRows.length === 0) {
			this.syncDownloadDispatchCounters(runId);
			return;
		}

		try {
			const result = await sendCodesToHitomiApi(
				sendRows.map((row) => row.galleryId),
				await loadSettings(),
			);
			applyDownloadDispatchResult(this.db, runId, sendRows, result);
		} catch (error) {
			this.markDownloadDispatchFailed(
				runId,
				statuses,
				this.toErrorMessage(error),
			);
			return;
		}
		this.syncDownloadDispatchCounters(runId);
	}

	private markDownloadDispatchFailed(
		runId: number,
		statuses: DownloadDispatchStatus[],
		errorMessage: string,
	): void {
		markDownloadDispatchRowsFailed(this.db, runId, statuses, errorMessage);
		this.syncDownloadDispatchCounters(runId);
	}

	private syncDownloadDispatchCounters(runId: number): void {
		const summary = getDownloadDispatchSummary(this.db, runId);

		this.db
			.prepare(
				`UPDATE crawl_runs
				 SET download_requested = ?, download_sent = ?,
				     download_invalid = ?, download_failed = ?,
				     download_excluded = ?, download_last_error = ?
				 WHERE id = ?`,
			)
			.run(
				summary.requested,
				summary.sent,
				summary.invalid,
				summary.failed,
				summary.excluded,
				summary.lastError,
				runId,
			);
		if (this.currentStatus?.runId === runId) {
			this.currentStatus = {
				...this.currentStatus,
				downloadRequested: summary.requested,
				downloadSent: summary.sent,
				downloadInvalid: summary.invalid,
				downloadFailed: summary.failed,
				downloadExcluded: summary.excluded,
				downloadLastError: summary.lastError,
			};
		}
	}

	private async finishRun(params: {
		runId: number;
		status: Exclude<CrawlRunStatus, "idle" | "running">;
		maxPages: number;
		pagesVisited: number;
		itemsSeen: number;
		newItems: number;
		duplicateItems: number;
		skippedItems: number;
		metadataRequested: number;
		metadataUpdated: number;
		metadataFailed: number;
		lastError: string | null;
	}): Promise<void> {
		const finishedAt = new Date().toISOString();

		this.db
			.prepare(
				`
					UPDATE crawl_runs
					SET
						status = ?,
						phase = ?,
						max_pages = ?,
						pages_visited = ?,
						items_seen = ?,
						new_items = ?,
						duplicate_items = ?,
						skipped_items = ?,
						metadata_requested = ?,
						metadata_updated = ?,
						metadata_failed = ?,
						resume_cursor_after = NULL,
						finished_at = ?,
						last_error = ?
					WHERE id = ?
				`,
			)
			.run(
				params.status,
				"idle",
				params.maxPages,
				params.pagesVisited,
				params.itemsSeen,
				params.newItems,
				params.duplicateItems,
				params.skippedItems,
				params.metadataRequested,
				params.metadataUpdated,
				params.metadataFailed,
				finishedAt,
				params.lastError,
				params.runId,
			);

		this.db
			.prepare(
				`
					UPDATE crawl_state
					SET
						resume_cursor = NULL,
						last_run_id = ?,
						updated_at = ?
					WHERE target_url = ?
				`,
			)
			.run(params.runId, finishedAt, CRAWLER_TARGET_URL);

		this.currentStatus = {
			status: params.status,
			phase: "idle",
			runId: params.runId,
			targetUrl: CRAWLER_TARGET_URL,
			maxPages: params.maxPages,
			pagesVisited: params.pagesVisited,
			itemsSeen: params.itemsSeen,
			newItems: params.newItems,
			duplicateItems: params.duplicateItems,
			skippedItems: params.skippedItems,
			metadataRequested: params.metadataRequested,
			metadataUpdated: params.metadataUpdated,
			metadataFailed: params.metadataFailed,
			downloadRequested: this.currentStatus?.downloadRequested ?? 0,
			downloadSent: this.currentStatus?.downloadSent ?? 0,
			downloadInvalid: this.currentStatus?.downloadInvalid ?? 0,
			downloadFailed: this.currentStatus?.downloadFailed ?? 0,
			downloadExcluded: this.currentStatus?.downloadExcluded ?? 0,
			downloadLastError: this.currentStatus?.downloadLastError ?? null,
			currentCursor: null,
			startedAt: this.currentStatus?.startedAt ?? finishedAt,
			finishedAt,
			lastError: params.lastError,
			isStopping: false,
		};
	}

	private persistRunProgress(params: {
		runId: number;
		phase: Exclude<CrawlPhase, "idle">;
		pagesVisited: number;
		itemsSeen: number;
		newItems: number;
		duplicateItems: number;
		skippedItems: number;
		metadataRequested: number;
		metadataUpdated: number;
		metadataFailed: number;
	}): void {
		this.db
			.prepare(
				`
					UPDATE crawl_runs
					SET
						status = ?,
						phase = ?,
						pages_visited = ?,
						items_seen = ?,
						new_items = ?,
						duplicate_items = ?,
						skipped_items = ?,
						metadata_requested = ?,
						metadata_updated = ?,
						metadata_failed = ?
					WHERE id = ?
				`,
			)
			.run(
				"running",
				params.phase,
				params.pagesVisited,
				params.itemsSeen,
				params.newItems,
				params.duplicateItems,
				params.skippedItems,
				params.metadataRequested,
				params.metadataUpdated,
				params.metadataFailed,
				params.runId,
			);
	}

	private updateCurrentStatus(params: {
		phase: Exclude<CrawlPhase, "idle">;
		currentCursor: string | null;
		pagesVisited: number;
		itemsSeen: number;
		newItems: number;
		duplicateItems: number;
		skippedItems: number;
		metadataRequested: number;
		metadataUpdated: number;
		metadataFailed: number;
	}): void {
		if (!this.currentStatus) {
			return;
		}

		this.currentStatus = {
			...this.currentStatus,
			status: "running",
			phase: params.phase,
			currentCursor: params.currentCursor,
			pagesVisited: params.pagesVisited,
			itemsSeen: params.itemsSeen,
			newItems: params.newItems,
			duplicateItems: params.duplicateItems,
			skippedItems: params.skippedItems,
			metadataRequested: params.metadataRequested,
			metadataUpdated: params.metadataUpdated,
			metadataFailed: params.metadataFailed,
		};
	}

	private getOrCreateState(): CrawlStateRow {
		const existing = this.db
			.prepare("SELECT * FROM crawl_state WHERE target_url = ?")
			.get(CRAWLER_TARGET_URL) as CrawlStateRow | undefined;

		if (existing) {
			return existing;
		}

		const now = new Date().toISOString();
		this.db
			.prepare(
				`
					INSERT INTO crawl_state (
						target_url,
						resume_cursor,
						default_max_pages,
						last_run_id,
						updated_at
					) VALUES (?, NULL, ?, NULL, ?)
				`,
			)
			.run(CRAWLER_TARGET_URL, DEFAULT_CRAWL_MAX_PAGES, now);

		return {
			target_url: CRAWLER_TARGET_URL,
			default_max_pages: DEFAULT_CRAWL_MAX_PAGES,
			last_run_id: null,
			updated_at: now,
		};
	}

	private createIdleStatus(params?: {
		maxPages?: number;
	}): CrawlerStatusSnapshot {
		return {
			status: "idle",
			phase: "idle",
			runId: null,
			targetUrl: CRAWLER_TARGET_URL,
			maxPages: params?.maxPages ?? DEFAULT_CRAWL_MAX_PAGES,
			pagesVisited: 0,
			itemsSeen: 0,
			newItems: 0,
			duplicateItems: 0,
			skippedItems: 0,
			metadataRequested: 0,
			metadataUpdated: 0,
			metadataFailed: 0,
			downloadRequested: 0,
			downloadSent: 0,
			downloadInvalid: 0,
			downloadFailed: 0,
			downloadExcluded: 0,
			downloadLastError: null,
			currentCursor: null,
			startedAt: null,
			finishedAt: null,
			lastError: null,
			isStopping: false,
		};
	}

	private initializeDatabase(): void {
		initializeCrawlerDatabase(this.db);
	}

	private assertDatabaseWritable(): void {
		if (
			this.currentRunPromise ||
			this.currentBackfillPromise ||
			this.currentArchiveRecoveryPromise
		) {
			throw new Error(
				"크롤링 또는 메타데이터 작업 실행 중에는 DB를 수정할 수 없습니다.",
			);
		}
	}

	private getItemRow(code: string): CrawlItemRow | null {
		const row = this.db
			.prepare(
				`
					SELECT
						code,
						target_url,
						type,
						name,
						link,
						source_cursor,
						created_run_id,
						discovered_at
					FROM crawl_items
					WHERE code = ?
					LIMIT 1
				`,
			)
			.get(code) as CrawlItemRow | undefined;

		return row ?? null;
	}

	private normalizeMutationInput(input: CrawlItemMutationInput): {
		code: string;
		type: string;
		name: string;
		link: string;
		sourceCursor: string | null;
		discoveredAt: string;
	} {
		const code = input.code.trim();
		const type = input.type.trim();
		const name = input.name.trim();
		const link = input.link.trim();
		const sourceCursor = input.sourceCursor?.trim() || null;
		const discoveredAt = input.discoveredAt?.trim()
			? new Date(input.discoveredAt)
			: new Date();

		if (!/^\d+$/.test(code)) {
			throw new Error("코드는 숫자만 입력할 수 있습니다.");
		}

		if (!type) {
			throw new Error("유형을 입력해주세요.");
		}

		if (!name) {
			throw new Error("제목을 입력해주세요.");
		}

		if (!link) {
			throw new Error("링크를 입력해주세요.");
		}

		let parsedUrl: URL;
		try {
			parsedUrl = new URL(link);
		} catch {
			throw new Error("유효한 링크를 입력해주세요.");
		}

		if (!["http:", "https:"].includes(parsedUrl.protocol)) {
			throw new Error("링크는 http 또는 https만 지원합니다.");
		}

		const codeInLink = parsedUrl.pathname.match(/\/g\/(\d+)\//)?.[1];
		if (codeInLink && codeInLink !== code) {
			throw new Error("링크의 코드와 입력한 코드가 일치하지 않습니다.");
		}

		if (Number.isNaN(discoveredAt.getTime())) {
			throw new Error("수집 시각 형식이 올바르지 않습니다.");
		}

		return {
			code,
			type,
			name,
			link: parsedUrl.toString(),
			sourceCursor,
			discoveredAt: discoveredAt.toISOString(),
		};
	}

	private getOrCreateManualRunId(): number {
		const existing = this.db
			.prepare(
				`
					SELECT id
					FROM crawl_runs
					WHERE last_error = ?
					ORDER BY id DESC
					LIMIT 1
				`,
			)
			.get(MANUAL_RUN_TAG) as { id: number } | undefined;

		if (existing) {
			return existing.id;
		}

		const now = new Date().toISOString();
		const result = this.db
			.prepare(
				`
					INSERT INTO crawl_runs (
						target_url,
						status,
						phase,
						max_pages,
						pages_visited,
						items_seen,
						new_items,
						duplicate_items,
						skipped_items,
						resume_cursor_before,
						resume_cursor_after,
						started_at,
						finished_at,
						last_error
					) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, NULL, ?, ?, ?)
				`,
			)
			.run(CRAWLER_TARGET_URL, "completed", "idle", now, now, MANUAL_RUN_TAG);

		return Number(result.lastInsertRowid);
	}

	private isManualRun(runId: number): boolean {
		const run = this.db
			.prepare("SELECT last_error FROM crawl_runs WHERE id = ?")
			.get(runId) as { last_error: string | null } | undefined;

		return run?.last_error === MANUAL_RUN_TAG;
	}

	private syncRunItemCounters(runId: number): void {
		const itemCount = this.db
			.prepare(
				"SELECT COUNT(*) AS count FROM crawl_items WHERE created_run_id = ?",
			)
			.get(runId) as { count: number };

		this.db
			.prepare(
				`
					UPDATE crawl_runs
					SET items_seen = ?, new_items = ?
					WHERE id = ?
				`,
			)
			.run(itemCount.count, itemCount.count, runId);
	}

	private mapItemRow(row: CrawlItemRow): CrawlItem {
		return {
			code: row.code,
			targetUrl: row.target_url,
			type: row.type,
			name: row.name,
			link: row.link,
			sourceCursor: row.source_cursor,
			createdRunId: row.created_run_id,
			discoveredAt: row.discovered_at,
		};
	}

	private mapMetadataRow(
		row: CrawlItemMetadataRow,
		tagRows: CrawlItemTagRow[],
	): GallerySourceMetadata {
		return {
			galleryId: row.gallery_id,
			canonicalGalleryId: row.gallery_id,
			sourceKind: row.source_kind,
			token: row.token ?? undefined,
			title: row.title,
			titleJapanese: row.title_japanese ?? undefined,
			category: row.category,
			uploader: row.uploader ?? undefined,
			postedAt: row.posted_at ?? undefined,
			fileCount: row.file_count ?? undefined,
			fileSize: row.file_size ?? undefined,
			rating: row.rating ?? undefined,
			expunged: row.expunged === null ? undefined : row.expunged === 1,
			parentGalleryId: row.parent_gallery_id ?? undefined,
			parentToken: row.parent_token ?? undefined,
			currentGalleryId: row.current_gallery_id ?? undefined,
			currentToken: row.current_token ?? undefined,
			firstGalleryId: row.first_gallery_id ?? undefined,
			firstToken: row.first_token ?? undefined,
			fetchedAt: row.fetched_at,
			tags: tagRows.map((tagRow) => ({
				namespace: tagRow.namespace,
				value: tagRow.value,
				position: tagRow.position,
			})),
		};
	}

	private mapArchiveMetadataRow(
		row: ArchiveGalleryMetadataRow,
		tagRows: CrawlItemTagRow[],
	): GallerySourceMetadata {
		return {
			galleryId: row.gallery_id,
			canonicalGalleryId: row.canonical_gallery_id ?? row.gallery_id,
			sourceKind: row.source_kind,
			token: row.token ?? undefined,
			title: row.title,
			titleJapanese: row.title_japanese ?? undefined,
			category: row.category,
			uploader: row.uploader ?? undefined,
			postedAt: row.posted_at ?? undefined,
			fileCount: row.file_count ?? undefined,
			fileSize: row.file_size ?? undefined,
			rating: row.rating ?? undefined,
			expunged: row.expunged === null ? undefined : row.expunged === 1,
			parentGalleryId: row.parent_gallery_id ?? undefined,
			parentToken: row.parent_token ?? undefined,
			currentGalleryId: row.current_gallery_id ?? undefined,
			currentToken: row.current_token ?? undefined,
			firstGalleryId: row.first_gallery_id ?? undefined,
			firstToken: row.first_token ?? undefined,
			fetchedAt: row.fetched_at,
			tags: tagRows.map((tagRow) => ({
				namespace: tagRow.namespace,
				value: tagRow.value,
				position: tagRow.position,
			})),
		};
	}

	private validateMaxPages(rawValue: number): number {
		if (
			!Number.isFinite(rawValue) ||
			!Number.isInteger(rawValue) ||
			rawValue < 1
		) {
			throw new Error("최대 페이지 수는 1 이상의 정수여야 합니다.");
		}

		return rawValue;
	}

	private normalizeLimit(limit?: number): number {
		if (!limit || !Number.isFinite(limit)) {
			return RECENT_ITEMS_LIMIT;
		}

		const normalizedLimit = Math.trunc(limit);
		if (normalizedLimit < 1) {
			return RECENT_ITEMS_LIMIT;
		}

		return Math.min(normalizedLimit, 10000);
	}

	private normalizeDbListLimit(limit?: number): number {
		if (!limit || !Number.isFinite(limit)) {
			return DB_ITEM_LIST_LIMIT;
		}

		const normalizedLimit = Math.trunc(limit);
		if (normalizedLimit < 1) {
			return DB_ITEM_LIST_LIMIT;
		}

		return Math.min(normalizedLimit, 500);
	}

	private async delayRandom(
		minMs: number,
		maxMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		const delayMs = randomInt(minMs, maxMs + 1);
		await this.delay(delayMs, signal);
	}

	private async delay(delayMs: number, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, delayMs);
			});
			return;
		}

		await new Promise<void>((resolve, reject) => {
			let timeout: ReturnType<typeof setTimeout> | null = null;
			const handleAbort = () => {
				signal.removeEventListener("abort", handleAbort);
				if (timeout) {
					clearTimeout(timeout);
				}
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			};

			if (signal.aborted) {
				handleAbort();
				return;
			}

			const handleResolve = () => {
				signal.removeEventListener("abort", handleAbort);
				resolve();
			};

			timeout = setTimeout(handleResolve, delayMs);
			signal.addEventListener("abort", handleAbort, { once: true });
		});
	}

	private throwIfStopped(): void {
		if (this.abortController?.signal.aborted) {
			throw (
				this.abortController.signal.reason ??
				new DOMException("manual-stop", "AbortError")
			);
		}
	}

	private isAbortError(error: unknown): boolean {
		if (error instanceof DOMException) {
			return error.name === "AbortError";
		}

		return (
			error instanceof Error &&
			(error.name === "AbortError" || error.message === "manual-stop")
		);
	}

	private toErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			const causeMessage = this.toCauseMessage(error);
			if (causeMessage) {
				return `${error.message} (${causeMessage})`;
			}

			return error.message;
		}

		return "알 수 없는 오류가 발생했습니다.";
	}

	private toCauseMessage(error: Error): string | null {
		const cause = (error as { cause?: unknown }).cause;
		if (cause instanceof Error) {
			const code = (cause as { code?: unknown }).code;
			if (typeof code === "string" && !cause.message.includes(code)) {
				return `${cause.message} (${code})`;
			}

			return cause.message;
		}

		if (typeof cause === "string" && cause.trim()) {
			return cause.trim();
		}

		return null;
	}
}
