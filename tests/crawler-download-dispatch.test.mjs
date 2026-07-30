import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeCrawlerDatabase } from "../src/main/crawler-database.ts";
import {
	applyDownloadDispatchResult,
	getDownloadDispatchSummary,
	selectDownloadDispatchRows,
} from "../src/main/crawler-download-dispatch.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const TARGET_URL = "https://e-hentai.org/?f_search=korean&f_srdd=3";

test("부분 전송 후 실패 항목만 재시도하고 성공·무효 항목은 제외한다", () => {
	const tempDirectory = mkdtempSync(path.join(tmpdir(), "rosemary-dispatch-"));
	const database = new DatabaseSync(path.join(tempDirectory, "crawler.sqlite"));
	try {
		initializeCrawlerDatabase(database);
		const runId = Number(
			database
				.prepare(
					`INSERT INTO crawl_runs (
						target_url, status, phase, max_pages, started_at
					) VALUES (?, 'completed', 'idle', 1, ?)`,
				)
				.run(TARGET_URL, NOW).lastInsertRowid,
		);
		const insertItem = database.prepare(
			`INSERT INTO crawl_items (
				code, target_url, type, name, link, created_run_id, discovered_at
			) VALUES (?, ?, 'Manga', ?, ?, ?, ?)`,
		);
		const insertDispatch = database.prepare(
			`INSERT INTO crawl_download_dispatch_items (
				run_id, gallery_id, status, updated_at
			) VALUES (?, ?, 'pending', ?)`,
		);
		for (const galleryId of ["1000", "2000", "3000"]) {
			insertItem.run(
				galleryId,
				TARGET_URL,
				`Fixture ${galleryId}`,
				`https://e-hentai.org/g/${galleryId}/0000000001/`,
				runId,
				NOW,
			);
			insertDispatch.run(runId, galleryId, NOW);
		}

		const initialRows = selectDownloadDispatchRows(database, runId, [
			"pending",
		]);
		assert.deepEqual(
			initialRows.map((row) => row.galleryId),
			["1000", "2000", "3000"],
		);
		applyDownloadDispatchResult(
			database,
			runId,
			initialRows,
			{
				success: false,
				total: 3,
				sent: 1,
				invalid: 1,
				failed: 1,
				launched: false,
				message: "fixture",
				failures: [
					{
						code: "2000",
						stage: "valid_url",
						message: "Hitomi Downloader에서 유효하지 않은 코드로 판단했습니다.",
						statusCode: 400,
					},
					{
						code: "3000",
						stage: "download",
						message: "temporary failure",
						statusCode: 500,
					},
				],
			},
			NOW,
		);

		const retryRows = selectDownloadDispatchRows(database, runId, ["failed"]);
		assert.deepEqual(
			retryRows.map((row) => row.galleryId),
			["3000"],
		);
		applyDownloadDispatchResult(
			database,
			runId,
			retryRows,
			{
				success: true,
				total: 1,
				sent: 1,
				invalid: 0,
				failed: 0,
				launched: false,
				failures: [],
				message: "fixture retry",
			},
			"2026-07-22T00:01:00.000Z",
		);

		assert.deepEqual(getDownloadDispatchSummary(database, runId), {
			requested: 3,
			sent: 2,
			invalid: 1,
			failed: 0,
			lastError: null,
		});
		assert.deepEqual(
			database
				.prepare(
					`SELECT gallery_id, status, attempt_count
					 FROM crawl_download_dispatch_items
					 ORDER BY CAST(gallery_id AS INTEGER)`,
				)
				.all()
				.map((row) => ({ ...row })),
			[
				{ gallery_id: "1000", status: "sent", attempt_count: 1 },
				{ gallery_id: "2000", status: "invalid", attempt_count: 1 },
				{ gallery_id: "3000", status: "sent", attempt_count: 2 },
			],
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});
