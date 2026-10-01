import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { loadMainModules } from "./helpers/main-modules.mjs";

test("메타데이터 재조회는 DB 변경·누락 항목 추가·롤백을 반영하고 반환 객체를 격리한다", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "rosemary-metadata-cache-"));
	const close = loadMainModules(root);
	let external;
	try {
		const { CrawlerService } = await import("../src/main/crawler.ts");
		const service = new CrawlerService(root);
		const db = service.db;
		db.exec(`
			INSERT INTO archive_gallery_metadata (gallery_id, source_kind, title, category, fetched_at)
			VALUES ('1', 'ehentai-api', 'original', 'doujinshi', 'now');
			INSERT INTO archive_gallery_tags VALUES ('1', 'artist', 'Alpha', 0);
		`);
		const prepare = db.prepare.bind(db);
		let queries = 0;
		db.prepare = (sql) => {
			if (
				/SELECT .*FROM (?:crawl_item|archive_gallery)_(?:metadata|tags)/s.test(
					sql,
				)
			)
				queries++;
			return prepare(sql);
		};
		const first = service.getMetadataByGalleryIds(["1", "2"]);
		assert.equal(first[1].title, "original");
		assert.equal(first[2], undefined);
		const initialQueries = queries;
		assert.ok(initialQueries > 0);
		first[1].title = "caller edit";
		first[1].tags[0].value = "caller edit";
		service.getMetadataByGalleryIds(["1"]);
		const again = service.getMetadataByGalleryIds(["1", "2"]);
		assert.equal(queries, initialQueries);
		assert.equal(again[1].title, "original");
		assert.equal(again[1].tags[0].value, "Alpha");

		db.exec(
			"UPDATE archive_gallery_metadata SET title = 'self' WHERE gallery_id = '1'",
		);
		assert.equal(service.getMetadataByGalleryIds(["1"])[1].title, "self");
		external = new DatabaseSync(path.join(root, "crawler.sqlite"));
		external.exec(`
			UPDATE archive_gallery_tags SET value = 'Beta' WHERE gallery_id = '1';
			INSERT INTO archive_gallery_metadata (gallery_id, source_kind, title, category, fetched_at)
			VALUES ('2', 'ehentai-api', 'new', 'doujinshi', 'now');
		`);
		const updated = service.getMetadataByGalleryIds(["1", "2"]);
		assert.equal(updated[1].tags[0].value, "Beta");
		assert.equal(updated[2].title, "new");

		db.exec(
			"BEGIN; UPDATE archive_gallery_metadata SET title = 'transaction' WHERE gallery_id = '1'",
		);
		assert.equal(
			service.getMetadataByGalleryIds(["1"])[1].title,
			"transaction",
		);
		db.exec(
			"SAVEPOINT nested; UPDATE archive_gallery_metadata SET title = 'nested' WHERE gallery_id = '1'",
		);
		assert.equal(service.getMetadataByGalleryIds(["1"])[1].title, "nested");
		db.exec("ROLLBACK TO nested");
		assert.equal(
			service.getMetadataByGalleryIds(["1"])[1].title,
			"transaction",
		);
		db.exec("ROLLBACK");
		assert.equal(service.getMetadataByGalleryIds(["1"])[1].title, "self");
		external.exec(
			"DELETE FROM archive_gallery_metadata WHERE gallery_id = '1'",
		);
		assert.equal(service.getMetadataByGalleryIds(["1"])[1], undefined);
	} finally {
		external?.close();
		close();
		await rm(root, { recursive: true, force: true });
	}
});
