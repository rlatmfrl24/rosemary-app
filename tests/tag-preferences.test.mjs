import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeCrawlerDatabase } from "../src/main/crawler-database.ts";
import {
	deleteTagPreference,
	listTagPreferences,
	upsertTagPreference,
} from "../src/main/tag-preferences.ts";
import {
	countMatchingTagPreferences,
	getMatchingTagPreferences,
	getTagPreferenceKey,
	matchesAnyTagPreference,
} from "../src/shared/tag-preferences.ts";

const NOW = "2026-07-30T00:00:00.000Z";
const LATER = "2026-07-30T00:01:00.000Z";

test("태그는 namespace와 값을 정규화한 조합으로 구분한다", () => {
	assert.equal(
		getTagPreferenceKey({ namespace: " Artist ", value: "Some Tag " }),
		getTagPreferenceKey({ namespace: "artist", value: "some tag" }),
	);
	assert.notEqual(
		getTagPreferenceKey({ namespace: "artist", value: "same" }),
		getTagPreferenceKey({ namespace: "female", value: "same" }),
	);
	assert.equal(getTagPreferenceKey({ namespace: "", value: "tag" }), null);
});

test("작품 태그는 선택한 선호 태그 중 하나라도 일치하면 포함하고 일치 개수를 센다", () => {
	const tags = [
		{ namespace: "artist", value: "Source Artist", position: 0 },
		{ namespace: "female", value: "Tag A", position: 1 },
		{ namespace: "female", value: "Tag B", position: 2 },
	];
	const preferences = [
		{ namespace: "ARTIST", value: "source artist" },
		{ namespace: "female", value: "tag b" },
		{ namespace: "male", value: "tag a" },
	];

	assert.equal(matchesAnyTagPreference(tags, preferences), true);
	assert.equal(countMatchingTagPreferences(tags, preferences), 2);
	assert.deepEqual(
		getMatchingTagPreferences(tags, preferences).map((item) => item.value),
		["source artist", "tag b"],
	);
});

test("동일 태그를 다시 저장하면 선호와 제외가 상호 전환되고 DB 재연결 후에도 유지된다", () => {
	const tempDirectory = mkdtempSync(
		path.join(tmpdir(), "rosemary-tag-preferences-"),
	);
	const databasePath = path.join(tempDirectory, "crawler.sqlite");
	let database = new DatabaseSync(databasePath);

	try {
		initializeCrawlerDatabase(database);
		const preferred = upsertTagPreference(
			database,
			{
				namespace: " female ",
				value: "Tag A",
				kind: "preferred",
			},
			NOW,
		);
		const excluded = upsertTagPreference(
			database,
			{
				namespace: "FEMALE",
				value: "tag a",
				kind: "excluded",
			},
			LATER,
		);

		assert.equal(preferred.key, excluded.key);
		assert.equal(excluded.kind, "excluded");
		assert.equal(excluded.createdAt, NOW);
		assert.equal(excluded.updatedAt, LATER);
		assert.equal(listTagPreferences(database).length, 1);

		database.close();
		database = new DatabaseSync(databasePath);
		initializeCrawlerDatabase(database);
		assert.deepEqual(
			listTagPreferences(database).map(({ kind, namespace, value }) => ({
				kind,
				namespace,
				value,
			})),
			[{ kind: "excluded", namespace: "FEMALE", value: "tag a" }],
		);

		deleteTagPreference(database, {
			namespace: "female",
			value: "TAG A",
		});
		assert.deepEqual(listTagPreferences(database), []);
	} finally {
		database.close();
		rmSync(tempDirectory, { recursive: true, force: true });
	}
});
