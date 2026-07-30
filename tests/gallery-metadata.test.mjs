import assert from "node:assert/strict";
import test from "node:test";
import {
	getOtherSourceTagGroups,
	getSourceTagNamespaceLabel,
	groupSourceTags,
	resolveFileDisplayMetadata,
} from "../src/renderer/src/utils/gallery-metadata.ts";
import {
	createGalleryMetadataBatches,
	createGalleryMetadataRequestPayload,
	mapGalleryMetadataBatchResponse,
	mapGalleryMetadataResponse,
	parseGalleryIdentity,
} from "../src/shared/gallery-metadata.ts";

const FETCHED_AT = "2026-07-21T00:00:00.000Z";

test("작품 링크에서 유효한 gallery id와 10자리 token만 추출한다", () => {
	assert.deepEqual(
		parseGalleryIdentity("https://e-hentai.org/g/2231376/a7584a5932/"),
		{ galleryId: "2231376", token: "a7584a5932" },
	);
	assert.equal(
		parseGalleryIdentity("https://e-hentai.org/g/2231376/abc123/"),
		null,
	);
	assert.equal(
		parseGalleryIdentity("https://e-hentai.org/?f_search=korean"),
		null,
	);
});

test("gdata 요청을 25개 단위로 나누고 공식 요청 payload로 변환한다", () => {
	const identities = Array.from({ length: 26 }, (_, index) => ({
		galleryId: String(9_000_000 + index),
		token: index.toString(16).padStart(10, "0"),
	}));
	const batches = createGalleryMetadataBatches(identities);

	assert.deepEqual(
		batches.map((batch) => batch.length),
		[25, 1],
	);
	assert.deepEqual(createGalleryMetadataRequestPayload(batches[0]), {
		method: "gdata",
		gidlist: identities
			.slice(0, 25)
			.map((identity) => [Number(identity.galleryId), identity.token]),
		namespace: 1,
	});
});

test("gdata 응답을 E-Hentai 원천 메타데이터와 태그로 변환한다", () => {
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
		},
		FETCHED_AT,
	);

	assert.equal(result.error, undefined);
	assert.equal(result.metadata?.sourceKind, "ehentai-api");
	assert.equal(result.metadata?.postedAt, "2022-05-28T01:53:30.000Z");
	assert.equal(result.metadata?.fileCount, 329);
	assert.equal(result.metadata?.rating, 4.68);
	assert.deepEqual(result.metadata?.tags, [
		{ namespace: "artist", value: "gentsuki", position: 0 },
		{ namespace: "parody", value: "original", position: 1 },
		{ namespace: "unknown", value: "legacy-tag", position: 2 },
	]);
});

test("gdata 응답 오류와 누락 항목을 gallery id별 실패로 반환한다", () => {
	const identities = [
		{ galleryId: "1000", token: "0000000001" },
		{ galleryId: "2000", token: "0000000002" },
		{ galleryId: "3000", token: "0000000003" },
	];
	const result = mapGalleryMetadataBatchResponse(
		[
			{ gid: 1000, token: "0000000001", title: "Mapped", tags: [] },
			{ gid: 2000, error: "Key missing" },
		],
		identities,
		FETCHED_AT,
	);

	assert.deepEqual(
		result.metadata.map((item) => item.galleryId),
		["1000"],
	);
	assert.equal(result.failures.get("2000"), "Key missing");
	assert.equal(
		result.failures.get("3000"),
		"API 응답에 해당 gallery id가 없습니다.",
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
			sourceKind: "ehentai-api",
			token: "abcdef1234",
			title: "원천 제목",
			titleJapanese: "原題",
			category: "Manga",
			expunged: false,
			fetchedAt: FETCHED_AT,
			tags: [
				{ namespace: "artist", value: "source artist", position: 0 },
				{ namespace: "parody", value: "original", position: 1 },
				{ namespace: "group", value: "source circle", position: 2 },
				{ namespace: "language", value: "korean", position: 3 },
			],
		},
	);

	assert.equal(resolved.title, "원천 제목");
	assert.equal(resolved.titleJapanese, "原題");
	assert.equal(resolved.type, "Manga");
	assert.equal(resolved.artist, "source artist");
	assert.equal(resolved.group, "source circle");
	assert.equal(resolved.origin, "Original");
	assert.equal(resolved.language, "korean");
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
			sourceKind: "ehentai-api",
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
	assert.equal(resolved.provenance, "filename-fallback");
});

test("원천 메타데이터가 없으면 파일명 보완값을 표시한다", () => {
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
		provenance: "filename-fallback",
	});
});

test("원천과 파일명 보완값이 모두 없으면 정보 없음으로 표시한다", () => {
	assert.deepEqual(resolveFileDisplayMetadata({ code: "123456" }), {
		code: "123456",
		provenance: "unknown",
	});
});

test("주요 표시 태그를 제외한 namespace를 기타 태그 그룹으로 분리한다", () => {
	const groups = getOtherSourceTagGroups([
		{ namespace: "artist", value: "source artist", position: 0 },
		{ namespace: "character", value: "character a", position: 1 },
		{ namespace: "female", value: "tag a", position: 2 },
		{ namespace: "female", value: "tag b", position: 3 },
	]);

	assert.deepEqual(groups, [
		{ namespace: "character", values: ["character a"] },
		{ namespace: "female", values: ["tag a", "tag b"] },
	]);
	assert.equal(getSourceTagNamespaceLabel("character"), "캐릭터");
});

test("수집 원천 태그를 주요 namespace 순서로 빠짐없이 그룹화한다", () => {
	const groups = groupSourceTags([
		{ namespace: "female", value: "tag a", position: 6 },
		{ namespace: "language", value: "korean", position: 4 },
		{ namespace: "artist", value: "source artist", position: 0 },
		{ namespace: "parody", value: "original", position: 3 },
		{ namespace: "group", value: "source group", position: 2 },
		{ namespace: "artist", value: "second artist", position: 1 },
		{ namespace: "character", value: "character a", position: 5 },
	]);

	assert.deepEqual(groups, [
		{ namespace: "artist", values: ["source artist", "second artist"] },
		{ namespace: "group", values: ["source group"] },
		{ namespace: "parody", values: ["original"] },
		{ namespace: "language", values: ["korean"] },
		{ namespace: "character", values: ["character a"] },
		{ namespace: "female", values: ["tag a"] },
	]);
});
