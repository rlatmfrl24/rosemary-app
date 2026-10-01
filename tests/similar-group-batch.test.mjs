import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { loadMainModules } from "./helpers/main-modules.mjs";

const root = await fs.promises.mkdtemp(path.join(tmpdir(), "rosemary-batch-"));
const close = loadMainModules(root);
const { shell } = await import("electron");
const {
	previewSimilarGroupBatch: preview,
	executeSimilarGroupBatch: execute,
	cancelSimilarGroupBatch: cancel,
	excludeBatchConflicts,
} = await import("../src/main/similar-group-batch.ts");
const { findSimilarGroups, markSimilarGroupReviewState } = await import(
	"../src/main/files.ts"
);
const { withOrganizerMutation, stopOrganizerMutation } = await import(
	"../src/main/organizer-operation.ts"
);
const { buildGroupRecommendation, getSimilarGroupBatchExclusion } =
	await import("../src/shared/similar-group-recommendation.ts");
const { validateIpcInputs } = await import("../src/main/ipc-inputs.ts");
let sequence = 0;
const setup = async (
	queue = "series",
	names = [
		"[Artist] Story vol 1.zip",
		"[Artist] Story vol 2.zip",
		"[Artist] Story vol 3.zip",
	],
) => {
	const owner = ++sequence;
	const sourcePath = path.join(root, `source-${owner}`);
	await fs.promises.mkdir(sourcePath);
	const files = await Promise.all(
		names.map(async (name, index) => {
			const filePath = path.join(sourcePath, name);
			await fs.promises.writeFile(filePath, `contents-${index}`);
			return filePath;
		}),
	);
	return {
		owner,
		files,
		options: {
			sourcePath,
			recursive: true,
			minGroupSize: 2,
			minConfidence: 90,
			queue,
			contentScanMode: "off",
			forceRefresh: true,
		},
	};
};
const eligible = (plan) => plan.items.filter((item) => !item.exclusionReason);
const executeAll = (context, plan, progress) =>
	execute(
		context.owner,
		plan.planId,
		eligible(plan).map((item) => item.id),
		undefined,
		progress,
	);
const exists = async (filePath) =>
	fs.promises.stat(filePath).then(
		() => true,
		(error) => {
			if (error.code === "ENOENT") return false;
			throw error;
		},
	);
const patch = async (name, replacement, run) => {
	const original = fs.promises[name];
	fs.promises[name] = replacement(original);
	syncBuiltinESMExports();
	try {
		return await run();
	} finally {
		fs.promises[name] = original;
		syncBuiltinESMExports();
	}
};
after(async () => {
	close();
	assert.ok(root.startsWith(path.join(tmpdir(), "rosemary-batch-")));
	await fs.promises.rm(root, { recursive: true, force: true });
});

test("현재 추천을 공유하고 89/90 경계·의심·검토 상태를 적용한다", () => {
	const file = (name, size, time) => ({
		name,
		path: path.join(root, name),
		relativePath: name,
		size,
		modifiedTimeMs: time,
		code: "12345",
		title: "Story",
		baseTitle: "Story",
		seriesTokens: [],
		editionTokens: [],
	});
	const group = {
		files: [file("old.zip", 10, 1), file("new.zip", 50, 2)],
		queue: "cleanup",
		recommendationAction: "trash",
		reasons: [],
		confidence: 89,
	};
	assert.equal(buildGroupRecommendation(group).keepFiles[0].name, "new.zip");
	assert.match(getSimilarGroupBatchExclusion(group, 90), /미만/);
	assert.equal(
		getSimilarGroupBatchExclusion({ ...group, confidence: 90 }, 90),
		undefined,
	);
	assert.match(
		getSimilarGroupBatchExclusion({ ...group, queue: "suspicious" }, 90),
		/근거/,
	);
	for (const reviewStatus of ["ignored", "confirmed"])
		assert.match(
			getSimilarGroupBatchExclusion({ ...group, reviewStatus }, 90),
			/완료/,
		);
	group.files[1].size = 10;
	assert.equal(buildGroupRecommendation(group).keepFiles[0].name, "new.zip");
});

