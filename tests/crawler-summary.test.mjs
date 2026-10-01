import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadMainModules } from "./helpers/main-modules.mjs";

test("DB 요약은 공식·카탈로그 메타데이터의 합집합과 미보유 개수를 집계한다", async () => {
	const profile = mkdtempSync(path.join(tmpdir(), "rosemary-summary-"));
	const close = loadMainModules(profile);
	try {
		const { CrawlerService } = await import("../src/main/crawler.ts");
		const service = new CrawlerService(profile);
		const db = service.db;
		assert.equal(service.getDatabaseSummary().metadataCount, 0);
		assert.equal(service.getDatabaseSummary().metadataMissingCount, 0);
		db.exec(`INSERT INTO crawl_runs(id,target_url,status,phase,max_pages,started_at)
			VALUES(1,'summary','completed','front',1,'2026-10-01');`);
		const insert =
			db.prepare(`INSERT INTO crawl_items(code,target_url,type,name,link,created_run_id,discovered_at)
			VALUES(?,'summary','Manga',?,'https://example.com/',1,'2026-10-01')`);
		for (const id of ["1", "2", "3", "4"]) insert.run(id, `Title ${id}`);
		db.exec(`INSERT INTO crawl_item_metadata(gallery_id,token,title,category,fetched_at)
			VALUES('1','token','Official','Manga','2026-10-01'),('3','token','Both','Manga','2026-10-01');
			INSERT INTO archive_gallery_metadata(gallery_id,source_kind,title,category,fetched_at)
			VALUES('2','hitomi-catalog','Catalog','Manga','2026-10-01'),('3','hitomi-catalog','Both','Manga','2026-10-01');`);
		const summary = service.getDatabaseSummary();
		assert.equal(summary.itemCount, 4);
		assert.equal(summary.metadataCount, 3);
		assert.equal(summary.metadataMissingCount, 1);
		assert.equal(summary.metadataInvalidLinkCount, 0);
	} finally {
		close();
		rmSync(profile, { recursive: true, force: true });
	}
});
