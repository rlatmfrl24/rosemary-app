import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeCrawlerDatabase } from "../src/main/crawler-database.ts";

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

test("기존 crawler DB를 마이그레이션하고 메타데이터 FK cascade를 유지한다", () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-crawler-db-"),
	);
	const database = new DatabaseSync(path.join(tempDirectory, "crawler.sqlite"));

	try {
		database.exec(LEGACY_RUN_SCHEMA);
		initializeCrawlerDatabase(database);

		const runColumns = database
			.prepare("PRAGMA table_info(crawl_runs)")
			.all()
			.map((column) => column.name);
		assert.ok(runColumns.includes("metadata_requested"));
		assert.ok(runColumns.includes("metadata_updated"));
		assert.ok(runColumns.includes("metadata_failed"));

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

		initializeCrawlerDatabase(database);
		assert.equal(
			database
				.prepare("SELECT status FROM crawl_metadata_backfill_jobs WHERE id = ?")
				.get(backfillJobId).status,
			"paused",
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
