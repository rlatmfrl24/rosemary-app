import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HitomiCatalogIndex } from "../src/main/hitomi-catalog-index.ts";

const encodeMessagePack = (value) => {
	if (typeof value === "number") {
		if (value >= 0 && value <= 0x7f) return Buffer.from([value]);
		const buffer = Buffer.alloc(5);
		buffer[0] = 0xce;
		buffer.writeUInt32BE(value, 1);
		return buffer;
	}
	if (typeof value === "string") {
		const text = Buffer.from(value, "utf8");
		if (text.length < 32) {
			return Buffer.concat([Buffer.from([0xa0 | text.length]), text]);
		}
		return Buffer.concat([Buffer.from([0xd9, text.length]), text]);
	}
	if (Array.isArray(value)) {
		assert.ok(value.length < 16);
		return Buffer.concat([
			Buffer.from([0x90 | value.length]),
			...value.map(encodeMessagePack),
		]);
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		assert.ok(entries.length < 16);
		return Buffer.concat([
			Buffer.from([0x80 | entries.length]),
			...entries.flatMap(([key, item]) => [
				encodeMessagePack(key),
				encodeMessagePack(item),
			]),
		]);
	}
	throw new Error(`fixture에서 지원하지 않는 값입니다: ${String(value)}`);
};

const createCatalogFixture = async (
	rootPath,
	records,
	count = records.length,
) => {
	const catalogPath = path.join(rootPath, "hitomi_data");
	await fs.mkdir(catalogPath, { recursive: true });
	await fs.writeFile(
		path.join(catalogPath, "galleries0_pack.json"),
		encodeMessagePack(records),
	);
	await fs.writeFile(
		path.join(catalogPath, "completed_v3.2b"),
		JSON.stringify({
			time: 1_772_966_052,
			min: Math.min(...records.map((record) => record.id)),
			max: Math.max(...records.map((record) => record.id)),
			count,
		}),
	);
	return catalogPath;
};

test("Hitomi 전체 카탈로그를 오프셋 인덱스로 만들고 필요한 gallery만 조회한다", async () => {
	const rootPath = await fs.mkdtemp(
		path.join(os.tmpdir(), "rosemary-hitomi-index-"),
	);
	try {
		const catalogPath = await createCatalogFixture(rootPath, [
			{
				id: 1001,
				n: "첫 번째 작품",
				type: "manga",
				a: ["artist one"],
				t: ["female:tag one"],
				pg: 10,
			},
			{
				id: 1002,
				n: "두 번째 작품",
				type: "artistcg",
				g: ["group one"],
				l: "korean",
				pg: 20,
			},
		]);
		const userDataPath = path.join(rootPath, "profile", "nested");
		const index = new HitomiCatalogIndex(userDataPath);
		const metadata = await index.lookup(
			catalogPath,
			["1002", "9999", "invalid"],
			"2026-07-21T00:00:00.000Z",
		);

		assert.equal(metadata.size, 1);
		assert.equal(metadata.get("1002")?.title, "두 번째 작품");
		assert.equal(metadata.get("1002")?.category, "Artist CG");
		assert.deepEqual(metadata.get("1002")?.tags, [
			{ namespace: "group", value: "group one", position: 0 },
			{ namespace: "language", value: "korean", position: 1 },
		]);
		assert.deepEqual(index.getStatus(), {
			status: "ready",
			fingerprint: index.getStatus().fingerprint,
			catalogUpdatedAt: "2026-03-08T10:34:12.000Z",
			recordCount: 2,
			minGalleryId: "1001",
			maxGalleryId: "1002",
			packCount: 1,
			processedPackCount: 1,
			builtAt: index.getStatus().builtAt,
			error: undefined,
		});

		const reopened = new HitomiCatalogIndex(userDataPath);
		const reopenedStatus = await reopened.ensureIndex(catalogPath);
		assert.equal(reopenedStatus.status, "ready");
		assert.equal(reopenedStatus.builtAt, index.getStatus().builtAt);
	} finally {
		await fs.rm(rootPath, { recursive: true, force: true });
	}
});

test("완료 마커와 pack 레코드 수가 다르면 인덱스를 게시하지 않는다", async () => {
	const rootPath = await fs.mkdtemp(
		path.join(os.tmpdir(), "rosemary-hitomi-index-"),
	);
	try {
		const catalogPath = await createCatalogFixture(
			rootPath,
			[{ id: 2001, n: "불완전 카탈로그", type: "manga" }],
			2,
		);
		const userDataPath = path.join(rootPath, "profile", "nested");
		const index = new HitomiCatalogIndex(userDataPath);
		await assert.rejects(
			index.ensureIndex(catalogPath),
			/레코드 수가 완료 마커와 다릅니다/,
		);
		assert.equal(index.getStatus().status, "error");
		await assert.rejects(
			fs.access(path.join(userDataPath, "hitomi-catalog-index.sqlite")),
		);
	} finally {
		await fs.rm(rootPath, { recursive: true, force: true });
	}
});