test("처리/유지 충돌은 양쪽을 제외하고 유지 파일만 공유하면 허용한다", () => {
	const item = (id, process, keep) => ({
		id,
		processFiles: process.map((path) => ({ path })),
		keepFiles: keep.map((path) => ({ path })),
	});
	const items = [
		item("a", ["a"], ["b"]),
		item("b", ["b"], ["c"]),
		item("c", ["d"], ["e"]),
		item("d", ["f"], ["e"]),
	];
	excludeBatchConflicts(items, (value) => value);
	assert.ok(items[0].exclusionReason && items[1].exclusionReason);
	assert.equal(items[2].exclusionReason, undefined);
	assert.equal(items[3].exclusionReason, undefined);
});

test("세 파일 그룹을 실제 한 폴더에 보존하고 완료 상태를 저장한다", async () => {
	const context = await setup();
	const plan = await preview(context.owner, context);
	assert.equal(eligible(plan).length, 1);
	const result = await executeAll(context, plan);
	assert.equal(result.items[0].status, "succeeded");
	const target = result.items[0].targetPath;
	assert.equal((await fs.promises.readdir(target)).length, 3);
	for (const [index, file] of context.files.entries()) {
		assert.equal(await exists(file), false);
		assert.equal(
			await fs.promises.readFile(
				path.join(target, path.basename(file)),
				"utf8",
			),
			`contents-${index}`,
		);
	}
	const states = JSON.parse(
		await fs.promises.readFile(
			path.join(root, "similar-group-review-state.json"),
			"utf8",
		),
	);
	assert.equal(
		states.records[
			`${plan.items[0].group.reviewKey}::${plan.items[0].group.contentSignature}`
		].status,
		"confirmed",
	);
	await assert.rejects(executeAll(context, plan), /이미 실행/);
});

test("휴지통 추천은 단건과 같고 유지 파일은 남긴다", async () => {
	const context = await setup("cleanup", [
		"[Artist] Story old (12345).zip",
		"[Artist] Story new (12345).zip",
	]);
	const recycled = [];
	shell.trashItem = async (file) => {
		recycled.push(file);
		await fs.promises.rename(file, `${file}.recycled`);
	};
	const plan = await preview(context.owner, context);
	const item = eligible(plan)[0];
	assert.deepEqual(
		item.processFiles,
		buildGroupRecommendation(item.group).selectedFiles,
	);
	await assert.rejects(
		execute(context.owner + 1000, plan.planId, [item.id]),
		/만료/,
	);
	await assert.rejects(
		execute(context.owner, plan.planId, [item.id, item.id]),
		/올바르지/,
	);
	assert.equal((await executeAll(context, plan)).items[0].status, "succeeded");
	assert.deepEqual(
		recycled,
		item.processFiles.map((file) => file.path),
	);
	for (const file of item.keepFiles)
		assert.equal(await exists(file.path), true);
});

test("앞 그룹 실행 중 다음 후보에 파일이 추가되면 변경된 추천을 실행하지 않는다", async () => {
	const context = await setup("series", [
		"[A] One vol 1.zip",
		"[A] One vol 2.zip",
		"[B] Two vol 1.zip",
		"[B] Two vol 2.zip",
	]);
	const plan = await preview(context.owner, { options: context.options });
	assert.equal(eligible(plan).length, 2);
	const next = plan.items[1].group.files[0].path.replace(/vol [12]/, "vol 3");
	let added = false;
	const result = await executeAll(context, plan, ({ processed }) => {
		if (processed === 1 && !added) {
			fs.writeFileSync(next, "new volume");
			added = true;
		}
	});
	assert.equal(result.items[0].status, "succeeded");
	assert.equal(result.items[1].status, "skipped");
	assert.match(result.items[1].message, /후보 또는 추천이 변경/);
	const retry = await preview(context.owner, {
		...context,
		retryPlanId: plan.planId,
	});
	assert.equal(eligible(retry).length, 0);
	assert.match(retry.items[0].exclusionReason, /후보 또는 추천이 변경/);
});

