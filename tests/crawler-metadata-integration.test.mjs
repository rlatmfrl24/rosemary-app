import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeCrawlerDatabase } from "../src/main/crawler-database.ts";
import {
	collectAndPersistCrawlerGalleryMetadata,
	persistCatalogMetadataWithOfficialFallback,
	persistCrawlerGalleryMetadataBatch,
} from "../src/main/crawler-metadata.ts";

const TARGET_URL = "https://e-hentai.org/?f_search=korean&f_srdd=3";
const NOW = "2026-07-21T00:00:00.000Z";

const createMetadata = (galleryId, token, suffix = "initial") => ({
	galleryId,
	canonicalGalleryId: galleryId,
	sourceKind: "ehentai-api",
	token,
	title: `Fixture ${suffix} ${galleryId}`,
	category: "Manga",
	expunged: false,
	fetchedAt: NOW,
	tags: [{ namespace: "artist", value: `artist-${suffix}`, position: 0 }],
});

test("신규 항목만 25개 배치로 저장하고 API 일부 실패는 나머지 저장을 막지 않는다", async () => {
	const tempDirectory = mkdtempSync(path.join(tmpdir(), "rosemary-metadata-"));
	const database = new DatabaseSync(path.join(tempDirectory, "crawler.sqlite"));
	try {
		initializeCrawlerDatabase(database);
		const runId = Number(
			database
				.prepare(
					`INSERT INTO crawl_runs (
						target_url, status, phase, max_pages, started_at
					) VALUES (?, 'running', 'front', 1, ?)`,
				)
				.run(TARGET_URL, NOW).lastInsertRowid,
		);
		const insertItem = database.prepare(
			`INSERT INTO crawl_items (
				code, target_url, type, name, link,
				source_cursor, created_run_id, discovered_at
			) VALUES (?, ?, 'Manga', ?, ?, NULL, ?, ?)`,
		);
		const newItems = Array.from({ length: 26 }, (_, index) => {
			const galleryId = String(9_000_000 + index);
			const token = index.toString(16).padStart(10, "0");
			const link = `https://e-hentai.org/g/${galleryId}/${token}/`;
			insertItem.run(
				galleryId,
				TARGET_URL,
				`Fixture ${galleryId}`,
				link,
				runId,
				NOW,
			);
			return { code: galleryId, link, token };
		});
		const existingItem = {
			code: "8000000",
			link: "https://e-hentai.org/g/8000000/00000000ff/",
		};

		const batchSizes = [];
		let requestIndex = 0;
		const stats = await collectAndPersistCrawlerGalleryMetadata({
			database,
			items: newItems,
			fetchBatch: async (identities) => {
				batchSizes.push(identities.length);
				requestIndex += 1;
				if (requestIndex === 2) throw new Error("fixture network failure");
				return {
					metadata: identities
						.slice(0, 24)
						.map((identity) =>
							createMetadata(identity.galleryId, identity.token),
						),
					failures: new Map([
						[identities[24].galleryId, "fixture item failure"],
					]),
				};
			},
			isAbortError: () => false,
		});

		assert.deepEqual(batchSizes, [25, 1]);
		assert.deepEqual(stats, { requested: 26, updated: 24, failed: 2 });
		assert.equal(
			database
				.prepare("SELECT COUNT(*) AS count FROM crawl_item_metadata")
				.get().count,
			24,
		);
		assert.equal(
			database
				.prepare(
					"SELECT COUNT(*) AS count FROM crawl_item_metadata WHERE gallery_id = ?",
				)
				.get(existingItem.code).count,
			0,
		);

		const first = newItems[0];
		persistCrawlerGalleryMetadataBatch(database, [
			createMetadata(first.code, first.token, "updated"),
		]);
		assert.equal(
			database
				.prepare("SELECT title FROM crawl_item_metadata WHERE gallery_id = ?")
				.get(first.code).title,
			`Fixture updated ${first.code}`,
		);
		assert.deepEqual(
			database
				.prepare(
					`SELECT namespace, value, position FROM crawl_item_tags
					 WHERE gallery_id = ? ORDER BY position`,
				)
				.all(first.code)
				.map((row) => ({ ...row })),
			[{ namespace: "artist", value: "artist-updated", position: 0 }],
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

test("메타데이터 요청 중 취소 신호는 실패 통계로 삼키지 않고 전파한다", async () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-metadata-abort-"),
	);
	const database = new DatabaseSync(path.join(tempDirectory, "crawler.sqlite"));
	try {
		initializeCrawlerDatabase(database);
		const abortError = new DOMException("manual-stop", "AbortError");
		await assert.rejects(
			collectAndPersistCrawlerGalleryMetadata({
				database,
				items: [
					{
						code: "9000000",
						link: "https://e-hentai.org/g/9000000/0000000001/",
					},
				],
				fetchBatch: async () => {
					throw abortError;
				},
				isAbortError: (error) => error === abortError,
			}),
			(error) => error === abortError,
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});

test("보관분 카탈로그 최신화는 공식 값을 보존하고 빈 필드·태그만 보완한다", () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-catalog-fallback-"),
	);
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
		database
			.prepare(
				`INSERT INTO crawl_items (
					code, target_url, type, name, link, created_run_id, discovered_at
				) VALUES ('1000', ?, 'Manga', 'Official', ?, ?, ?)`,
			)
			.run(TARGET_URL, "https://e-hentai.org/g/1000/0000000001/", runId, NOW);
		database
			.prepare(
				`INSERT INTO crawl_item_metadata (
					gallery_id, token, source_kind, title, category, fetched_at
				) VALUES ('1000', '0000000001', 'ehentai-api', 'Official title', '', ?)`,
			)
			.run(NOW);
		database
			.prepare(
				`INSERT INTO crawl_item_tags (gallery_id, namespace, value, position)
				 VALUES ('1000', 'artist', 'official artist', 0)`,
			)
			.run();
		database
			.prepare(
				`INSERT INTO archive_gallery_metadata (
					gallery_id, canonical_gallery_id, token, source_kind,
					title, category, fetched_at
				) VALUES ('2000', '2000', '0000000002', 'ehentai-api', '', 'Doujinshi', ?)`,
			)
			.run(NOW);

		persistCatalogMetadataWithOfficialFallback(database, [
			{
				...createMetadata("1000", "0000000001", "catalog"),
				sourceKind: "hitomi-catalog",
				category: "Manga",
				uploader: "catalog uploader",
			},
			{
				...createMetadata("2000", "0000000002", "catalog"),
				sourceKind: "hitomi-catalog",
				category: "Manga",
			},
			{
				...createMetadata("3000", "0000000003", "catalog"),
				sourceKind: "hitomi-catalog",
			},
		]);

		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT source_kind, title, category, uploader
						 FROM crawl_item_metadata WHERE gallery_id = '1000'`,
					)
					.get(),
			},
			{
				source_kind: "ehentai-api",
				title: "Official title",
				category: "Manga",
				uploader: "catalog uploader",
			},
		);
		assert.deepEqual(
			database
				.prepare(
					"SELECT namespace, value FROM crawl_item_tags WHERE gallery_id = '1000'",
				)
				.all()
				.map((row) => ({ ...row })),
			[{ namespace: "artist", value: "official artist" }],
		);
		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT source_kind, title, category
						 FROM archive_gallery_metadata WHERE gallery_id = '2000'`,
					)
					.get(),
			},
			{
				source_kind: "ehentai-api",
				title: "Fixture catalog 2000",
				category: "Doujinshi",
			},
		);
		assert.equal(
			database
				.prepare(
					"SELECT value FROM archive_gallery_tags WHERE gallery_id = '2000'",
				)
				.get().value,
			"artist-catalog",
		);
		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT source_kind, title FROM archive_gallery_metadata
						 WHERE gallery_id = '3000'`,
					)
					.get(),
			},
			{
				source_kind: "hitomi-catalog",
				title: "Fixture catalog 3000",
			},
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});
