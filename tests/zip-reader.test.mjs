import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { readZipImageBuffer } from "../src/main/zip-reader.ts";

test("정상 ZIP 데이터와 크기 위조·잘림·저장 방식 불일치를 검증한다", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "rosemary-zip-"));
	const original = Buffer.alloc(1024 * 1024, 65);
	const compressed = deflateRawSync(original);
	const buffer = Buffer.alloc(30 + compressed.length);
	buffer.writeUInt32LE(0x04034b50);
	compressed.copy(buffer, 30);
	const filePath = path.join(root, "image.zip");
	await writeFile(filePath, buffer);
	const handle = await open(filePath, "r");
	const entry = {
		localHeaderOffset: 0,
		compressedSize: compressed.length,
		uncompressedSize: original.length,
		method: 8,
	};
	try {
		assert.deepEqual(
			await readZipImageBuffer(handle, entry, 80 * 1024 * 1024),
			original,
		);
		await assert.rejects(
			readZipImageBuffer(
				handle,
				{ ...entry, uncompressedSize: 1024 },
				80 * 1024 * 1024,
			),
			{ code: "ERR_BUFFER_TOO_LARGE" },
		);
		assert.equal(await readZipImageBuffer(handle, entry, 1024), null);
		assert.equal(
			await readZipImageBuffer(
				handle,
				{ ...entry, compressedSize: buffer.length + 1 },
				original.length,
			),
			null,
		);
		assert.equal(
			await readZipImageBuffer(
				handle,
				{ ...entry, method: 0 },
				original.length,
			),
			null,
		);
	} finally {
		await handle.close();
		await rm(root, { recursive: true, force: true });
	}
});
