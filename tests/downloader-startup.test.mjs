import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
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

test("실행 확인·중복 실행 방지·재시도·최종 실패", async () => {
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
