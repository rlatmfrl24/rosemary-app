import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { promisify } from "node:util";

let running = false;
let attempts = 0;
let failures = 0;
let command = "";
childProcess.execFile = () => {};
childProcess.execFile[promisify.custom] = async (_file, args) => {
	command = args.join(" ");
	return { stdout: running ? '"downloader.exe","1234"\r\n' : "", stderr: "" };
};
mock.method(childProcess, "spawn", () => {
	attempts += 1;
	const child = new EventEmitter();
	child.unref = () => {};
	queueMicrotask(() => {
		if (attempts <= failures) child.emit("error", new Error("spawn failed"));
		else {
			running = true;
			child.emit("spawn");
		}
	});
	return child;
});
syncBuiltinESMExports();
const { ensureProcessRunning } = await import("../src/main/process-utils.ts");
const { prepareHitomiApiConnection } = await import(
	"../src/main/hitomi-api.ts"
);

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const setPlatform = (t, platform) => {
	Object.defineProperty(process, "platform", { value: platform });
	t.after(() => Object.defineProperty(process, "platform", platformDescriptor));
};

test("Windows 실행 확인·중복 실행 방지·재시도·최종 실패", async (t) => {
	setPlatform(t, "win32");
	running = true;
	assert.equal(await ensureProcessRunning("C:/downloader.exe"), false);
	assert.equal(attempts, 0);

	running = false;
	failures = 1;
	const first = ensureProcessRunning("C:/downloader.exe");
	assert.equal(first, ensureProcessRunning("C:/downloader.exe"));
	assert.equal(await first, true);
	assert.equal(attempts, 2);
	assert.match(command, /IMAGENAME eq downloader.exe/);

	running = false;
	attempts = 0;
	failures = 2;
	await assert.rejects(
		ensureProcessRunning("C:/downloader.exe"),
		/spawn failed/,
	);
	assert.equal(attempts, 2);

	failures = 0;
	assert.equal(await ensureProcessRunning("C:/downloader.exe"), true);
});

for (const platform of ["darwin", "linux"]) {
	test(`${platform}: 한 번만 실행하고 프로세스 검증 대기 없이 완료한다`, async (t) => {
		setPlatform(t, platform);
		running = false;
		attempts = 0;
		failures = 0;
		command = "";
		t.mock.method(globalThis, "setTimeout", () => {
			throw new Error("지원하지 않는 프로세스 검증 대기");
		});

		const first = ensureProcessRunning("/opt/downloader");
		assert.equal(first, ensureProcessRunning("/opt/downloader"));
		assert.equal(await first, true);
		assert.equal(attempts, 1);
		assert.equal(command, "");
	});

	test(`${platform}: 실제 실행 오류는 숨기거나 자동 재시도하지 않는다`, async (t) => {
		setPlatform(t, platform);
		attempts = 0;
		failures = 1;
		t.mock.method(globalThis, "setTimeout", () => {
			throw new Error("지원하지 않는 프로세스 검증 대기");
		});
		await assert.rejects(
			ensureProcessRunning("/opt/downloader"),
			/spawn failed/,
		);
		assert.equal(attempts, 1);

		failures = 0;
		assert.equal(await ensureProcessRunning("/opt/downloader"), true);
		assert.equal(attempts, 2);
	});

	test(`${platform}: API 응답을 확인하고 연결된 다운로더를 재실행하지 않는다`, async (t) => {
		setPlatform(t, platform);
		const directory = await mkdtemp(
			path.join(tmpdir(), "rosemary-downloader-"),
		);
		t.after(() => rm(directory, { recursive: true, force: true }));
		const executablePath = path.join(directory, "downloader.exe");
		await writeFile(executablePath, "");
		await mkdir(path.join(directory, "scripts"));
		await writeFile(path.join(directory, "scripts", "api.hds"), "");
		const settings = { hitomiDownloaderPath: executablePath };
		let connectAfter = 0;
		let pings = 0;
		t.mock.method(globalThis, "fetch", async () => {
			pings += 1;
			return new Response("{}", { status: pings > connectAfter ? 200 : 503 });
		});
		attempts = 0;
		failures = 0;

		let result = await prepareHitomiApiConnection(settings);
		assert.equal(result.success, true);
		assert.equal(result.running, true);
		assert.equal(result.apiConnected, true);
		assert.equal(result.launched, false);
		assert.equal(attempts, 0);

		connectAfter = 2;
		result = await prepareHitomiApiConnection(settings);
		assert.equal(result.success, true);
		assert.equal(result.running, true);
		assert.equal(result.apiConnected, true);
		assert.equal(result.launched, true);
		assert.equal(attempts, 1);

		connectAfter = Number.POSITIVE_INFINITY;
		let now = 0;
		t.mock.method(Date, "now", () => {
			now += 16_000;
			return now;
		});
		result = await prepareHitomiApiConnection(settings);
		assert.equal(result.success, false);
		assert.equal(result.running, null);
		assert.equal(result.apiConnected, false);
		assert.equal(attempts, 2);
	});
}
