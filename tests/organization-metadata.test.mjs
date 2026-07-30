import assert from "node:assert/strict";
import test from "node:test";
import {
	buildOrganizationMetadataEvidence,
	evaluateOrganizationMetadataCompatibility,
	findOrganizationMetadataConflicts,
	getOrganizationGalleryRelation,
	normalizeOrganizationCategory,
	normalizeOrganizationOrigin,
	resolveDuplicateTarget,
	resolveFavoriteArtistTargets,
} from "../src/shared/organization-metadata.ts";

const createMetadata = (overrides = {}) => ({
	galleryId: "123456",
	canonicalGalleryId: "123456",
	sourceKind: "ehentai-api",
	title: "원천 제목",
	category: "Manga",
	fetchedAt: "2026-07-21T00:00:00.000Z",
	tags: [],
	...overrides,
});

test("원천 복수 작가를 파일명보다 우선하고 gallery 계보를 구성한다", () => {
	const evidence = buildOrganizationMetadataEvidence(
		{
			galleryId: "123456",
			artist: "filename artist",
			type: "Manga",
			origin: "Original",
		},
		createMetadata({
			canonicalGalleryId: "123999",
			parentGalleryId: "120000",
			tags: [
				{ namespace: "artist", value: "artist a", position: 0 },
				{ namespace: "artist", value: "artist b", position: 1 },
				{ namespace: "group", value: "circle", position: 2 },
				{ namespace: "parody", value: "original", position: 3 },
			],
		}),
	);

	assert.deepEqual(evidence.effectiveArtists, ["artist a", "artist b"]);
	assert.equal(evidence.artistSource, "source");
	assert.deepEqual(evidence.groups, ["circle"]);
	assert.deepEqual(evidence.lineageGalleryIds, ["123999", "120000"]);
});

test("원천 작가가 없으면 파일명 작가를 보완값으로 사용한다", () => {
	const evidence = buildOrganizationMetadataEvidence(
		{ artist: "filename artist" },
		createMetadata(),
	);

	assert.deepEqual(evidence.effectiveArtists, ["filename artist"]);
	assert.equal(evidence.artistSource, "filename-fallback");
});

test("복수 원천 작가 중 파일명 작가가 하나와 일치하면 충돌이 아니다", () => {
	const issues = findOrganizationMetadataConflicts(
		"C:/fixture.zip",
		{ artist: "artist b", type: "Artistcg", origin: "Fate GO" },
		createMetadata({
			category: "Artist CG",
			tags: [
				{ namespace: "artist", value: "artist a", position: 0 },
				{ namespace: "artist", value: "artist b", position: 1 },
				{ namespace: "parody", value: "Fate Grand Order", position: 2 },
			],
		}),
	);

	assert.deepEqual(issues, []);
});

test("artist, category, parody 불일치를 필드별 검토 이슈로 만든다", () => {
	const issues = findOrganizationMetadataConflicts(
		"C:/fixture.zip",
		{ artist: "file artist", type: "Manga", origin: "Touhou Project" },
		createMetadata({
			category: "Doujinshi",
			tags: [
				{ namespace: "artist", value: "source artist", position: 0 },
				{ namespace: "parody", value: "Original", position: 1 },
			],
		}),
	);

	assert.deepEqual(
		issues.map((issue) => issue.field),
		["artist", "category", "parody"],
	);
	assert.ok(issues.every((issue) => issue.kind === "metadata-conflict"));
});

test("빈 값과 정보 없음 경로는 충돌로 취급하지 않는다", () => {
	const issues = findOrganizationMetadataConflicts(
		"C:/fixture.zip",
		{ artist: undefined, type: "_unknown_type", origin: "N/A" },
		createMetadata({
			category: "Manga",
			tags: [{ namespace: "parody", value: "Original", position: 0 }],
		}),
	);

	assert.deepEqual(issues, []);
});

test("category와 parody 별칭을 동일 값으로 정규화한다", () => {
	assert.equal(
		normalizeOrganizationCategory("Artistcg"),
		normalizeOrganizationCategory("Artist CG"),
	);
	assert.equal(
		normalizeOrganizationCategory("NonH"),
		normalizeOrganizationCategory("Non-H"),
	);
	assert.equal(
		normalizeOrganizationOrigin("페이트 그랜드 오더"),
		normalizeOrganizationOrigin("Fate GO"),
	);
});

