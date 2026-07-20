import { randomInt } from "node:crypto";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as cheerio from "cheerio";
import { net } from "electron";
import {
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
	type MetadataBackfillFailure,
	type MetadataBackfillSnapshot,
	type MetadataBackfillStatus,
	type StartCrawlOptions,
} from "../shared/crawler";
import {
	calculateMetadataCoverage,
	type GalleryIdentity,
	type GallerySourceMetadata,
	mapGalleryMetadataResponse,
	parseGalleryIdentity,
} from "../shared/gallery-metadata";
import { initializeCrawlerDatabase } from "./crawler-database";
import {
	executeRetryableRequest,
	isRetryableHttpStatusCode,
} from "./crawler-request-policy";

const BASE_DELAY_MIN_MS = 1500;
const BASE_DELAY_MAX_MS = 4000;
const RETRY_DELAY_MIN_MS = 8000;
const RETRY_DELAY_MAX_MS = 15000;
const MAX_RETRY_COUNT = 2;
const GALLERY_METADATA_API_URL = "https://api.e-hentai.org/api.php";
const GALLERY_METADATA_BATCH_SIZE = 25;
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
	resume_cursor_before: string | null;
	resume_cursor_after: string | null;
	started_at: string;
	finished_at: string | null;
	last_error: string | null;
}

interface CrawlItemMetadataRow {
	gallery_id: string;
	token: string;
	title: string;
	title_japanese: string | null;
	category: string;
	uploader: string | null;
	posted_at: string | null;
	file_count: number | null;
	file_size: number | null;
	rating: number | null;
	expunged: number;
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

interface GalleryMetadataPageStats {
	requested: number;
	updated: number;
	failed: number;
}

interface GalleryMetadataBatchResult {
	metadata: GallerySourceMetadata[];
	failures: Map<string, string>;
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

	private currentStatus: CrawlerStatusSnapshot | null = null;

	private currentRunPromise: Promise<void> | null = null;

	private abortController: AbortController | null = null;

	private currentBackfillPromise: Promise<void> | null = null;

	private backfillAbortController: AbortController | null = null;

	private isBackfillPausing = false;

	private metadataBatchesInWindow = 0;

	constructor(userDataPath: string) {
		const databasePath = path.join(userDataPath, "crawler.sqlite");
		this.db = new DatabaseSync(databasePath);
		this.initializeDatabase();
	}

	public start(options: StartCrawlOptions): CrawlerStatusSnapshot {
		if (this.currentRunPromise) {
			throw new Error("이미 크롤링이 진행 중입니다.");
		}
		if (this.currentBackfillPromise) {
			throw new Error("원천 메타데이터 백필이 진행 중입니다.");
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
		}

		return metadataByGalleryId;
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
		};
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
		if (latestJob?.status === "paused") {
			throw new Error("일시 중단된 백필 작업을 먼저 재개해주세요.");
		}
		return this.createAndStartMetadataBackfill();
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

		this.db.exec(`
			DELETE FROM crawl_metadata_backfill_items;
			DELETE FROM crawl_metadata_backfill_jobs;
			DELETE FROM crawl_item_tags;
			DELETE FROM crawl_item_metadata;
			DELETE FROM crawl_items;
			DELETE FROM crawl_runs;
			DELETE FROM crawl_state;
		`);

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

