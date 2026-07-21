import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeCrawlerDatabase } from "../src/main/crawler-database.ts";
import {
	collectAndPersistCrawlerGalleryMetadata,
	persistCrawlerGalleryMetadataBatch,
} from "../src/main/crawler-metadata.ts";
import {
	createGalleryMetadataRequestPayload,
	mapGalleryMetadataBatchResponse,
} from "../src/shared/gallery-metadata.ts";

const TARGET_URL = "https://e-hentai.org/?f_search=korean&f_srdd=3";
const STARTED_AT = "2026-07-21T00:00:00.000Z";

const createMetadata = (galleryId, token, suffix = "initial") => ({
	galleryId,
	canonicalGalleryId: galleryId,
	sourceKind: "ehentai-api",
	token,
	title: `Fixture ${suffix} ${galleryId}`,
	titleJapanese: `보조 제목 ${suffix}`,
	category: "Manga",
	uploader: "fixture-uploader",
	postedAt: STARTED_AT,
	fileCount: 20,
	fileSize: 1024,
	rating: 4.5,
	expunged: false,
	fetchedAt: suffix === "updated" ? "2026-07-21T01:00:00.000Z" : STARTED_AT,
	tags: [
		{ namespace: "artist", value: `artist-${suffix}`, position: 0 },
		{ namespace: "language", value: "korean", position: 1 },
	],
});

test("25개 배치, 일부 실패, upsert와 재시작 영속성을 함께 검증한다", async () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-crawler-metadata-"),
	);
	const databasePath = path.join(tempDirectory, "crawler.sqlite");
	let database = new DatabaseSync(databasePath);
	try {
		initializeCrawlerDatabase(database);
		const runId = Number(
			database
				.prepare(
					`INSERT INTO crawl_runs (
						target_url, status, phase, max_pages, started_at
					) VALUES (?, 'running', 'front', 1, ?)`,
				)
				.run(TARGET_URL, STARTED_AT).lastInsertRowid,
		);
		const insertItem = database.prepare(
			`INSERT INTO crawl_items (
				code, target_url, type, name, link,
				source_cursor, created_run_id, discovered_at
			) VALUES (?, ?, 'Manga', ?, ?, NULL, ?, ?)`,
		);
		const items = Array.from({ length: 26 }, (_, index) => {
			const galleryId = String(9_000_000 + index);
			const token = index.toString(16).padStart(10, "a").slice(-10);
			const link = `https://e-hentai.org/g/${galleryId}/${token}/`;
			insertItem.run(
				galleryId,
				TARGET_URL,
				`Fixture ${galleryId}`,
				link,
				runId,
				STARTED_AT,
			);
			return { code: galleryId, link, token };
		});

		const batchSizes = [];
		let requestIndex = 0;
		const stats = await collectAndPersistCrawlerGalleryMetadata({
			database,
			items,
			fetchBatch: async (identities) => {
				batchSizes.push(identities.length);
				requestIndex += 1;
				if (requestIndex === 2) {
					throw new Error("fixture network failure");
				}
				const successfulIdentities = identities.slice(0, 24);
				return {
					metadata: successfulIdentities.map((identity) =>
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
			database.prepare("SELECT COUNT(*) AS count FROM crawl_items").get().count,
			26,
		);
		assert.equal(
			database
				.prepare("SELECT COUNT(*) AS count FROM crawl_item_metadata")
				.get().count,
			24,
		);

		const first = items[0];
		const payload = createGalleryMetadataRequestPayload(
			items.slice(0, 25).map((item) => ({
				galleryId: item.code,
				token: item.token,
			})),
		);
		assert.equal(payload.method, "gdata");
		assert.equal(payload.namespace, 1);
		assert.equal(payload.gidlist.length, 25);

		const updated = createMetadata(first.code, first.token, "updated");
		assert.deepEqual(
			[...persistCrawlerGalleryMetadataBatch(database, [updated])],
			[first.code],
		);
		assert.deepEqual(
			{
				...database
					.prepare(
						`SELECT title, fetched_at FROM crawl_item_metadata
						 WHERE gallery_id = ?`,
					)
					.get(first.code),
			},
			{
				title: `Fixture updated ${first.code}`,
				fetched_at: "2026-07-21T01:00:00.000Z",
			},
		);
		assert.deepEqual(
			database
				.prepare(
					`SELECT namespace, value, position FROM crawl_item_tags
					 WHERE gallery_id = ? ORDER BY position`,
				)
				.all(first.code)
				.map((row) => ({ ...row })),
			[
				{ namespace: "artist", value: "artist-updated", position: 0 },
				{ namespace: "language", value: "korean", position: 1 },
			],
		);

		const response = mapGalleryMetadataBatchResponse(
			[
				{
					gid: first.code,
					token: first.token,
					title: "Mapped response",
					category: "Manga",
					tags: ["artist:mapped"],
				},
			],
			[
				{ galleryId: first.code, token: first.token },
				{ galleryId: items[1].code, token: items[1].token },
			],
			STARTED_AT,
		);
		assert.equal(response.metadata.length, 1);
		assert.equal(
			response.failures.get(items[1].code),
			"API 응답에 해당 gallery id가 없습니다.",
		);

		database.close();
		database = new DatabaseSync(databasePath, { readOnly: true });
		assert.equal(
			database
				.prepare("SELECT title FROM crawl_item_metadata WHERE gallery_id = ?")
				.get(first.code).title,
			`Fixture updated ${first.code}`,
		);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});
