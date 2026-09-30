import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getPathKey, isSamePath } from "../src/main/path-key.ts";
import { loadMainModules } from "./helpers/main-modules.mjs";

test("경로 키는 Windows에서만 대소문자를 무시한다", () => {
	assert.equal(getPathKey("A.zip", "win32"), getPathKey("a.zip", "win32"));
	for (const platform of ["darwin", "linux"])
		assert.notEqual(
			getPathKey("A.zip", platform),
			getPathKey("a.zip", platform),
		);
});
test("macOS 경로 비교는 대소문자가 다른 별도 파일과 같은 실제 파일을 구분한다", async () => {
	const root = await fs.mkdtemp(path.join(tmpdir(), "rosemary-identity-"));
	try {
		const upper = path.join(root, "A.zip");
		const lower = path.join(root, "a.zip");
		await fs.writeFile(upper, "first");
		if (
			await fs.stat(lower).then(
				() => true,
				() => false,
			)
		) {
			assert.equal(isSamePath(upper, lower, "darwin"), true);
		} else {
			await fs.writeFile(lower, "other");
			assert.equal(isSamePath(upper, lower, "darwin"), false);
			await fs.unlink(lower);
			await fs.link(upper, lower);
			assert.equal(isSamePath(upper, lower, "darwin"), true);
			assert.equal(isSamePath(upper, lower, "linux"), false);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});
test(
	"Linux 실제 스캔 인덱스·압축 분석 캐시는 A.zip과 a.zip을 분리한다",
	{ skip: process.platform !== "linux" },
	async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), "rosemary-paths-"));
		const close = loadMainModules(root);
		try {
			const { scanArchiveFiles } = await import("../src/main/files.ts");
			const { getArchiveContentSummary, flushArchiveContentCache } =
				await import("../src/main/archive-content.ts");
			const scan = path.join(root, "scan");
			await fs.mkdir(scan);
			await fs.writeFile(path.join(scan, "A.zip"), "first");
			await fs.writeFile(path.join(scan, "a.zip"), "other");
			for (let i = 0; i < 2; i++)
				assert.equal((await scanArchiveFiles(scan)).files.length, 2);
			for (const name of ["A.zip", "a.zip"]) {
				const file = path.join(scan, name);
				await getArchiveContentSummary(file, await fs.stat(file), "manifest");
			}
			await flushArchiveContentCache();
			const cache = JSON.parse(
				await fs.readFile(
					path.join(root, "archive-content-cache-v2.json"),
					"utf8",
				),
			);
			assert.equal(Object.keys(cache.records).length, 2);
		} finally {
			close();
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