			await this.finishRun({
				runId,
				status: result.outcome === "partial" ? "partial" : "completed",
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

			await this.finishRun({
				runId,
				status: wasAborted ? "cancelled" : "failed",
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
			const metadataStats = await this.collectAndPersistGalleryMetadata(
				page.items,
				this.abortController?.signal,
			);

			pagesVisited += 1;
			itemsSeen += page.items.length;
			newItems += pageStats.newItems;
			duplicateItems += pageStats.duplicateItems;
			skippedItems += page.skippedCount;
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
	): { newItems: number; duplicateItems: number } {
		let newItems = 0;
		let duplicateItems = 0;
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

		for (const item of items) {
			if (seenCodes.has(item.code)) {
				duplicateItems += 1;
				continue;
			}

			const existing = findItem.get(item.code) as { code: string } | undefined;
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
			seenCodes.add(item.code);
			newItems += 1;
		}

		return { newItems, duplicateItems };
	}

	private async collectAndPersistGalleryMetadata(
		items: ParsedPageItem[],
		signal?: AbortSignal,
	): Promise<GalleryMetadataPageStats> {
		const identitiesByGalleryId = new Map<string, GalleryIdentity>();
		for (const item of items) {
			const identity = parseGalleryIdentity(item.link);
			if (identity?.galleryId === item.code) {
				identitiesByGalleryId.set(identity.galleryId, identity);
			}
		}

		const identities = [...identitiesByGalleryId.values()];
		const stats: GalleryMetadataPageStats = {
			requested: identities.length,
			updated: 0,
			failed: 0,
		};

		for (
			let offset = 0;
			offset < identities.length;
			offset += GALLERY_METADATA_BATCH_SIZE
		) {
			const batch = identities.slice(
				offset,
				offset + GALLERY_METADATA_BATCH_SIZE,
			);

			try {
				const result = await this.fetchGalleryMetadataBatch(batch, signal);
				const savedGalleryIds = this.persistGalleryMetadataBatch(
					result.metadata,
				);
				stats.updated += savedGalleryIds.size;
				stats.failed += batch.filter(
					(identity) => !savedGalleryIds.has(identity.galleryId),
				).length;
			} catch (error) {
				if (this.isAbortError(error)) {
					throw error;
				}

				stats.failed += batch.length;
				console.warn("E-Hentai 메타데이터 수집 실패:", error);
			}
		}

		return stats;
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
					{
						method: "gdata",
						gidlist: identities.map((identity) => [
							Number(identity.galleryId),
							identity.token,
						]),
						namespace: 1,
					},
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

				const payload = JSON.parse(response.body) as {
					gmetadata?: unknown;
				};
				const rawMetadata = Array.isArray(payload.gmetadata)
					? payload.gmetadata
					: [];
				const fetchedAt = new Date().toISOString();

				const requestedGalleryIds = new Set(
					identities.map((identity) => identity.galleryId),
				);
				const metadata: GallerySourceMetadata[] = [];
				const failures = new Map<string, string>();

				for (const value of rawMetadata) {
					const result = mapGalleryMetadataResponse(value, fetchedAt);
					if (
						result.metadata &&
						requestedGalleryIds.has(result.metadata.galleryId)
					) {
						metadata.push(result.metadata);
						continue;
					}

					if (result.galleryId && requestedGalleryIds.has(result.galleryId)) {
						failures.set(
							result.galleryId,
							result.error ?? "메타데이터 응답을 변환하지 못했습니다.",
						);
					}
				}

				const returnedGalleryIds = new Set([
					...metadata.map((item) => item.galleryId),
					...failures.keys(),
				]);
				for (const identity of identities) {
					if (!returnedGalleryIds.has(identity.galleryId)) {
						failures.set(
							identity.galleryId,
							"API 응답에 해당 gallery id가 없습니다.",
						);
					}
				}

				return { metadata, failures };
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
			const request = net.request({
				method: "POST",
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
			request.setHeader("Accept", "application/json");
			request.setHeader("Content-Type", "application/json");
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
			request.write(JSON.stringify(body));
			request.end();
		});
	}

	private persistGalleryMetadataBatch(
		metadataItems: GallerySourceMetadata[],
	): Set<string> {
		this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			const savedGalleryIds = this.persistGalleryMetadataItems(metadataItems);
			this.db.exec("COMMIT");
			return savedGalleryIds;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private persistGalleryMetadataItems(
		metadataItems: GallerySourceMetadata[],
	): Set<string> {
		const savedGalleryIds = new Set<string>();
		const upsertMetadata = this.db.prepare(`
			INSERT INTO crawl_item_metadata (
				gallery_id,
				token,
				title,
				title_japanese,
				category,
				uploader,
				posted_at,
				file_count,
				file_size,
				rating,
				expunged,
				parent_gallery_id,
				parent_token,
				current_gallery_id,
				current_token,
				first_gallery_id,
				first_token,
				fetched_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(gallery_id) DO UPDATE SET
				token = excluded.token,
				title = excluded.title,
				title_japanese = excluded.title_japanese,
				category = excluded.category,
				uploader = excluded.uploader,
				posted_at = excluded.posted_at,
				file_count = excluded.file_count,
				file_size = excluded.file_size,
				rating = excluded.rating,
				expunged = excluded.expunged,
				parent_gallery_id = excluded.parent_gallery_id,
				parent_token = excluded.parent_token,
				current_gallery_id = excluded.current_gallery_id,
				current_token = excluded.current_token,
				first_gallery_id = excluded.first_gallery_id,
				first_token = excluded.first_token,
				fetched_at = excluded.fetched_at
		`);
		const deleteTags = this.db.prepare(
			"DELETE FROM crawl_item_tags WHERE gallery_id = ?",
		);
		const insertTag = this.db.prepare(`
			INSERT OR REPLACE INTO crawl_item_tags (
				gallery_id,
				namespace,
				value,
				position
			) VALUES (?, ?, ?, ?)
		`);

		for (const metadata of metadataItems) {
			if (!this.getItemRow(metadata.galleryId)) {
				continue;
			}

			upsertMetadata.run(
				metadata.galleryId,
				metadata.token,
				metadata.title,
				metadata.titleJapanese ?? null,
				metadata.category,
				metadata.uploader ?? null,
				metadata.postedAt ?? null,
				metadata.fileCount ?? null,
				metadata.fileSize ?? null,
				metadata.rating ?? null,
				metadata.expunged ? 1 : 0,
				metadata.parentGalleryId ?? null,
				metadata.parentToken ?? null,
				metadata.currentGalleryId ?? null,
				metadata.currentToken ?? null,
				metadata.firstGalleryId ?? null,
				metadata.firstToken ?? null,
				metadata.fetchedAt,
			);
			deleteTags.run(metadata.galleryId);
			for (const tag of metadata.tags) {
				insertTag.run(
					metadata.galleryId,
					tag.namespace,
					tag.value,
					tag.position,
				);
			}
			savedGalleryIds.add(metadata.galleryId);
		}

		return savedGalleryIds;
	}

	private assertMetadataBackfillCanStart(): void {
		if (this.currentRunPromise) {
			throw new Error("일반 크롤링이 진행 중입니다.");
		}
		if (this.currentBackfillPromise) {
			throw new Error("원천 메타데이터 백필이 이미 진행 중입니다.");
		}
	}

	private createAndStartMetadataBackfill(): MetadataBackfillSnapshot {
		const coverage = this.getMetadataCoverage();
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
						failed_count, remaining_count, already_present_count,
						invalid_link_count, started_at, updated_at, finished_at,
						last_error
					) VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, NULL)`,
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
		this.metadataBatchesInWindow = 0;
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

				const identities: GalleryIdentity[] = [];
				const preflightOutcomes: Array<{
					galleryId: string;
					status: "succeeded" | "failed";
					error: string | null;
				}> = [];

				for (const pendingItem of pendingItems) {
					const item = this.getItemRow(pendingItem.gallery_id);
					if (!item) {
						preflightOutcomes.push({
							galleryId: pendingItem.gallery_id,
							status: "failed",
							error: "백필 대상 크롤링 항목이 삭제되었거나 변경되었습니다.",
						});
						continue;
					}

					if (this.hasGalleryMetadata(pendingItem.gallery_id)) {
						preflightOutcomes.push({
							galleryId: pendingItem.gallery_id,
							status: "succeeded",
							error: null,
						});
						continue;
					}

					const identity = parseGalleryIdentity(item.link);
					if (identity?.galleryId !== pendingItem.gallery_id) {
						preflightOutcomes.push({
							galleryId: pendingItem.gallery_id,
							status: "failed",
							error:
								"현재 링크에서 일치하는 gallery id와 token을 찾지 못했습니다.",
						});
						continue;
					}

					identities.push(identity);
				}

				if (preflightOutcomes.length > 0) {
					this.persistMetadataBackfillOutcomes(jobId, preflightOutcomes, false);
				}
				if (identities.length === 0) {
					continue;
				}

				this.throwIfSignalAborted(signal);
				try {
					const result = await this.fetchGalleryMetadataBatch(
						identities,
						signal,
					);
					this.persistMetadataBackfillBatch(jobId, identities, result);
				} catch (error) {
					if (this.isAbortError(error)) {
						throw error;
					}

					const message = this.getErrorMessage(error);
					this.persistMetadataBackfillBatch(jobId, identities, {
						metadata: [],
						failures: new Map(
							identities.map((identity) => [identity.galleryId, message]),
						),
					});
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
			.all(
				jobId,
				GALLERY_METADATA_BATCH_SIZE,
			) as unknown as MetadataBackfillItemRow[];
	}

	private persistMetadataBackfillBatch(
		jobId: number,
		identities: GalleryIdentity[],
		result: GalleryMetadataBatchResult,
	): void {
		this.db.exec("BEGIN IMMEDIATE TRANSACTION");
		try {
			const savedGalleryIds = this.persistGalleryMetadataItems(result.metadata);
			const updateItem = this.db.prepare(
				`UPDATE crawl_metadata_backfill_items
				 SET status = ?, attempt_count = attempt_count + 1,
				     last_error = ?, updated_at = ?
				 WHERE job_id = ? AND gallery_id = ? AND status = 'pending'`,
			);
			const updatedAt = new Date().toISOString();
			for (const identity of identities) {
				const succeeded = savedGalleryIds.has(identity.galleryId);
				updateItem.run(
					succeeded ? "succeeded" : "failed",
					succeeded
						? null
						: (result.failures.get(identity.galleryId) ??
								"메타데이터를 저장하지 못했습니다."),
					updatedAt,
					jobId,
					identity.galleryId,
				);
			}
			this.syncMetadataBackfillCounters(jobId, updatedAt);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
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

	private getMetadataCoverage(): MetadataCoverage {
		const rows = this.db
			.prepare(
				`SELECT item.code, item.link,
				        CASE WHEN metadata.gallery_id IS NULL THEN 0 ELSE 1 END AS has_metadata
				 FROM crawl_items AS item
				 LEFT JOIN crawl_item_metadata AS metadata
				   ON metadata.gallery_id = item.code`,
			)
			.all() as unknown as Array<{
			code: string;
			link: string;
			has_metadata: number;
		}>;
		return calculateMetadataCoverage(
			rows.map((row) => ({
				code: row.code,
				link: row.link,
				hasMetadata: row.has_metadata === 1,
			})),
		);
	}

	private hasGalleryMetadata(galleryId: string): boolean {
		return Boolean(
			this.db
				.prepare(
					"SELECT 1 FROM crawl_item_metadata WHERE gallery_id = ? LIMIT 1",
				)
				.get(galleryId),
		);
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
		if (this.currentRunPromise || this.currentBackfillPromise) {
			throw new Error(
				"크롤링 또는 원천 메타데이터 백필 실행 중에는 DB를 수정할 수 없습니다.",
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
			token: row.token,
			title: row.title,
			titleJapanese: row.title_japanese ?? undefined,
			category: row.category,
			uploader: row.uploader ?? undefined,
			postedAt: row.posted_at ?? undefined,
			fileCount: row.file_count ?? undefined,
			fileSize: row.file_size ?? undefined,
			rating: row.rating ?? undefined,
			expunged: row.expunged === 1,
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
