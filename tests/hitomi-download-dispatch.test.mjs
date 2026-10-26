import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	clearCrawlerDatabaseContent,
	initializeCrawlerDatabase,
} from "../src/main/crawler-database.ts";
import * as api from "../src/main/hitomi-api.ts";
import {
	claimDownloadRequest,
	ensureDownloadRequest,
} from "../src/main/hitomi-download-store.ts";

const source = {
	provider: "e-hentai",
	galleryId: "1000",
	sourceUrl: "https://e-hentai.org/g/1000/0000000001/",
};

const setup = async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "rosemary-send-"));
	await mkdir(path.join(root, "scripts"));
	await writeFile(path.join(root, "downloader.exe"), "");
	await writeFile(path.join(root, "scripts", "api.hds"), "");
	const databasePath = path.join(root, "crawler.sqlite");
	const database = new DatabaseSync(databasePath);
	initializeCrawlerDatabase(database);
	const calls = [];
	let mode = "ok";
	const server = createServer(async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = raw ? JSON.parse(raw) : null;
		calls.push({ endpoint: request.url, body });
		if (request.url === "/download" && mode === "drop") {
			request.socket.destroy();
			return;
		}
		if (request.url === "/valid_url" && mode === "invalid") {
			response.writeHead(400).end(JSON.stringify({ error: "not_valid" }));
			return;
		}
		if (request.url === "/valid_url" && mode === "offline") {
			response.writeHead(503).end(JSON.stringify({ error: "unavailable" }));
			return;
		}
		response.setHeader("Content-Type", "application/json");
		response.end(
			JSON.stringify(
				request.url === "/valid_url"
					? { type: ["hitomi"] }
					: request.url === "/download" && mode === "malformed"
						? { unexpected: true }
						: { status: "ok" },
			),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = `http://127.0.0.1:${server.address().port}`;
	const realFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", (url, options) => {
		assert.equal(new URL(url).origin, "http://127.0.0.1:16009");
		return realFetch(`${address}${new URL(url).pathname}`, options);
	});
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: "linux" });
	t.after(async () => {
		Object.defineProperty(process, "platform", platform);
		database.close();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		await rm(root, { recursive: true, force: true });
	});
	return {
		database,
		databasePath,
		calls,
		settings: { hitomiDownloaderPath: path.join(root, "downloader.exe") },
		setMode: (value) => {
			mode = value;
		},
		downloads: () => calls.filter((call) => call.endpoint === "/download"),
	};
};

test("숫자 입력도 공급자가 명시된 Hitomi 원본 URL로 전송한다", async (t) => {
	const fixture = await setup(t);
	const result = await api.sendCodesToHitomiApi(
		["1000"],
		fixture.settings,
		fixture.database,
	);
	assert.equal(
		fixture.downloads()[0].body.gal_num,
		"https://hitomi.la/galleries/1000.html",
	);
	assert.equal(result.sent, 1);
	assert.equal(result.downloadCompletion, "unverified");
});

test("E-Hentai 전체 원본 URL을 보존하고 재시도·동시 요청은 한 번만 제출한다", async (t) => {
	const fixture = await setup(t);
	await Promise.all([
		api.sendSourcesToHitomiApi([source], fixture.settings, fixture.database),
		api.sendSourcesToHitomiApi([source], fixture.settings, fixture.database),
	]);
	const result = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.deepEqual(
		fixture.downloads().map((call) => call.body.gal_num),
		[source.sourceUrl],
	);
	assert.equal(result.sent, 1);
	const row = fixture.database
		.prepare("SELECT * FROM hitomi_download_requests")
		.get();
	assert.equal(row.provider, "e-hentai");
	assert.equal(row.source_url, source.sourceUrl);
	assert.equal(row.status, "sent");
	assert.equal(row.attempt_count, 1);
});

test("접수 후 응답 유실은 결과 불명으로 남기고 다시 POST하지 않는다", async (t) => {
	const fixture = await setup(t);
	fixture.setMode("drop");
	const first = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.equal(first.unknown, 1);
	assert.equal(first.failed, 0);
	fixture.setMode("ok");
	const retry = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.equal(retry.unknown, 1);
	assert.equal(fixture.downloads().length, 1);
	const reopened = new DatabaseSync(fixture.databasePath);
	try {
		initializeCrawlerDatabase(reopened);
		await api.sendSourcesToHitomiApi([source], fixture.settings, reopened);
	} finally {
		reopened.close();
	}
	assert.equal(fixture.downloads().length, 1);
});

