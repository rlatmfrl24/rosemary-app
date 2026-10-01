import assert from "node:assert/strict";
import test from "node:test";
import { getFilterCounts } from "../src/renderer/src/utils/file-review-counts.ts";
import { getNextSelectedRowIndexAfterRemoval } from "../src/renderer/src/utils/selection.ts";
import { createThumbnailBatch } from "../src/renderer/src/utils/thumbnail-batch.ts";

test("썸네일은 100ms마다 모으고 완료 시 즉시 반영하며 취소된 결과는 버린다", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const applied = [];
	const batch = createThumbnailBatch((results) => applied.push([...results]));
	batch.add("a.zip", null);
	t.mock.timers.tick(99);
	batch.add("b.zip", null);
	assert.equal(applied.length, 0);
	t.mock.timers.tick(1);
	assert.deepEqual(applied, [
		[
			["a.zip", null],
			["b.zip", null],
		],
	]);
	batch.add("c.zip", null);
	batch.flush();
	assert.deepEqual(applied[1], [["c.zip", null]]);
	batch.add("old.zip", null);
	batch.cancel();
	batch.add("late.zip", null);
	t.mock.timers.tick(1000);
	batch.flush();
	assert.equal(applied.length, 2);
});

test("필터 개수는 서로 겹치는 검토 조건과 즐겨찾기 제외 조건을 보존한다", () => {
	assert.deepEqual(
		getFilterCounts([
			{},
			{ reviewStatus: "ready", favoriteArtistCandidate: {} },
			{ reviewStatus: "checking", duplicate: true, groupCandidate: {} },
			{ reviewStatus: "ready", duplicate: true, duplicateAction: "overwrite" },
			{ reviewStatus: "review-needed", duplicateAction: "skip" },
			{ duplicateAction: "keep" },
		]),
		{
			all: 6,
			ready: 3,
			"favorite-artist": 1,
			duplicate: 2,
			"group-merge": 1,
			"review-needed": 3,
		},
	);
	assert.equal(getFilterCounts([]).all, 0);
});

test("빈 필터와 마지막 표시 항목 제거는 숨겨진 파일을 선택하지 않는다", () => {
	const currentFiles = [{ path: "a" }, { path: "b" }, { path: "c" }];
	const select = (visibleFileIndexes, selectedRowIndex = 1) =>
		getNextSelectedRowIndexAfterRemoval({
			currentFiles,
			removedPath: "b",
			selectedRowIndex,
			visibleFileIndexes,
		});
	assert.equal(select([]), -1);
	assert.equal(select([1]), -1);
	assert.equal(select([1, 2]), 1);
	assert.equal(select([0, 1]), 0);
	assert.equal(select(undefined), 1);
});
