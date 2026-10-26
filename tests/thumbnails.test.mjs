import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await fs.mkdtemp(path.join(tmpdir(), "rosemary-thumbnails-"));
const archive = Buffer.from(
	"UEsDBBQAAAAAAMJWQV1raWzURAAAAEQAAAAIAAAAcGFnZS5wbmeJUE5HDQoaCgAAAA1JSERSAAAAAQAAAAEIBAAAALUcDAIAAAALSURBVHjaY/z/HwADAwIA76M3WwAAAABJRU5ErkJgglBLAQIUABQAAAAAAMJWQV1raWzURAAAAEQAAAAIAAAAAAAAAAAAAACAAQAAAABwYWdlLnBuZ1BLBQYAAAAAAQABADYAAABqAAAAAAA=",
	"base64",
);
const hooks = registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "electron")
			return { url: "rosemary-test:thumbnail-electron", shortCircuit: true };
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && !specifier.endsWith(".ts"))
				return next(`${specifier}.ts`, context);
			throw error;
		}
	},
	load(url, context, next) {
		if (url === "rosemary-test:thumbnail-electron")
			return {
				format: "module",
				source: `export const app = { getFileIcon: async () => { throw Error('unexpected icon fallback'); } };
				export const nativeImage = { createFromBuffer: (buffer) => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toJPEG: () => buffer }) };`,
				shortCircuit: true,
			};
		return next(url, context);
	},
});
const { createFileThumbnail } = await import("../src/main/thumbnails.ts");
after(async () => {
	hooks.deregister();
	await fs.rm(root, { recursive: true, force: true });
});

test("ZIP 썸네일은 tail을 재사용하고 중복 stat·재스캔 압축 읽기를 생략한다", async (t) => {
	const file = path.join(root, "small.zip");
	await fs.writeFile(file, archive);
	const originalOpen = fs.open;
	let reads = 0;
	const opened = t.mock.method(fs, "open", async (...args) => {
		const handle = await originalOpen(...args);
		t.mock.method(handle, "stat", () => assert.fail("중복 stat"));
		const originalRead = handle.read.bind(handle);
		t.mock.method(handle, "read", async (...readArgs) => {
			reads++;
			return await originalRead(...readArgs);
		});
		return handle;
	});
	const first = await createFileThumbnail(file);
	assert.equal(first.source, "archive-image");
	assert.equal(reads, 3);
	assert.equal(await createFileThumbnail(file), first);
	assert.equal(opened.mock.callCount(), 1);
	await fs.utimes(file, new Date(), new Date(Date.now() + 10_000));
	assert.notEqual(await createFileThumbnail(file), first);
	assert.equal(opened.mock.callCount(), 2);
});

test("tail보다 큰 ZIP 중앙 디렉터리도 표지 이미지를 읽는다", async () => {
	const directory = Buffer.concat(
		Array.from({ length: 1500 }, () => archive.subarray(106, 160)),
	);
	const end = Buffer.from(archive.subarray(160));
	end.writeUInt16LE(1500, 8);
	end.writeUInt16LE(1500, 10);
	end.writeUInt32LE(directory.length, 12);
	const file = path.join(root, "large-directory.zip");
	await fs.writeFile(
		file,
		Buffer.concat([archive.subarray(0, 106), directory, end]),
	);
	assert.equal((await createFileThumbnail(file)).source, "archive-image");
});