test("단건 미리보기도 전체 후보의 겹침을 검사하며 새 충돌은 실행 직전에 거부한다", async () => {
	const context = await setup("cleanup", [
		"[Artist] Story v1 (12345).zip",
		"[Artist] Story v2 (12345).zip",
	]);
	const plan = await preview(context.owner, context);
	assert.equal(eligible(plan).length, 1);
	await fs.promises.writeFile(
		path.join(context.options.sourcePath, "[Artist] Story v3 (67890).zip"),
		"third",
	);
	const result = await executeAll(context, plan);
	assert.equal(result.items[0].status, "skipped");
	assert.match(result.items[0].message, /겹칩니다/);
	assert.equal(result.items[0].files.length, 0);
	const batch = await preview(context.owner, context);
	assert.equal(batch.items.length, 2);
	assert.equal(eligible(batch).length, 0);
	for (const item of batch.items) {
		const single = await preview(context.owner, {
			...context,
			groupId: item.group.id,
		});
		assert.equal(single.items.length, 1);
		assert.match(single.items[0].exclusionReason, /겹칩니다/);
	}
});

test("재시도 미리보기와 실행은 새 후보·검토 상태·충돌을 다시 검증한다", async () => {
	for (const phase of ["preview", "execute"])
		for (const change of ["candidate", "ignored", "confirmed", "conflict"]) {
			const context = await setup("cleanup", [
				"[Artist] Story v1 (12345).zip",
				"[Artist] Story v2 (12345).zip",
				"[Artist] Story v3 (12345).zip",
			]);
			const plan = await preview(context.owner, context);
			const partial = await executeAll(context, plan, ({ processed }) => {
				if (processed === 1) cancel(context.owner, plan.planId);
			});
			assert.equal(partial.items[0].status, "partial");
			let retry;
			if (phase === "execute")
				retry = await preview(context.owner, {
					...context,
					retryPlanId: plan.planId,
				});
			if (change === "candidate" || change === "conflict")
				await fs.promises.writeFile(
					path.join(
						context.options.sourcePath,
						`[Artist] Story v4 (${change === "candidate" ? "12345" : "67890"}).zip`,
					),
					"new version",
				);
			else
				await markSimilarGroupReviewState({
					reviewKey: plan.items[0].group.reviewKey,
					contentSignature: plan.items[0].group.contentSignature,
					status: change,
				});
			if (phase === "preview") {
				retry = await preview(context.owner, {
					...context,
					retryPlanId: plan.planId,
				});
				assert.equal(eligible(retry).length, 0, change);
				assert.ok(retry.items[0].exclusionReason);
			} else {
				const result = await executeAll(context, retry);
				assert.equal(result.items[0].status, "skipped", change);
				assert.equal(result.items[0].files.length, 0);
			}
			for (const file of context.files.filter(
				(file) =>
					!partial.items[0].files.some(
						(entry) => entry.path === file && entry.success,
					),
			))
				assert.equal(await exists(file), true);
		}
});

test("파일 경계에서 중지하고 재검토 시 이미 만든 폴더에 남은 파일만 이어 넣는다", async () => {
	const context = await setup();
	const plan = await preview(context.owner, context);
	const result = await executeAll(context, plan, (progress) => {
		assert.equal(progress.groupIndex, 1);
		assert.equal(progress.totalGroups, 1);
		assert.equal(
			progress.currentGroup,
			plan.items[0].group.representativeTitle,
		);
		if (progress.processed === 1) cancel(context.owner, plan.planId);
	});
	assert.equal(result.cancelled, true);
	assert.equal(result.items[0].status, "partial");
	assert.equal(result.items[0].files.length, 1);
	const retry = await preview(context.owner, {
		...context,
		retryPlanId: plan.planId,
	});
	assert.equal(eligible(retry)[0].processFiles.length, 2);
	assert.equal(eligible(retry)[0].targetPath, result.items[0].targetPath);
	const second = await executeAll(context, retry, ({ processed }) => {
		if (processed === 1) cancel(context.owner, retry.planId);
	});
	assert.equal(second.items[0].status, "partial");
	const final = await preview(context.owner, {
		...context,
		retryPlanId: retry.planId,
	});
	assert.equal(eligible(final)[0].processFiles.length, 1);
	const resumed = await executeAll(context, final);
	assert.equal(resumed.items[0].status, "succeeded");
	assert.equal(resumed.items[0].targetPath, result.items[0].targetPath);
	assert.equal(
		(await fs.promises.readdir(resumed.items[0].targetPath)).length,
		3,
	);
});

