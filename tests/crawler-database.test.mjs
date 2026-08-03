import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	clearCrawlerDatabaseContent,
	getMetadataBackfillFailedGalleryIds,
	initializeCrawlerDatabase,
} from "../src/main/crawler-database.ts";
import {
	listTagPreferences,
	upsertTagPreference,
} from "../src/main/tag-preferences.ts";

const TARGET_URL = "https://e-hentai.org/?f_search=korean&f_srdd=3";

const LEGACY_RUN_SCHEMA = `
	CREATE TABLE crawl_runs (
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
`;

const LEGACY_BACKFILL_JOB_SCHEMA = `
	CREATE TABLE crawl_metadata_backfill_jobs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		status TEXT NOT NULL,
		total_count INTEGER NOT NULL DEFAULT 0,
		processed_count INTEGER NOT NULL DEFAULT 0,
		updated_count INTEGER NOT NULL DEFAULT 0,
		failed_count INTEGER NOT NULL DEFAULT 0,
		remaining_count INTEGER NOT NULL DEFAULT 0,
		already_present_count INTEGER NOT NULL DEFAULT 0,
		invalid_link_count INTEGER NOT NULL DEFAULT 0,
		started_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		finished_at TEXT,
		last_error TEXT
	);
`;

test("기존 crawler DB를 마이그레이션하고 메타데이터 FK cascade를 유지한다", () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-crawler-db-"),
	);
	const database = new DatabaseSync(path.join(tempDirectory, "crawler.sqlite"));

	try {
		database.exec(LEGACY_RUN_SCHEMA);
		database.exec(LEGACY_BACKFILL_JOB_SCHEMA);
		initializeCrawlerDatabase(database);

		const runColumns = database
			.prepare("PRAGMA table_info(crawl_runs)")
			.all()
			.map((column) => column.name);
		assert.ok(runColumns.includes("metadata_requested"));
		assert.ok(runColumns.includes("metadata_updated"));
		assert.ok(runColumns.includes("metadata_failed"));
		assert.ok(runColumns.includes("download_requested"));
		assert.ok(runColumns.includes("download_sent"));
		assert.ok(runColumns.includes("download_invalid"));
		assert.ok(runColumns.includes("download_failed"));
		assert.ok(runColumns.includes("download_excluded"));
		assert.ok(runColumns.includes("download_last_error"));
		const crawlMetadataColumns = database
			.prepare("PRAGMA table_info(crawl_item_metadata)")
			.all()
			.map((column) => column.name);
		assert.ok(crawlMetadataColumns.includes("source_kind"));
		const dispatchColumns = database
			.prepare("PRAGMA table_info(crawl_download_dispatch_items)")
			.all()
			.map((column) => column.name);
		assert.deepEqual(dispatchColumns, [
			"run_id",
			"gallery_id",
			"status",
			"attempt_count",
			"last_error",
			"updated_at",
			"sent_at",
			"excluded_tag_key",
		]);
		const backfillJobColumns = database
			.prepare("PRAGMA table_info(crawl_metadata_backfill_jobs)")
			.all()
			.map((column) => column.name);
		assert.ok(backfillJobColumns.includes("retry_count"));
		const archiveJobColumns = database
			.prepare("PRAGMA table_info(archive_metadata_recovery_jobs)")
			.all()
			.map((column) => column.name);
		assert.ok(archiveJobColumns.includes("scope_kind"));
		assert.ok(archiveJobColumns.includes("scope_path"));
		assert.ok(archiveJobColumns.includes("token_not_found_count"));
		const archiveItemColumns = database
			.prepare("PRAGMA table_info(archive_metadata_recovery_items)")
			.all()
			.map((column) => column.name);
		assert.ok(archiveItemColumns.includes("representative_path"));
		assert.ok(archiveItemColumns.includes("priority"));
		assert.ok(archiveItemColumns.includes("reason_code"));

		const backfillJobResult = database
			.prepare(
				`INSERT INTO crawl_metadata_backfill_jobs (
					status, total_count, remaining_count, already_present_count,
					invalid_link_count, started_at, updated_at
				) VALUES ('running', 1, 1, 0, 0, ?, ?)`,
			)
			.run("2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z");
		const backfillJobId = Number(backfillJobResult.lastInsertRowid);
		database
			.prepare(
				`INSERT INTO crawl_metadata_backfill_items (
					job_id, gallery_id, updated_at
				) VALUES (?, ?, ?)`,
			)
			.run(backfillJobId, "123456", "2026-07-21T00:00:00.000Z");
		database
			.prepare(
				`INSERT INTO crawl_metadata_backfill_items (
					job_id, gallery_id, status, updated_at
				) VALUES (?, ?, 'failed', ?)`,
			)
			.run(backfillJobId, "456789", "2026-07-21T00:00:00.000Z");
		database
			.prepare(
				`INSERT INTO crawl_metadata_backfill_items (
					job_id, gallery_id, status, updated_at
				) VALUES (?, ?, 'succeeded', ?)`,
			)
			.run(backfillJobId, "234567", "2026-07-21T00:00:00.000Z");
		assert.deepEqual(
			getMetadataBackfillFailedGalleryIds(database, backfillJobId),
			["456789"],
		);

		initializeCrawlerDatabase(database);
		assert.equal(
			database
				.prepare("SELECT status FROM crawl_metadata_backfill_jobs WHERE id = ?")
				.get(backfillJobId).status,
			"paused",
		);
		assert.equal(
			database
				.prepare(
					"SELECT retry_count FROM crawl_metadata_backfill_jobs WHERE id = ?",
				)
				.get(backfillJobId).retry_count,
			0,
		);
		database
			.prepare("DELETE FROM crawl_metadata_backfill_jobs WHERE id = ?")
			.run(backfillJobId);
		assert.equal(
			database
				.prepare("SELECT COUNT(*) AS count FROM crawl_metadata_backfill_items")
				.get().count,
			0,
		);

		const archiveJobResult = database
			.prepare(
				`INSERT INTO archive_metadata_recovery_jobs (
					status, phase, total_count, remaining_count, started_at, updated_at
				) VALUES ('running', 'search', 1, 1, ?, ?)`,
			)
			.run("2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z");
		const archiveJobId = Number(archiveJobResult.lastInsertRowid);
		database
			.prepare(
				`INSERT INTO archive_metadata_recovery_items (
					job_id, gallery_id, updated_at
				) VALUES (?, ?, ?)`,
			)
			.run(archiveJobId, "777777", "2026-07-21T00:00:00.000Z");
		database
			.prepare(
				`INSERT INTO archive_gallery_metadata (
					gallery_id, source_kind, title, category, fetched_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				"777777",
				"hitomi-catalog",
				"Archive fixture",
				"Manga",
				"2026-07-21T00:00:00.000Z",
			);
		database
			.prepare(
				`INSERT INTO archive_gallery_tags (
					gallery_id, namespace, value, position
				) VALUES (?, ?, ?, ?)`,
			)
			.run("777777", "artist", "archive artist", 0);

		initializeCrawlerDatabase(database);
		assert.equal(
			database
				.prepare(
					"SELECT status FROM archive_metadata_recovery_jobs WHERE id = ?",
				)
				.get(archiveJobId).status,
			"paused",
		);
		database
			.prepare("DELETE FROM archive_gallery_metadata WHERE gallery_id = ?")
			.run("777777");
		assert.equal(
			database
				.prepare("SELECT COUNT(*) AS count FROM archive_gallery_tags")
				.get().count,
			0,
		);
		database
			.prepare("DELETE FROM archive_metadata_recovery_jobs WHERE id = ?")
			.run(archiveJobId);
		assert.equal(
			database
				.prepare(
					"SELECT COUNT(*) AS count FROM archive_metadata_recovery_items",
				)
				.get().count,
			0,
		);

		const runResult = database
			.prepare(
				`INSERT INTO crawl_runs (
					target_url, status, phase, max_pages, started_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				"https://e-hentai.org/?f_search=korean",
				"completed",
				"idle",
				1,
				"2026-07-21T00:00:00.000Z",
			);
		const runId = Number(runResult.lastInsertRowid);

		database
			.prepare(
				`INSERT INTO crawl_items (
					code, target_url, type, name, link, created_run_id, discovered_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"123456",
				"https://e-hentai.org/?f_search=korean",
				"Manga",
				"Fixture",
				"https://e-hentai.org/g/123456/abcdef1234/",
				runId,
				"2026-07-21T00:00:00.000Z",
			);
		database
			.prepare(
				`INSERT INTO crawl_item_metadata (
					gallery_id, token, title, category, fetched_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				"123456",
				"abcdef1234",
				"Fixture title",
				"Manga",
				"2026-07-21T00:00:00.000Z",
			);
		database
			.prepare(
				`INSERT INTO crawl_item_tags (
					gallery_id, namespace, value, position
				) VALUES (?, ?, ?, ?)`,
			)
			.run("123456", "artist", "fixture artist", 0);

		initializeCrawlerDatabase(database);
		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT canonical_gallery_id, token, status
						 FROM archive_gallery_recovery_state WHERE gallery_id = ?`,
					)
					.get("123456"),
			},
			{
				canonical_gallery_id: "123456",
				token: "abcdef1234",
				status: "official",
			},
		);

		database
			.prepare("UPDATE crawl_items SET code = ? WHERE code = ?")
			.run("654321", "123456");
		assert.equal(
			database
				.prepare(
					"SELECT COUNT(*) AS count FROM crawl_item_metadata WHERE gallery_id = ?",
				)
				.get("654321").count,
			1,
		);
		assert.equal(
			database
				.prepare(
					"SELECT COUNT(*) AS count FROM crawl_item_tags WHERE gallery_id = ?",
				)
				.get("654321").count,
			1,
		);

		database.prepare("DELETE FROM crawl_items WHERE code = ?").run("654321");
		assert.equal(
			database
				.prepare("SELECT COUNT(*) AS count FROM crawl_item_metadata")
				.get().count,
			0,
		);
		assert.equal(
			database.prepare("SELECT COUNT(*) AS count FROM crawl_item_tags").get()
				.count,
			0,
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

test("크롤링 DB 콘텐츠 초기화는 사용자 태그 설정을 보존한다", () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-crawler-db-"),
	);
	const database = new DatabaseSync(path.join(tempDirectory, "crawler.sqlite"));

	try {
		initializeCrawlerDatabase(database);
		upsertTagPreference(
			database,
			{ namespace: "female", value: "tag a", kind: "excluded" },
			"2026-07-30T00:00:00.000Z",
		);
		database
			.prepare(
				`INSERT INTO crawl_state (
					target_url, default_max_pages, updated_at
				) VALUES (?, 10, ?)`,
			)
			.run(TARGET_URL, "2026-07-30T00:00:00.000Z");

		clearCrawlerDatabaseContent(database);

		assert.equal(
			database.prepare("SELECT COUNT(*) AS count FROM crawl_state").get().count,
			0,
		);
		assert.deepEqual(
			listTagPreferences(database).map(({ namespace, value, kind }) => ({
				namespace,
				value,
				kind,
			})),
			[{ namespace: "female", value: "tag a", kind: "excluded" }],
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

test("진행 중인 3단계 작업을 카탈로그 표시와 검색 완료 상태로 마이그레이션한다", () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-archive-recovery-db-"),
	);
	const database = new DatabaseSync(path.join(tempDirectory, "crawler.sqlite"));
	try {
		database.exec(LEGACY_RUN_SCHEMA);
		database.exec(`
			CREATE TABLE archive_metadata_recovery_jobs (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				status TEXT NOT NULL, phase TEXT NOT NULL,
				total_count INTEGER NOT NULL DEFAULT 0,
				processed_count INTEGER NOT NULL DEFAULT 0,
				official_count INTEGER NOT NULL DEFAULT 0,
				catalog_count INTEGER NOT NULL DEFAULT 0,
				unresolved_count INTEGER NOT NULL DEFAULT 0,
				failed_count INTEGER NOT NULL DEFAULT 0,
				remaining_count INTEGER NOT NULL DEFAULT 0,
				started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				finished_at TEXT, last_error TEXT
			);
			CREATE TABLE archive_metadata_recovery_items (
				job_id INTEGER NOT NULL, gallery_id TEXT NOT NULL,
				canonical_gallery_id TEXT, token TEXT,
				status TEXT NOT NULL DEFAULT 'pending',
				catalog_found INTEGER NOT NULL DEFAULT 0,
				search_attempt_count INTEGER NOT NULL DEFAULT 0,
				metadata_attempt_count INTEGER NOT NULL DEFAULT 0,
				last_phase TEXT NOT NULL DEFAULT 'catalog',
				last_error TEXT, updated_at TEXT NOT NULL,
				PRIMARY KEY (job_id, gallery_id)
			);
		`);
		const now = "2026-07-21T00:00:00.000Z";
		const jobId = Number(
			database
				.prepare(
					`INSERT INTO archive_metadata_recovery_jobs (
						status, phase, total_count, remaining_count,
						started_at, updated_at
					) VALUES ('running', 'search', 2, 2, ?, ?)`,
				)
				.run(now, now).lastInsertRowid,
		);
		const insertItem = database.prepare(
			`INSERT INTO archive_metadata_recovery_items (
				job_id, gallery_id, status, catalog_found, updated_at
			) VALUES (?, ?, ?, ?, ?)`,
		);
		insertItem.run(jobId, "1000", "pending", 1, now);
		insertItem.run(jobId, "2000", "unresolved", 0, now);
		database
			.prepare(
				`UPDATE archive_metadata_recovery_items
				 SET canonical_gallery_id = ?, token = ?,
				     search_attempt_count = 2, metadata_attempt_count = 1,
				     last_error = 'legacy access error'
				 WHERE gallery_id = ?`,
			)
			.run("2001", "historytoken", "2000");

		initializeCrawlerDatabase(database);
		const rows = database
			.prepare(
				`SELECT gallery_id, status, search_completed
				 FROM archive_metadata_recovery_items ORDER BY gallery_id`,
			)
			.all()
			.map((row) => ({ ...row }));
		assert.deepEqual(rows, [
			{ gallery_id: "1000", status: "catalog", search_completed: 0 },
			{ gallery_id: "2000", status: "unresolved", search_completed: 1 },
		]);
		assert.equal(
			database
				.prepare(
					"SELECT status FROM archive_metadata_recovery_jobs WHERE id = ?",
				)
				.get(jobId).status,
			"paused",
		);
		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT canonical_gallery_id, token, status,
						        search_attempt_count, metadata_attempt_count, last_error
						 FROM archive_gallery_recovery_state WHERE gallery_id = ?`,
					)
					.get("2000"),
			},
			{
				canonical_gallery_id: "2001",
				token: "historytoken",
				status: "token-not-found",
				search_attempt_count: 2,
				metadata_attempt_count: 1,
				last_error: "legacy access error",
			},
		);
		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT processed_count, catalog_count, unresolved_count,
						        remaining_count
						 FROM archive_metadata_recovery_jobs WHERE id = ?`,
					)
					.get(jobId),
			},
			{
				processed_count: 1,
				catalog_count: 1,
				unresolved_count: 1,
				remaining_count: 1,
			},
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});