test("복수 작가 중 일치하는 Favorite Artist 대상이 하나일 때만 확정한다", () => {
	const folderA = { targetDirectory: "C:/Favorite/artist a" };
	const folderB = { targetDirectory: "C:/Favorite/artist b" };
	const unique = resolveFavoriteArtistTargets(
		["artist a", "unknown artist"],
		new Map([["artist a", folderA]]),
	);
	assert.equal(unique.status, "matched");
	assert.equal(unique.matches[0].target, folderA);

	const multiple = resolveFavoriteArtistTargets(
		["artist a", "artist b"],
		new Map([
			["artist a", folderA],
			["artist b", folderB],
		]),
	);
	assert.equal(multiple.status, "ambiguous");

	const duplicatedFolder = resolveFavoriteArtistTargets(
		["artist a"],
		new Map([["artist a", null]]),
	);
	assert.equal(duplicatedFolder.status, "ambiguous");
});

test("group, parody, category 일치를 3·2·1점 보조 근거로 계산한다", () => {
	assert.deepEqual(
		evaluateOrganizationMetadataCompatibility({
			leftGroups: ["circle"],
			rightGroups: ["Circle"],
			leftParodies: ["Fate GO"],
			rightParodies: ["Fate Grand Order"],
			leftCategory: "Artistcg",
			rightCategories: ["Artist CG"],
		}),
		{
			boost: 6,
			reasons: ["원천 그룹 일치", "원천 오리진 일치", "원천 유형 일치"],
			hasMismatch: false,
		},
	);
	assert.equal(
		evaluateOrganizationMetadataCompatibility({
			leftGroups: ["circle a"],
			rightGroups: ["circle b"],
			leftParodies: [],
			rightParodies: [],
			rightCategories: [],
		}).hasMismatch,
		true,
	);
});

test("실제 gallery id 일치를 갱신 계보보다 우선한다", () => {
	const evidence = buildOrganizationMetadataEvidence(
		{ galleryId: "1000" },
		createMetadata({ galleryId: "1000", canonicalGalleryId: "2000" }),
	);
	assert.equal(
		getOrganizationGalleryRelation(
			evidence,
			new Set(["1000"]),
			new Set(["2000"]),
		),
		"exact",
	);
	assert.equal(
		getOrganizationGalleryRelation(
			evidence,
			new Set(["3000"]),
			new Set(["2000"]),
		),
		"lineage",
	);
});

test("gallery id 중복 대상과 상대 경로 대상을 보수적으로 선택한다", () => {
	const isSamePath = (left, right) =>
		left.toLowerCase() === right.toLowerCase();
	assert.deepEqual(
		resolveDuplicateTarget({
			galleryId: "1000",
			galleryTargetPaths: ["C:/Store/A.zip"],
			exactTargetPath: "C:/Store/A.zip",
			exactTargetExists: true,
			isSamePath,
		}),
		{
			status: "matched",
			targetPath: "C:/Store/A.zip",
			matchKind: "gallery-id-and-path",
		},
	);
	assert.equal(
		resolveDuplicateTarget({
			galleryId: "1000",
			galleryTargetPaths: ["C:/Store/A.zip", "C:/Store/B.zip"],
			exactTargetPath: "C:/Store/A.zip",
			exactTargetExists: true,
			isSamePath,
		}).status,
		"ambiguous",
	);
	assert.equal(
		resolveDuplicateTarget({
			galleryId: "1000",
			galleryTargetPaths: ["C:/Store/A.zip"],
			exactTargetPath: "C:/Store/B.zip",
			exactTargetExists: true,
			isSamePath,
		}).status,
		"ambiguous",
	);
	assert.equal(
		resolveDuplicateTarget({
			galleryTargetPaths: [],
			exactTargetPath: "C:/Store/A.zip",
			exactTargetExists: true,
			isSamePath,
		}).matchKind,
		"relative-path",
	);
});
