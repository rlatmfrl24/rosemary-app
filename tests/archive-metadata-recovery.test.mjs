import assert from "node:assert/strict";
import test from "node:test";
import { decodeMessagePackArray } from "../src/main/hitomi-catalog.ts";
import {
	collectArchiveRecoveryCandidates,
	mapHitomiCatalogRecord,
} from "../src/shared/archive-metadata-recovery.ts";

const FETCHED_AT = "2026-07-21T00:00:00.000Z";

test("선택 폴더 파일에서 gallery id를 추출하고 중복과 잘못된 파일명을 제외한다", () => {
	const candidates = collectArchiveRecoveryCandidates([
		{ name: "[Artist] First (123456).zip", path: "D:/archive/a.zip" },
		{ name: "[Artist] Duplicate (123456).7z", path: "D:/archive/b.7z" },
		{ name: "gallery id 없음.zip", path: "D:/archive/invalid.zip" },
		{ name: "Second (987654).rar", path: "D:/archive/sub/c.rar" },
	]);
	assert.deepEqual(
		[...candidates],
		[
			["123456", "D:/archive/a.zip"],
			["987654", "D:/archive/sub/c.rar"],
		],
	);
});

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
		if (text.length < 32)
			return Buffer.concat([Buffer.from([0xa0 | text.length]), text]);
		return Buffer.concat([Buffer.from([0xd9, text.length]), text]);
	}
	if (Array.isArray(value)) {
		const prefix =
			value.length < 16
				? Buffer.from([0x90 | value.length])
				: Buffer.from([0xdc, value.length >> 8, value.length & 0xff]);
		return Buffer.concat([prefix, ...value.map(encodeMessagePack)]);
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

test("Hitomi MessagePack 배열을 읽고 원천 메타데이터로 변환한다", () => {
	const fixture = {
		id: 3828004,
		n: "Source title | 번역 제목",
		type: "artistcg",
		a: ["artist one", "artist two"],
		g: ["fixture group"],
		p: ["original"],
		l: "korean",
		c: ["fixture character"],
		t: ["female:big breasts", "digital", "artist:artist one"],
		pg: 54,
		d: 1_772_963_700,
		unknown: "ignored",
	};
	const values = [];
	const count = decodeMessagePackArray(encodeMessagePack([fixture]), (value) =>
		values.push(value),
	);
	assert.equal(count, 1);

	const metadata = mapHitomiCatalogRecord(values[0], FETCHED_AT);
	assert.equal(metadata?.galleryId, "3828004");
	assert.equal(metadata?.sourceKind, "hitomi-catalog");
	assert.equal(metadata?.title, "Source title | 번역 제목");
	assert.equal(metadata?.titleJapanese, undefined);
	assert.equal(metadata?.category, "Artist CG");
	assert.equal(metadata?.fileCount, 54);
	assert.equal(metadata?.postedAt, "2026-03-08T09:55:00.000Z");
	assert.deepEqual(metadata?.tags, [
		{ namespace: "artist", value: "artist one", position: 0 },
		{ namespace: "artist", value: "artist two", position: 1 },
		{ namespace: "group", value: "fixture group", position: 2 },
		{ namespace: "parody", value: "original", position: 3 },
		{ namespace: "language", value: "korean", position: 4 },
		{ namespace: "character", value: "fixture character", position: 5 },
		{ namespace: "female", value: "big breasts", position: 6 },
		{ namespace: "other", value: "digital", position: 7 },
	]);
});

test("잘렸거나 루트가 배열이 아닌 MessagePack을 거부한다", () => {
	assert.throws(
		() => decodeMessagePackArray(Buffer.from([0x91, 0x81]), () => {}),
		/잘렸거나|길이/,
	);
	assert.throws(
		() => decodeMessagePackArray(encodeMessagePack({ id: 1 }), () => {}),
		/루트가 배열/,
	);
});

test("Hitomi 카탈로그 해석 중 취소 신호를 적용한다", () => {
	const controller = new AbortController();
	controller.abort(new DOMException("fixture-cancel", "AbortError"));
	assert.throws(
		() =>
			decodeMessagePackArray(
				encodeMessagePack(Array.from({ length: 300 }, () => ({ id: 1 }))),
				() => {},
				controller.signal,
			),
		/fixture-cancel/,
	);
});
