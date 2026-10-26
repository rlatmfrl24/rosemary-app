import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { loadMainModules } from "./helpers/main-modules.mjs";

const root = await fs.mkdtemp(path.join(tmpdir(), "rosemary-scan-"));
const close = loadMainModules(root);
const { scanArchiveFiles } = await import("../src/main/files.ts");
after(async () => {
	close();
	await fs.rm(root, { recursive: true, force: true });
});

test("스캔은 제한된 병렬 조회로 순서·인덱스 재사용·변경·삭제를 보존한다", async (t) => {
	const scan = path.join(root, "scan");
	await fs.mkdir(path.join(scan, "nested"), { recursive: true });
	const names = Array.from(
		{ length: 70 },
		(_, index) => `${String(index).padStart(3, "0")}.zip`,
	);
	await Promise.all(
		names.map((name) => fs.writeFile(path.join(scan, name), name)),
	);
	await fs.writeFile(path.join(scan, "nested", "inner.rar"), "nested archive");
	await fs.writeFile(path.join(scan, "image.jpg"), "excluded");
	const originalStat = fs.stat;
	let active = 0;
	let peak = 0;
	t.mock.method(fs, "stat", async (...args) => {
		active++;
		peak = Math.max(peak, active);
		try {
			await new Promise((resolve) => setTimeout(resolve, 1));
			return await originalStat(...args);
		} finally {
			active--;
		}
	});
	const progress = [];
	const first = await scanArchiveFiles(scan, (value) => progress.push(value));
	assert.deepEqual(
		first.files.map((file) => file.name),
		[...names, "inner.rar"],
	);
	assert.ok(peak > 1 && peak <= 32, `동시 stat: ${peak}`);
	assert.ok(progress.length < 20, `진행 이벤트: ${progress.length}`);
	assert.equal(progress.at(-1).phase, "complete");
	assert.equal(first.indexSummary.refreshedCount, 71);
	assert.equal((await scanArchiveFiles(scan)).indexSummary.reusedCount, 71);
	await fs.writeFile(path.join(scan, names[0]), "changed archive content");
	await fs.unlink(path.join(scan, names[1]));
	const changed = await scanArchiveFiles(scan);
	assert.equal(changed.files.length, 70);
	assert.equal(changed.indexSummary.refreshedCount, 1);
	assert.equal(changed.indexSummary.reusedCount, 69);
	assert.equal(changed.indexSummary.removedCount, 1);
});

test("병렬 조회 중 취소는 부분 인덱스를 저장하지 않고 읽기 실패는 나머지 스캔을 유지한다", async (t) => {
	const scan = path.join(root, "cancel");
	await fs.mkdir(scan);
	await fs.writeFile(path.join(scan, "a.zip"), "a");
	await fs.writeFile(path.join(scan, "b.zip"), "b");
	const controller = new AbortController();
	const originalStat = fs.stat;
	const stats = t.mock.method(fs, "stat", async (...args) => {
		controller.abort(new Error("scan cancelled"));
		return await originalStat(...args);
	});
	await assert.rejects(
		scanArchiveFiles(scan, undefined, controller.signal),
		/scan cancelled/,
	);
	stats.mock.restore();
	assert.equal((await scanArchiveFiles(scan)).indexSummary.refreshedCount, 2);
	t.mock.method(fs, "stat", async (...args) => {
		if (args[0] === path.join(scan, "a.zip"))
			throw new Error("cannot read file");
		return await originalStat(...args);
	});
	assert.deepEqual(
		(await scanArchiveFiles(scan)).files.map((file) => file.name),
		["b.zip"],
	);
});