test("원본·유지 파일의 변경과 소실은 실행 전에 제외한다", async () => {
	for (const kind of ["source", "keep", "missing"]) {
		const context = await setup("cleanup", [
			"[Artist] Story (23456).zip",
			"[Artist] Story revised (23456).zip",
		]);
		const plan = await preview(context.owner, context);
		const item = eligible(plan)[0];
		const changed =
			kind === "source" ? item.processFiles[0].path : item.keepFiles[0].path;
		if (kind === "missing") await fs.promises.unlink(changed);
		else await fs.promises.appendFile(changed, "changed");
		const result = await executeAll(context, plan);
		assert.equal(result.items[0].status, "skipped");
		assert.equal(result.items[0].files.length, 0);
		assert.equal(await exists(item.processFiles[0].path), true);
	}
});

test("복사 실패 뒤 다른 파일은 계속 처리하고 재시도는 같은 폴더를 사용한다", async () => {
	const context = await setup();
	const plan = await preview(context.owner, context);
	const failing = eligible(plan)[0].processFiles[0].path;
	const result = await patch(
		"copyFile",
		(original) =>
			async (source, ...args) => {
				if (source === failing)
					throw Object.assign(new Error("copy denied"), { code: "EACCES" });
				return original(source, ...args);
			},
		() => executeAll(context, plan),
	);
	assert.equal(result.items[0].status, "partial");
	assert.equal(result.items[0].files.filter((file) => file.success).length, 2);
	const retry = await preview(context.owner, {
		...context,
		retryPlanId: plan.planId,
	});
	assert.equal(eligible(retry)[0].processFiles.length, 1);
	const resumed = await executeAll(context, retry);
	assert.equal(resumed.items[0].status, "succeeded");
	assert.equal(resumed.items[0].targetPath, result.items[0].targetPath);
});

test("복사 후 원본 제거 실패는 양쪽 파일을 보존하고 자동 재시도에서 제외한다", async () => {
	const context = await setup();
	const plan = await preview(context.owner, context);
	const failing = eligible(plan)[0].processFiles[0].path;
	const result = await patch(
		"unlink",
		(original) => async (source) => {
			if (source === failing)
				throw Object.assign(new Error("unlink denied"), { code: "EACCES" });
			return original(source);
		},
		() => executeAll(context, plan),
	);
	assert.ok(result.items[0].manualReviewPaths.includes(failing));
	const failed = result.items[0].files.find((file) => file.path === failing);
	assert.equal(await exists(failing), true);
	assert.equal(await exists(failed.targetPath), true);
	const retry = await preview(context.owner, {
		...context,
		retryPlanId: plan.planId,
	});
	assert.equal(eligible(retry).length, 0);
	assert.match(retry.items[0].exclusionReason, /원본과 복사본/);
});

test("편입 동점은 의심 후보로 남기고 경쟁 경로를 표시한다", async () => {
	const context = await setup("suspicious", ["[Artist] Story (34567).zip"]);
	for (const name of ["first", "second"]) {
		const dir = path.join(context.options.sourcePath, "_grouped", name);
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(
			path.join(dir, "[Artist] Story (34567).zip"),
			"stored",
		);
	}
	const result = await findSimilarGroups(context.options);
	const candidate = result.groups.find(
		(group) => group.competingTargetPaths?.length === 2,
	);
	assert.ok(candidate);
	assert.equal(candidate.recommendationAction, "review");
	assert.equal(candidate.targetGroupPath, undefined);
	const plan = await preview(context.owner, context);
	assert.equal(eligible(plan).length, 0);
});

