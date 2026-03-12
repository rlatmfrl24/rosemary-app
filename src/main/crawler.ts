import { randomInt } from "node:crypto";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as cheerio from "cheerio";
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
	type StartCrawlOptions,
} from "../shared/crawler";

const BASE_DELAY_MIN_MS = 1500;
const BASE_DELAY_MAX_MS = 4000;
const RETRY_DELAY_MIN_MS = 8000;
const RETRY_DELAY_MAX_MS = 15000;
const MAX_RETRY_COUNT = 2;
const RECENT_ITEMS_LIMIT = 50;
const DB_ITEM_LIST_LIMIT = 100;
const MANUAL_RUN_TAG = "manual-entry";

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
	resume_cursor_before: string | null;
	resume_cursor_after: string | null;
	started_at: string;
	finished_at: string | null;
	last_error: string | null;
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

class RetryableFetchError extends Error {
	constructor(
		message: string,
		public readonly statusCode?: number,
	) {
		super(message);
		this.name = "RetryableFetchError";
	}
}

export class CrawlerService {
	private readonly db: DatabaseSync;

	private currentStatus: CrawlerStatusSnapshot | null = null;

	private currentRunPromise: Promise<void> | null = null;

	private abortController: AbortController | null = null;

	constructor(userDataPath: string) {
		const databasePath = path.join(userDataPath, "crawler.sqlite");
		this.db = new DatabaseSync(databasePath);
		this.initializeDatabase();
	}

	public start(options: StartCrawlOptions): CrawlerStatusSnapshot {
		if (this.currentRunPromise) {
			throw new Error("이미 크롤링이 진행 중입니다.");
		}

		const maxPages = this.validateMaxPages(options.maxPages);
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
						resume_cursor_before,
						resume_cursor_after,
						started_at,
						finished_at,
						last_error
					) VALUES (?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, NULL, NULL)
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

	public getDatabaseSummary(): CrawlDatabaseSummary {
		const crawlState = this.getOrCreateState();
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
		};
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
				seenCodes,
			});

			pagesVisited = result.pagesVisited;
			itemsSeen = result.itemsSeen;
			newItems = result.newItems;
			duplicateItems = result.duplicateItems;
			skippedItems = result.skippedItems;

			await this.finishRun({
				runId,
				status: result.outcome === "partial" ? "partial" : "completed",
				maxPages,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
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
		seenCodes: Set<string>;
	}): Promise<{
		outcome: "completed" | "partial";
		pagesVisited: number;
		itemsSeen: number;
		newItems: number;
		duplicateItems: number;
		skippedItems: number;
		currentCursor: string | null;
	}> {
		let currentCursor = params.startCursor;
		let pagesVisited = params.pagesVisited;
		let itemsSeen = params.itemsSeen;
		let newItems = params.newItems;
		let duplicateItems = params.duplicateItems;
		let skippedItems = params.skippedItems;

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
			});

			this.updateCurrentStatus({
				phase: params.phase,
				currentCursor,
				pagesVisited,
				itemsSeen,
				newItems,
				duplicateItems,
				skippedItems,
			});

			if (pageStats.newItems === 0) {
				return {
					outcome: "completed",
					pagesVisited,
					itemsSeen,
					newItems,
					duplicateItems,
					skippedItems,
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
				const response = await fetch(url, {
					headers: {
						Accept: "text/html,application/xhtml+xml",
						"User-Agent":
							"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
					},
					signal,
				});

				if (response.status === 429 || response.status >= 500) {
					throw new RetryableFetchError(
						`크롤링 요청이 일시적으로 실패했습니다. (${response.status})`,
						response.status,
					);
				}

				if (!response.ok) {
					throw new Error(`크롤링 요청에 실패했습니다. (${response.status})`);
				}

				const html = await response.text();
				return this.parsePage(html, cursor);
			} catch (error) {
				if (this.isAbortError(error)) {
					throw error;
				}

				const isRetryable =
					error instanceof RetryableFetchError || error instanceof TypeError;
				if (!isRetryable || attempt === MAX_RETRY_COUNT) {
					throw error;
				}

				await this.delayRandom(RETRY_DELAY_MIN_MS, RETRY_DELAY_MAX_MS, signal);
			}
		}

		throw new Error("알 수 없는 크롤링 오류가 발생했습니다.");
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
						skipped_items = ?
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
			currentCursor: null,
			startedAt: null,
			finishedAt: null,
			lastError: null,
			isStopping: false,
		};
	}

	private initializeDatabase(): void {
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS crawl_runs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				target_url TEXT NOT NULL,
				status TEXT NOT NULL,
				phase TEXT NOT NULL,
				max_pages INTEGER NOT NULL,
				pages_visited INTEGER NOT NULL DEFAULT 0,
				items_seen INTEGER NOT NULL DEFAULT 0,
				new_items INTEGER NOT NULL DEFAULT 0,
				duplicate_items INTEGER NOT NULL DEFAULT 0,
				skipped_items INTEGER NOT NULL DEFAULT 0,
				resume_cursor_before TEXT,
				resume_cursor_after TEXT,
				started_at TEXT NOT NULL,
				finished_at TEXT,
				last_error TEXT
			);

			CREATE TABLE IF NOT EXISTS crawl_items (
				code TEXT PRIMARY KEY,
				target_url TEXT NOT NULL,
				type TEXT NOT NULL,
				name TEXT NOT NULL,
				link TEXT NOT NULL,
				source_cursor TEXT,
				created_run_id INTEGER NOT NULL,
				discovered_at TEXT NOT NULL,
				FOREIGN KEY (created_run_id) REFERENCES crawl_runs(id)
			);

			CREATE TABLE IF NOT EXISTS crawl_state (
				target_url TEXT PRIMARY KEY,
				resume_cursor TEXT,
				default_max_pages INTEGER NOT NULL DEFAULT 10,
				last_run_id INTEGER,
				updated_at TEXT NOT NULL
			);

			CREATE INDEX IF NOT EXISTS idx_crawl_items_run_id
			ON crawl_items(created_run_id);
		`);
	}

	private assertDatabaseWritable(): void {
		if (this.currentRunPromise) {
			throw new Error("크롤링 실행 중에는 DB를 수정할 수 없습니다.");
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
			return error.message;
		}

		return "알 수 없는 오류가 발생했습니다.";
	}
}
