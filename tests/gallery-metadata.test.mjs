import assert from "node:assert/strict";
import test from "node:test";
import { resolveFileDisplayMetadata } from "../src/renderer/src/utils/gallery-metadata.ts";
import {
	calculateMetadataCoverage,
	mapGalleryMetadataResponse,
	parseGalleryIdentity,
} from "../src/shared/gallery-metadata.ts";

const FETCHED_AT = "2026-07-21T00:00:00.000Z";

test("작품 링크에서 gallery id와 token을 추출한다", () => {
	assert.deepEqual(
		parseGalleryIdentity("https://e-hentai.org/g/2231376/a7584a5932/"),
		{
			galleryId: "2231376",
			token: "a7584a5932",
		},
	);
	assert.equal(
		parseGalleryIdentity("https://e-hentai.org/?f_search=korean"),
		null,
	);
});

test("gdata 응답을 원천 메타데이터와 namespace 태그로 변환한다", () => {
	const result = mapGalleryMetadataResponse(
		{
			gid: 2231376,
			token: "a7584a5932",
			title: "Source title",
			title_jpn: "원문 제목",
			category: "Artist CG",
			uploader: "Uploader",
			posted: "1653702810",
			filecount: "329",
			filesize: 419547090,
			rating: "4.68",
			expunged: false,
			tags: ["artist:gentsuki", "parody:original", "legacy-tag"],
			parent_gid: "2197090",
			parent_key: "parent-token",
			current_gid: "2924387",
			current_key: "current-token",
			first_gid: "2043548",
			first_key: "first-token",
		},
		FETCHED_AT,
	);

	assert.equal(result.error, undefined);
	assert.deepEqual(result.metadata, {
		galleryId: "2231376",
		token: "a7584a5932",
		title: "Source title",
		titleJapanese: "원문 제목",
		category: "Artist CG",
		uploader: "Uploader",
		postedAt: "2022-05-28T01:53:30.000Z",
		fileCount: 329,
		fileSize: 419547090,
		rating: 4.68,
		expunged: false,
		parentGalleryId: "2197090",
		parentToken: "parent-token",
		currentGalleryId: "2924387",
		currentToken: "current-token",
		firstGalleryId: "2043548",
		firstToken: "first-token",
		fetchedAt: FETCHED_AT,
		tags: [
			{ namespace: "artist", value: "gentsuki", position: 0 },
			{ namespace: "parody", value: "original", position: 1 },
			{ namespace: "unknown", value: "legacy-tag", position: 2 },
		],
	});
});

test("선택 필드가 비어 있어도 최소 메타데이터를 유지한다", () => {
	const result = mapGalleryMetadataResponse(
		{
			gid: "1000",
			token: "abc123",
			title: " ",
			category: null,
			posted: "not-a-number",
			filecount: "",
			expunged: true,
			tags: ["", 123, "language:korean"],
		},
		FETCHED_AT,
	);

	assert.equal(result.metadata?.title, "");
	assert.equal(result.metadata?.category, "");
	assert.equal(result.metadata?.postedAt, undefined);
	assert.equal(result.metadata?.fileCount, undefined);
	assert.equal(result.metadata?.expunged, true);
	assert.deepEqual(result.metadata?.tags, [
		{ namespace: "language", value: "korean", position: 2 },
	]);
});

test("API 오류와 필수 식별자 누락을 실패로 반환한다", () => {
	assert.deepEqual(
		mapGalleryMetadataResponse(
			{ gid: 2231376, error: "Key missing, or incorrect key provided." },
			FETCHED_AT,
		),
		{
			galleryId: "2231376",
			error: "Key missing, or incorrect key provided.",
		},
	);
	assert.match(
		mapGalleryMetadataResponse({ gid: 1000 }, FETCHED_AT).error ?? "",
		/token/,
	);
});

test("원천 정보가 완전하면 원천 값만 표시한다", () => {
	const resolved = resolveFileDisplayMetadata(
		{
			title: "파일명 제목",
			type: "파일명 유형",
			artist: "파일명 작가",
			origin: "파일명 원작",
			code: "123456",
		},
		{
			galleryId: "123456",
			token: "abcdef1234",
			title: "원천 제목",
			titleJapanese: "原題",
			category: "Manga",
			expunged: false,
			fetchedAt: FETCHED_AT,
			tags: [
				{ namespace: "artist", value: "source artist", position: 0 },
				{ namespace: "parody", value: "original", position: 1 },
			],
		},
	);

	assert.equal(resolved.title, "원천 제목");
	assert.equal(resolved.titleJapanese, "原題");
	assert.equal(resolved.type, "Manga");
	assert.equal(resolved.artist, "source artist");
	assert.equal(resolved.origin, "Original");
	assert.equal(resolved.provenance, "source");
});

test("원천 필드가 비어 있으면 파일명 값으로만 보완한다", () => {
	const resolved = resolveFileDisplayMetadata(
		{
			title: "파일명 제목",
			type: "파일명 유형",
			artist: "파일명 작가",
			origin: "파일명 원작",
			code: "123456",
		},
		{
			galleryId: "123456",
			token: "abcdef1234",
			title: "원천 제목",
			category: "",
			expunged: false,
			fetchedAt: FETCHED_AT,
			tags: [],
		},
	);

	assert.equal(resolved.title, "원천 제목");
	assert.equal(resolved.type, "파일명 유형");
	assert.equal(resolved.artist, "파일명 작가");
	assert.equal(resolved.origin, "파일명 원작");
	assert.equal(resolved.provenance, "mixed");
});

test("원천 메타데이터가 없으면 기존 파일명 표시를 유지한다", () => {
	const fallback = {
		title: "파일명 제목",
		type: "파일명 유형",
		artist: "파일명 작가",
		origin: "파일명 원작",
		code: "123456",
	};
	const resolved = resolveFileDisplayMetadata(fallback);

	assert.deepEqual(resolved, {
		...fallback,
		provenance: "filename",
	});
});

test("백필 대상은 메타데이터가 없고 gallery id와 token이 일치하는 항목만 선택한다", () => {
	const coverage = calculateMetadataCoverage([
		{
			code: "1000",
			link: "https://e-hentai.org/g/1000/abcdef1234/",
			hasMetadata: true,
		},
		{
			code: "2000",
			link: "https://e-hentai.org/g/2000/bcdef12345/",
			hasMetadata: false,
		},
		{
			code: "3000",
			link: "https://e-hentai.org/g/9999/cdef123456/",
			hasMetadata: false,
		},
		{
			code: "4000",
			link: "https://e-hentai.org/?f_search=korean",
			hasMetadata: false,
		},
	]);

	assert.deepEqual(coverage, {
		metadataCount: 1,
		missingGalleryIds: ["2000"],
		invalidLinkCount: 2,
	});
});
