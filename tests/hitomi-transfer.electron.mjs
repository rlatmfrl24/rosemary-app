// Run after pnpm build. Supply ROSEMARY_PLAYWRIGHT_MODULE and a running HITOMI_DOWNLOADER_PATH.
// Only remote responses are controlled; the real window, IPC, crawler, SQLite and clipboard execute.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import electronPath from "electron";

const { _electron } = await import(
	process.env.ROSEMARY_PLAYWRIGHT_MODULE
		? pathToFileURL(process.env.ROSEMARY_PLAYWRIGHT_MODULE).href
		: "playwright"
);
const downloader = process.env.HITOMI_DOWNLOADER_PATH;
if (!downloader)
	throw new Error(
		"Set HITOMI_DOWNLOADER_PATH to the already running downloader.",
	);
const root = path.resolve(import.meta.dirname, "..");
const profile = await mkdtemp(path.join(tmpdir(), "rosemary-transfer-ui-"));
const sources = [1, 2, 3, 4].map(
	(index) =>
		`${index === 4 ? "http" : "https"}://e-hentai.org/g/90000000${index}/000000000${index}/`,
);
const posts = [];
let allowRetry = false;
const server = createServer(async (request, response) => {
	let raw = "";
	for await (const chunk of request) raw += chunk;
	const body = raw ? JSON.parse(raw) : null;
	const url = new URL(request.url, "http://fixture");
	if (url.pathname === "/listing") {
		response.setHeader("Content-Type", "text/html");
		response.end(
			`<table class="itg gltc"><tbody><tr><td>header</td></tr><tr><td>header</td></tr>${sources.map((link, index) => `<tr><td class="gl1c glcat">Manga</td><td class="gl3c glname"><a href="${link}"><span class="glink">Transfer fixture ${index + 1}</span></a></td></tr>`).join("")}</tbody></table>`,
		);
		return;
	}
	response.setHeader("Content-Type", "application/json");
	if (url.pathname === "/metadata") {
		response.end(
			JSON.stringify({
				gmetadata: body.gidlist.map(([gid, token]) => ({
					gid,
					token,
					title: `Transfer fixture ${gid}`,
					category: "Manga",
					filecount: "1",
					tags: [],
				})),
			}),
		);
		return;
	}
	if (url.pathname === "/valid_url") {
		assert.ok(
			sources.includes(body.gal_num),
			"validation must preserve the original URL",
		);
		if (body.gal_num === sources[2] && !allowRetry) {
			response
				.writeHead(503)
				.end(JSON.stringify({ error: "offline before submission" }));
			return;
		}
		response.end(JSON.stringify({ type: ["hitomi"] }));
		return;
	}
	if (url.pathname === "/download") {
		assert.ok(sources.slice(0, 3).includes(body.gal_num));
		const db = new DatabaseSync(path.join(profile, "crawler.sqlite"), {
			readOnly: true,
		});
		try {
			assert.equal(
				db
					.prepare(
						"SELECT status FROM hitomi_download_requests WHERE source_url = ?",
					)
					.get(body.gal_num).status,
				"submitting",
			);
		} finally {
			db.close();
		}
		posts.push(body.gal_num);
		if (body.gal_num === sources[1]) {
			request.socket.destroy();
			return;
		}
	}
	response.end(JSON.stringify({ status: "ok" }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let app;
const waitForStatus = async (page, predicate) => {
	const deadline = Date.now() + 30000;
	let status;
	while (Date.now() < deadline) {
		status = await page.evaluate(() => window.api.crawler.getStatus());
		if (predicate(status)) return status;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Status did not settle: ${JSON.stringify(status)}`);
};
const launch = async () => {
	const instance = await _electron.launch({
		executablePath: electronPath,
		args: [root],
		env: { ...process.env, ROSEMARY_VALIDATION_USER_DATA_PATH: profile },
		timeout: 20000,
	});
	assert.equal(
		await instance.evaluate(
			({ app }, expected) => app.getPath("userData") === expected,
			profile,
		),
		true,
	);
	const page = await instance.firstWindow();
	page.on("dialog", (dialog) => dialog.accept());
	await page.waitForFunction(() => Boolean(window.api));
	assert.equal(
		await page.evaluate(
			async () => (await window.api.settings.getHitomiApiStatus()).connected,
		),
		true,
		"installed API must answer its real read-only ping",
	);
	await instance.evaluate(async ({ net, session }, fixtureOrigin) => {
		await session.defaultSession.setProxy({ mode: "direct" });
		const originalRequest = net.request.bind(net);
		net.request = (options) => {
			const url = new URL(options.url);
			if (!["e-hentai.org", "api.e-hentai.org"].includes(url.hostname))
				throw new Error("Unexpected crawler host");
			return originalRequest({
				...options,
				url:
					fixtureOrigin +
					(url.hostname === "api.e-hentai.org" ? "/metadata" : "/listing"),
				session: session.defaultSession,
			});
		};
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (input, options) => {
			const url = new URL(input);
			if (url.origin !== "http://127.0.0.1:16009")
				throw new Error("Unexpected fetch destination");
			return originalFetch(fixtureOrigin + url.pathname, options);
		};
	}, origin);
	await page.getByRole("tab", { name: "로컬 크롤링" }).click();
	return { instance, page };
};
try {
	await writeFile(
		path.join(profile, "settings.json"),
		JSON.stringify({
			hitomiDownloaderPath: downloader,
			hitomiApiEnabled: true,
			hitomiApiAutoSendOnCrawlComplete: true,
		}),
	);
	({ instance: app } = await launch());
	let page = await app.firstWindow();
	assert.equal(await app.evaluate(({ app }) => app.getVersion()), "8.4.10");
	await page.getByRole("spinbutton").fill("1");
	await page.getByRole("button", { name: "크롤링 시작", exact: true }).click();
	await waitForStatus(
		page,
		(value) =>
			value.downloadSent === 1 &&
			value.downloadUnknown === 1 &&
			value.downloadFailed === 1 &&
			value.downloadInvalid === 1,
	);
	assert.equal(posts.length, 2);
	assert.match(await page.locator("body").innerText(), /다운로드 완료 미확인/);
	assert.equal(
		(await page
			.getByRole("link", { name: "E-Hentai 원본 열기" })
			.first()
			.getAttribute("href")) !== null,
		true,
	);
	await page
		.getByRole("button", { name: "원본 URL 복사", exact: true })
		.click();
	const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
	assert.deepEqual(clipboard.split("\n").sort(), [...sources].sort());
	allowRetry = true;
	await page
		.getByRole("button", { name: "제출 전 실패 재시도", exact: true })
		.click();
	await waitForStatus(page, (value) => value.downloadSent === 2);
	assert.equal(posts.length, 3);
	assert.equal(posts.filter((value) => value === sources[1]).length, 1);
	assert.equal(
		await page
			.getByRole("button", { name: "제출 전 실패 재시도", exact: true })
			.isDisabled(),
		true,
	);
	await app.close();
	({ instance: app, page } = await launch());
	const restarted = await page.evaluate(() => window.api.crawler.getStatus());
	assert.equal(restarted.downloadSent, 2);
	assert.equal(restarted.downloadUnknown, 1);
	assert.equal(restarted.downloadCompletion, "unverified");
	// An invalid legacy-style URL in the old list must not block an independent next crawl.
	await page.getByRole("button", { name: "크롤링 시작", exact: true }).click();
	await waitForStatus(
		page,
		(value) => value.runId === 2 && value.status === "completed",
	);
	assert.equal(posts.length, 3);
	await page.getByRole("tab", { name: "DB 관리", exact: true }).click();
	await page.getByRole("button", { name: "DB 초기화", exact: true }).click();
	await waitForStatus(page, (value) => value.runId === null);
	await page.getByRole("tab", { name: "로컬 크롤링", exact: true }).click();
	await page.getByRole("spinbutton").fill("1");
	await page.getByRole("button", { name: "크롤링 시작", exact: true }).click();
	await waitForStatus(
		page,
		(value) =>
			value.downloadSent === 2 &&
			value.downloadUnknown === 1 &&
			value.downloadInvalid === 1,
	);
	assert.equal(
		posts.length,
		3,
		"reset and rediscovery must retain the deduplication ledger",
	);
	const db = new DatabaseSync(path.join(profile, "crawler.sqlite"), {
		readOnly: true,
	});
	try {
		const ledger = db
			.prepare(
				"SELECT source_url,status,attempt_count FROM hitomi_download_requests ORDER BY source_url",
			)
			.all();
		assert.equal(ledger.length, 3);
		assert.deepEqual(ledger.map((row) => row.status).sort(), [
			"sent",
			"sent",
			"unknown",
		]);
		assert.ok(ledger.every((row) => row.attempt_count === 1));
	} finally {
		db.close();
	}
	console.log(
		"PASS: installed API read-only ping; actual Electron UI → preload → crawler → controlled API responses; original URLs, response-loss guard, safe retry, restart, clipboard, invalid-origin independence, reset and rediscovery; 3 total POSTs; completion remains unverified.",
	);
} finally {
	if (app) await app.close().catch(() => {});
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	await rm(profile, { recursive: true, force: true });
}
