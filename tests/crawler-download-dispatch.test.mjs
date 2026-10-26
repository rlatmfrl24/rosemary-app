import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeCrawlerDatabase } from "../src/main/crawler-database.ts";
import {
	bindDownloadDispatchSource,
	getDownloadDispatchSummary,
	markDownloadDispatchRowsExcluded,
	selectDownloadDispatchRows,
} from "../src/main/crawler-download-dispatch.ts";
import {
	claimDownloadRequest,
	finishDownloadRequest,
} from "../src/main/hitomi-download-store.ts";

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
		for (const row of initialRows)
			bindDownloadDispatchSource(database, runId, row);
		assert.equal(claimDownloadRequest(database, initialRows[0].source), true);
		finishDownloadRequest(database, initialRows[0].source, "sent", null, true);
		finishDownloadRequest(
			database,
			initialRows[1].source,
			"invalid",
			"unsupported source",
			false,
		);
		finishDownloadRequest(
			database,
			initialRows[2].source,
			"failed",
			"validation request failed before submission",
			false,
		);

		const retryRows = selectDownloadDispatchRows(database, runId, ["failed"]);
		assert.deepEqual(
			retryRows.map((row) => row.galleryId),
			["3000"],
		);
		assert.equal(claimDownloadRequest(database, retryRows[0].source), true);
		finishDownloadRequest(database, retryRows[0].source, "sent", null, true);

		assert.deepEqual(getDownloadDispatchSummary(database, runId), {
			requested: 3,
			sent: 2,
			invalid: 1,
			failed: 0,
			excluded: 0,
			unknown: 0,
			lastError: null,
		});
		assert.deepEqual(
			database
				.prepare(
					`SELECT gallery_id, status, attempt_count
					 FROM hitomi_download_requests
					 ORDER BY CAST(gallery_id AS INTEGER)`,
				)
				.all()
				.map((row) => ({ ...row })),
			[
				{ gallery_id: "1000", status: "sent", attempt_count: 1 },
				{ gallery_id: "2000", status: "invalid", attempt_count: 0 },
				{ gallery_id: "3000", status: "sent", attempt_count: 1 },
			],
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

test("제외 태그와 일치한 항목은 전송 대상에서 빠지고 별도 상태로 집계한다", () => {
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
		for (const galleryId of ["1000", "2000"]) {
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

		markDownloadDispatchRowsExcluded(
			database,
			runId,
			[{ galleryId: "1000", tagKey: '["female","tag a"]' }],
			NOW,
		);

		assert.deepEqual(
			selectDownloadDispatchRows(database, runId, ["pending"]).map(
				(row) => row.galleryId,
			),
			["2000"],
		);
		assert.deepEqual(getDownloadDispatchSummary(database, runId), {
			requested: 1,
			sent: 0,
			invalid: 0,
			failed: 0,
			excluded: 1,
			unknown: 0,
			lastError: null,
		});
		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT status, attempt_count, excluded_tag_key
						 FROM crawl_download_dispatch_items
						 WHERE run_id = ? AND gallery_id = '1000'`,
					)
					.get(runId),
			},
			{
				status: "excluded",
				attempt_count: 0,
				excluded_tag_key: '["female","tag a"]',
			},
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

test("전송 전 실패로 원본이 바인딩된 항목도 새 제외 태그가 우선한다", () => {
	const database = new DatabaseSync(":memory:");
	try {
		initializeCrawlerDatabase(database);
		database.exec(`
			INSERT INTO crawl_runs (id,target_url,status,phase,max_pages,started_at) VALUES (1,'https://e-hentai.org/','completed','idle',1,'2026-10-27');
			INSERT INTO crawl_items (code,target_url,type,name,link,created_run_id,discovered_at)
			VALUES ('1000','https://e-hentai.org/','Manga','fixture','https://e-hentai.org/g/1000/0000000001/',1,'2026-10-27');
			INSERT INTO crawl_download_dispatch_items (run_id,gallery_id,status,updated_at) VALUES (1,'1000','pending','2026-10-27');
		`);
		const [row] = selectDownloadDispatchRows(database, 1, ["pending"]);
		bindDownloadDispatchSource(database, 1, row);
		finishDownloadRequest(
			database,
			row.source,
			"failed",
			"validation failed",
			false,
		);
		markDownloadDispatchRowsExcluded(database, 1, [
			{ galleryId: "1000", tagKey: '["female","excluded"]' },
		]);
		const summary = getDownloadDispatchSummary(database, 1);
		assert.equal(summary.excluded, 1);
		assert.equal(summary.requested, 0);
		assert.equal(summary.failed, 0);
		assert.equal(summary.lastError, null);
		assert.deepEqual(selectDownloadDispatchRows(database, 1, ["failed"]), []);
	} finally {
		database.close();
	}
});