test("확실히 제출 전인 유효성 조회 실패만 안전하게 재시도한다", async (t) => {
	const fixture = await setup(t);
	fixture.setMode("offline");
	const first = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.equal(first.failed, 1);
	assert.equal(fixture.downloads().length, 0);
	fixture.setMode("ok");
	const retry = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.equal(retry.sent, 1);
	assert.equal(fixture.downloads().length, 1);
});

test("HTTP 200의 잘못된 접수 본문도 결과 불명이며 다운로드 완료가 아니다", async (t) => {
	const fixture = await setup(t);
	fixture.setMode("malformed");
	const result = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.equal(result.sent, 0);
	assert.equal(result.unknown, 1);
	assert.equal(result.downloadCompletion, "unverified");
	await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.equal(fixture.downloads().length, 1);
});

test("공급자·작품 ID·토큰이 맞지 않거나 가짜 호스트인 원본은 전송하지 않는다", async (t) => {
	const fixture = await setup(t);
	for (const invalid of [
		{ ...source, galleryId: "2000" },
		{ ...source, provider: "hitomi" },
		{
			...source,
			sourceUrl: "https://e-hentai.org.evil.test/g/1000/0000000001/",
		},
		{ ...source, sourceUrl: "https://e-hentai.org/g/1000/" },
	]) {
		await assert.rejects(
			api.sendSourcesToHitomiApi([invalid], fixture.settings, fixture.database),
		);
	}
	assert.equal(fixture.downloads().length, 0);
});

test("동일 ID의 다른 공급자와 토큰을 구분하고 같은 작품의 EH 미러는 중복 제출하지 않는다", async (t) => {
	const fixture = await setup(t);
	await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	await api.sendSourcesToHitomiApi(
		[
			{
				...source,
				sourceUrl: source.sourceUrl.replace("e-hentai.org", "exhentai.org"),
			},
		],
		fixture.settings,
		fixture.database,
	);
	assert.equal(fixture.downloads().length, 1);
	await api.sendCodesToHitomiApi(
		[source.galleryId],
		fixture.settings,
		fixture.database,
	);
	await api.sendSourcesToHitomiApi(
		[
			{
				...source,
				sourceUrl: source.sourceUrl.replace("0000000001", "0000000002"),
			},
		],
		fixture.settings,
		fixture.database,
	);
	assert.equal(fixture.downloads().length, 3);
});

test("전송 중 종료한 원장은 재시작 시 보류하고 크롤링 DB 초기화로 재전송되지 않는다", async (t) => {
	const fixture = await setup(t);
	ensureDownloadRequest(fixture.database, source);
	assert.equal(claimDownloadRequest(fixture.database, source), true);
	initializeCrawlerDatabase(fixture.database);
	assert.equal(
		fixture.database
			.prepare("SELECT status FROM hitomi_download_requests")
			.get().status,
		"unknown",
	);
	clearCrawlerDatabaseContent(fixture.database);
	const result = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	assert.equal(result.unknown, 1);
	assert.equal(fixture.downloads().length, 0);
});

test("기존 숫자 전송 이력은 원래 EH 링크와 Hitomi 숫자 재시도를 모두 보류한다", async (t) => {
	const fixture = await setup(t);
	fixture.database.exec(`
		INSERT INTO crawl_runs (id,target_url,status,phase,max_pages,started_at) VALUES (1,'https://e-hentai.org/','completed','idle',1,'2026-10-27');
		INSERT INTO crawl_items (code,target_url,type,name,link,created_run_id,discovered_at)
		VALUES ('1000','https://e-hentai.org/','Manga','legacy','https://e-hentai.org/g/1000/0000000001/',1,'2026-10-27');
		INSERT INTO crawl_download_dispatch_items (run_id,gallery_id,status,attempt_count,updated_at) VALUES (1,'1000','sent',1,'2026-10-27');
		ALTER TABLE crawl_download_dispatch_items DROP COLUMN source_key;
		ALTER TABLE crawl_download_dispatch_items DROP COLUMN source_url;
	`);
	initializeCrawlerDatabase(fixture.database);
	const eh = await api.sendSourcesToHitomiApi(
		[source],
		fixture.settings,
		fixture.database,
	);
	const hitomi = await api.sendCodesToHitomiApi(
		[source.galleryId],
		fixture.settings,
		fixture.database,
	);
	assert.equal(eh.unknown, 1);
	assert.equal(hitomi.unknown, 1);
	assert.equal(fixture.downloads().length, 0);
});
