import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { loadMainModules } from "./helpers/main-modules.mjs";

const root = await fs.promises.mkdtemp(path.join(tmpdir(), "rosemary-files-"));
const close = loadMainModules(root);
const {
	copyFileToPath,
	moveFileToPath,
	checkDuplicateFiles,
	moveAllFilesToStore,
} = await import("../src/main/files.ts");
const { moveFileWithOverwrite } = await import("../src/main/file-transfer.ts");
after(async () => {
	close();
	await fs.promises.rm(root, { recursive: true, force: true });
});
const makeFolders = async (name) => {
	const scan = path.join(root, name, "scan");
	const store = path.join(root, name, "store");
	await fs.promises.mkdir(scan, { recursive: true });
	await fs.promises.mkdir(store, { recursive: true });
	return { scan, store };
};
const entry = async (folder, name, contents) => {
	const filePath = path.join(folder, name);
	await fs.promises.writeFile(filePath, contents);
	return { path: filePath, name, size: Buffer.byteLength(contents) };
};
const contents = (filePath) => fs.promises.readFile(filePath, "utf8");
const decision = (item, action = "overwrite") => ({
	action,
	targetPath: item.targetPath,
	targetSize: item.targetSize,
	targetModifiedTimeMs: item.targetModifiedTimeMs,
});

test("개별 복사와 이동의 동명 충돌은 양쪽 내용을 보존한다", async () => {
	const { scan, store } = await makeFolders("collision");
	const source = await entry(scan, "book.zip", "source");
	const target = await entry(store, "book.zip", "original");
	for (const operation of [copyFileToPath, moveFileToPath])
		await assert.rejects(operation(source.path, target.path), {
			code: "EEXIST",
		});
	assert.equal(await contents(source.path), "source");
	assert.equal(await contents(target.path), "original");
});

test("동시 이동에서는 하나만 목적지를 생성하고 다른 원본은 보존한다", async () => {
	const { scan, store } = await makeFolders("concurrent");
	const a = await entry(scan, "a.zip", "a");
	const b = await entry(scan, "b.zip", "b");
	const target = path.join(store, "book.zip");
	const results = await Promise.allSettled([
		moveFileToPath(a.path, target),
		moveFileToPath(b.path, target),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	const winner = await contents(target);
	assert.equal(
		await contents(winner === "a" ? b.path : a.path),
		winner === "a" ? "b" : "a",
	);
});

test("복사 실패와 원본 삭제 실패는 원본을 보존한다", async (t) => {
	const { scan, store } = await makeFolders("failure");
	const source = await entry(scan, "book.zip", "source");
	const target = path.join(store, "book.zip");
	const copying = t.mock.method(fs.promises, "copyFile", async () => {
		throw Object.assign(new Error("copy failed"), { code: "EACCES" });
	});
	syncBuiltinESMExports();
	await assert.rejects(moveFileToPath(source.path, target), /copy failed/);
	assert.equal(await contents(source.path), "source");
	copying.mock.restore();
	syncBuiltinESMExports();
	const deleting = t.mock.method(fs.promises, "unlink", async () => {
		throw new Error("delete failed");
	});
	syncBuiltinESMExports();
	await assert.rejects(moveFileToPath(source.path, target), /delete failed/);
	assert.equal(await contents(source.path), "source");
	assert.equal(await contents(target), "source");
	deleting.mock.restore();
	syncBuiltinESMExports();
});

test("EXDEV 덮어쓰기의 복사 실패는 기존 대상을 보존한다", async (t) => {
	const { scan, store } = await makeFolders("exdev");
	const source = await entry(scan, "book.zip", "new");
	const target = await entry(store, "book.zip", "old");
	const rename = fs.promises.rename;
	const moving = t.mock.method(fs.promises, "rename", async (from, to) => {
		if (from === source.path)
			throw Object.assign(new Error("cross device"), { code: "EXDEV" });
		return rename(from, to);
	});
	const copying = t.mock.method(fs.promises, "copyFile", async () => {
		throw new Error("copy failed");
	});
	syncBuiltinESMExports();
	await assert.rejects(
		moveFileWithOverwrite(source.path, target.path),
		/copy failed/,
	);
	assert.equal(await contents(target.path), "old");
	assert.equal(await contents(source.path), "new");
	copying.mock.restore();
	syncBuiltinESMExports();
	await moveFileWithOverwrite(source.path, target.path);
	assert.equal(await contents(target.path), "new");
	await assert.rejects(fs.promises.stat(source.path), { code: "ENOENT" });
	moving.mock.restore();
	syncBuiltinESMExports();
});

test("다른 위치의 gallery id 중복은 검토한 대상에만 덮어쓴다", async () => {
	const { scan, store } = await makeFolders("gallery");
	const source = await entry(scan, "New title (12345).zip", "new");
	const target = await entry(store, "Old title (12345).zip", "old");
	const review = await checkDuplicateFiles([source], scan, store);
	assert.equal(review.duplicates[0].targetPath, target.path);
	const result = await moveAllFilesToStore([source], scan, store, {
		[review.duplicates[0].relativePath]: decision(review.duplicates[0]),
	});
	assert.equal(result.summary.failed, 0);
	assert.equal(await contents(target.path), "new");
	await assert.rejects(fs.promises.stat(path.join(store, source.name)), {
		code: "ENOENT",
	});
});

test("변경되거나 여러 개인 중복 대상과 스캔 밖 파일은 이동하지 않는다", async () => {
	const { scan, store } = await makeFolders("changed");
	const source = await entry(scan, "New (54321).zip", "new");
	const target = await entry(store, "Old (54321).zip", "old");
	const review = await checkDuplicateFiles([source], scan, store);
	const decisions = {
		[review.duplicates[0].relativePath]: decision(review.duplicates[0]),
	};
	await fs.promises.writeFile(target.path, "modified");
	assert.equal(
		(await moveAllFilesToStore([source], scan, store, decisions)).summary
			.failed,
		1,
	);
	await entry(store, "Other (54321).zip", "other");
	assert.equal(
		(await moveAllFilesToStore([source], scan, store, decisions)).summary
			.failed,
		1,
	);
	const outside = await entry(root, "outside.zip", "outside");
	const good = await entry(scan, "good.zip", "good");
	const partial = await moveAllFilesToStore([outside, good], scan, store);
	assert.deepEqual(partial.summary, { total: 2, success: 1, failed: 1 });
	assert.equal(await contents(source.path), "new");
	assert.equal(await contents(outside.path), "outside");
});