test("편입 대상 변경을 거부하고 동명 충돌 시 기존 내용을 보존한다", async () => {
	for (const changed of [true, false]) {
		const context = await setup("merge", ["[Artist] Story (45678).zip"]);
		const dir = path.join(context.options.sourcePath, "_grouped", "existing");
		await fs.promises.mkdir(dir, { recursive: true });
		const target = path.join(dir, path.basename(context.files[0]));
		await fs.promises.writeFile(target, "original");
		const plan = await preview(context.owner, context);
		assert.equal(eligible(plan).length, 1);
		if (changed) await fs.promises.appendFile(target, "changed");
		const result = await executeAll(context, plan);
		assert.equal(result.items[0].status, changed ? "skipped" : "succeeded");
		assert.equal(
			await fs.promises.readFile(target, "utf8"),
			changed ? "originalchanged" : "original",
		);
		if (!changed) assert.notEqual(result.items[0].files[0].targetPath, target);
	}
});

test("메타데이터 변경과 완료 상태 저장 실패를 파일 처리와 구분한다", async () => {
	const context = await setup();
	const plan = await preview(context.owner, context);
	const result = await patch(
		"rename",
		(original) => async (source, target) => {
			if (target === path.join(root, "similar-group-review-state.json"))
				throw new Error("state denied");
			return original(source, target);
		},
		() => executeAll(context, plan),
	);
	assert.equal(result.items[0].status, "succeeded");
	assert.match(result.items[0].reviewStateError, /state denied/);
	const retry = await preview(context.owner, {
		...context,
		retryPlanId: plan.planId,
	});
	assert.equal(retry.items.length, 0);
	const other = await setup("cleanup", [
		"[Artist] Story (56789).zip",
		"[Artist] Story revised (56789).zip",
	]);
	let metadata = {};
	const resolve = () => metadata;
	const otherPlan = await preview(other.owner, other, resolve);
	metadata = {
		56789: {
			galleryId: "56789",
			canonicalGalleryId: "56789",
			sourceKind: "ehentai-api",
			fetchedAt: "2026-10-01",
			title: "Changed",
			tags: [],
		},
	};
	const changed = await execute(
		other.owner,
		otherPlan.planId,
		eligible(otherPlan).map((item) => item.id),
		resolve,
	);
	assert.equal(changed.items[0].status, "skipped");
});

test("공통 실행 잠금과 중지·완료 대기를 사용하고 검토 기록의 동시 저장을 보존한다", async () => {
	let finish;
	let cancelled = false;
	const first = withOrganizerMutation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
		() => {
			cancelled = true;
		},
	);
	await Promise.resolve();
	await assert.rejects(
		withOrganizerMutation(async () => true),
		/실행 중/,
	);
	const pending = stopOrganizerMutation();
	assert.equal(cancelled, true);
	finish();
	await pending;
	await first;
	await Promise.all(
		Array.from({ length: 4 }, (_, index) =>
			markSimilarGroupReviewState({
				reviewKey: `concurrent-${index}`,
				contentSignature: "test",
				status: "ignored",
			}),
		),
	);
	const state = JSON.parse(
		await fs.promises.readFile(
			path.join(root, "similar-group-review-state.json"),
			"utf8",
		),
	);
	for (let index = 0; index < 4; index++)
		assert.ok(state.records[`concurrent-${index}::test`]);
	assert.throws(() =>
		validateIpcInputs("execute-similar-group-batch", ["plan", [123]]),
	);
	assert.throws(() =>
		validateIpcInputs("preview-similar-group-batch", [
			{ options: { sourcePath: "relative" } },
		]),
	);
});
