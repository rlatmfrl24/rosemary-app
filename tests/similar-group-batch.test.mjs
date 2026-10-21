import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { loadMainModules } from "./helpers/main-modules.mjs";

const root = await fs.promises.mkdtemp(path.join(tmpdir(), "rosemary-batch-"));
const pngArchive = Buffer.from(
	"UEsDBBQAAAAAAMJWQV1raWzURAAAAEQAAAAIAAAAcGFnZS5wbmeJUE5HDQoaCgAAAA1JSERSAAAAAQAAAAEIBAAAALUcDAIAAAALSURBVHjaY/z/HwADAwIA76M3WwAAAABJRU5ErkJgglBLAQIUABQAAAAAAMJWQV1raWzURAAAAEQAAAAIAAAAAAAAAAAAAACAAQAAAABwYWdlLnBuZ1BLBQYAAAAAAQABADYAAABqAAAAAAA=",
	"base64",
);
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
const { getArchiveEntryManifest } = await import(
	"../src/main/archive-content.ts"
);
// Ordinary ZIPs with distinct pages, including pages the sample scan never reads.
const archive = (pages, extras = [], method = 0) => {
	const local = [];
	const central = [];
	let offset = 0;
	const entries = [
		...pages.map((page, index) => [
			`${index + 1}.png`,
			Buffer.concat([pngArchive.subarray(38, 106), Buffer.from(String(page))]),
		]),
		...extras.map((value, index) => [`extra-${index}.txt`, Buffer.from(value)]),
	];
	for (const [name, bytes] of entries) {
		const filename = Buffer.from(name);
		const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(method, 8);
		header.writeUInt32LE(crc32(bytes), 14);
		header.writeUInt32LE(compressed.length, 18);
		header.writeUInt32LE(bytes.length, 22);
		header.writeUInt16LE(filename.length, 26);
		local.push(header, filename, compressed);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50);
		directory.writeUInt16LE(20, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(method, 10);
		directory.writeUInt32LE(crc32(bytes), 16);
		directory.writeUInt32LE(compressed.length, 20);
		directory.writeUInt32LE(bytes.length, 24);
		directory.writeUInt16LE(filename.length, 28);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, filename);
		offset += header.length + filename.length + compressed.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directory, end]);
};
const coverageSetup = async (pages, extras = []) => {
	const context = await setup(
		"cleanup",
		pages.map((_, index) => `[Coverage] Story (${830001 + index}).zip`),
	);
	context.options.contentScanMode = "sample";
	for (const [index, file] of context.files.entries())
		await fs.promises.writeFile(file, archive(pages[index], extras[index]));
	return context;
};
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

test("전체 내용 포함만 자동 선택하고 고유 내용 파일은 보존하며 검증 캐시를 재사용한다", async () => {
	const pages = Array.from({ length: 20 }, (_, index) => `page-${index}`);
	const unique = [...pages];
	unique[5] = "unique-page";
	const context = await coverageSetup([pages, [...pages, "new-page"], unique]);
	const plan = await preview(context.owner, context);
	const item = eligible(plan)[0];
	assert.ok(item, JSON.stringify(plan));
	assert.equal(item.group.confidence >= 90, true);
	assert.deepEqual(
		item.processFiles.map((file) => file.path),
		[context.files[0]],
	);
	assert.deepEqual(
		new Set(item.keepFiles.map((file) => file.path)),
		new Set(context.files.slice(1)),
	);
	assert.equal(
		buildGroupRecommendation(item.group).caseLabel,
		"내용 포함 확인",
	);
	assert.deepEqual(
		item.processFiles,
		buildGroupRecommendation(item.group).selectedFiles,
	);
	const preserved = await Promise.all(
		context.files.slice(1).map((file) => fs.promises.readFile(file)),
	);
	shell.trashItem = (file) => fs.promises.rename(file, `${file}.recycled`);
	let opens = 0;
	context.options.forceRefresh = false;
	const result = await patch(
		"open",
		(original) =>
			async (file, ...args) => {
				if (context.files.includes(String(file))) opens++;
				return original(file, ...args);
			},
		async () => {
			const next = await preview(context.owner, context);
			return executeAll(context, next);
		},
	);
	assert.equal(result.items[0].status, "succeeded");
	assert.equal(opens, 0);
	assert.equal(await exists(context.files[0]), false);
	for (const [index, file] of context.files.slice(1).entries())
		assert.deepEqual(await fs.promises.readFile(file), preserved[index]);
});

test("ZIP 압축 방식이 달라도 실제 페이지와 부가 파일의 포함 관계를 확인한다", async () => {
	const pages = Array.from({ length: 20 }, (_, index) => `page-${index}`);
	const context = await coverageSetup([pages, [...pages, "new-page"]]);
	await fs.promises.writeFile(context.files[0], archive(pages, ["note"]));
	await fs.promises.writeFile(
		context.files[1],
		archive([...pages, "new-page"], ["note"], 8),
	);
	const plan = await preview(context.owner, context);
	assert.equal(eligible(plan).length, 1);
	assert.deepEqual(
		eligible(plan)[0].processFiles.map((file) => file.path),
		[context.files[0]],
	);
	assert.ok(
		eligible(plan)[0].group.files.every(
			(file) => file.content.entryManifest.contentsVerified,
		),
	);
});

test("샘플 일치만 있는 고점수 후보의 순서·반복 페이지·부가 파일 누락은 자동 삭제하지 않는다", async () => {
	const pages = Array.from({ length: 20 }, (_, index) => `page-${index}`);
	for (const kind of ["order", "repeated-page", "extra", "repeated-extra"]) {
		const larger = [...pages, "new-page"];
		const smaller = [...pages];
		let extras = [];
		if (kind === "order") [smaller[5], smaller[6]] = [smaller[6], smaller[5]];
		if (kind === "repeated-page") smaller[5] = smaller[6];
		if (kind === "extra") extras = [["unique-note"], []];
		if (kind === "repeated-extra") extras = [["note", "note"], ["note"]];
		const context = await coverageSetup([smaller, larger], extras);
		const plan = await preview(context.owner, context);
		assert.ok(plan.items.length > 0, kind);
		assert.equal(eligible(plan).length, 0, kind);
		assert.ok(
			plan.items.every((item) => item.group.confidence >= 90),
			kind,
		);
		for (const file of context.files) assert.equal(await exists(file), true);
	}
});

test("CRC 메타데이터가 같아도 실제 바이트가 손상되면 전체 포함으로 처리하지 않는다", async () => {
	const pages = Array.from({ length: 20 }, (_, index) => `page-${index}`);
	const context = await coverageSetup([pages, [...pages, "new-page"]]);
	const changed = await fs.promises.readFile(context.files[1]);
	// Unsampled page; keep central-directory CRC and local-header sizes unchanged.
	changed[changed.indexOf(Buffer.from("page-5"))] = 0x78;
	await fs.promises.writeFile(context.files[1], changed);
	assert.ok(await getArchiveEntryManifest(context.files[1], false));
	assert.equal(
		await getArchiveEntryManifest(context.files[1], true),
		undefined,
	);
	const plan = await preview(context.owner, context);
	assert.ok(plan.items.length);
	assert.equal(eligible(plan).length, 0);
	for (const file of context.files) assert.equal(await exists(file), true);
});

test("전체 포함 근거로 두 파일 처리 후 중지해도 성공 파일을 재처리하지 않고 이어서 완료한다", async () => {
	const pages = Array.from({ length: 20 }, (_, index) => `page-${index}`);
	const context = await coverageSetup([
		pages,
		[...pages, "a"],
		[...pages, "a", "b"],
		[...pages, "a", "b", "c"],
	]);
	const plan = await preview(context.owner, context);
	assert.equal(eligible(plan)[0].processFiles.length, 3);
	const recycled = [];
	shell.trashItem = async (file) => {
		recycled.push(file);
		await fs.promises.rename(file, `${file}.recycled`);
	};
	const result = await executeAll(context, plan, (progress) => {
		if (progress.processed === 2) cancel(context.owner, plan.planId);
	});
	assert.equal(result.cancelled, true);
	assert.equal(recycled.length, 2);
	const retry = await preview(context.owner, {
		...context,
		retryPlanId: plan.planId,
	});
	assert.equal(eligible(retry).length, 1, JSON.stringify(retry));
	assert.equal(eligible(retry)[0].processFiles.length, 1);
	assert.equal((await executeAll(context, retry)).items[0].status, "succeeded");
	assert.equal(new Set(recycled).size, 3);
	assert.equal(await exists(context.files[3]), true);
});

test("전체 내용 검증 이후 파일 변경은 크기·수정 시각을 복원해도 실행 전에 거부한다", async () => {
	const pages = Array.from({ length: 20 }, (_, index) => `page-${index}`);
	const context = await coverageSetup([pages, [...pages, "new-page"]]);
	const plan = await preview(context.owner, context);
	assert.equal(eligible(plan).length, 1);
	const keep = context.files[1];
	const before = await fs.promises.stat(keep);
	const changed = await fs.promises.readFile(keep);
	changed[changed.indexOf(Buffer.from("page-5"))] = 0x78;
	await fs.promises.writeFile(keep, changed);
	await fs.promises.utimes(keep, before.atime, before.mtime);
	const result = await executeAll(context, plan);
	assert.equal(result.items[0].status, "skipped");
	assert.equal(result.items[0].files.length, 0);
	for (const file of context.files) assert.equal(await exists(file), true);
});

test("불완전한 ZIP 목록과 검증 용량을 넘는 압축은 전체 내용 근거로 사용하지 않는다", async () => {
	const context = await setup("cleanup", ["broken.zip", "oversized.zip"]);
	const broken = archive(["page"]);
	broken.writeUInt16LE(2, broken.length - 12);
	await fs.promises.writeFile(context.files[0], broken);
	assert.equal(
		await getArchiveEntryManifest(context.files[0], true),
		undefined,
	);
	const oversized = archive(Array.from({ length: 10 }, (_, index) => index));
	let offset = oversized.readUInt32LE(oversized.length - 6);
	for (let index = 0; index < 10; index++) {
		oversized.writeUInt32LE(60 * 1024 * 1024, offset + 24);
		offset += 46 + oversized.readUInt16LE(offset + 28);
	}
	await fs.promises.writeFile(context.files[1], oversized);
	assert.ok(await getArchiveEntryManifest(context.files[1], false));
	assert.equal(
		await getArchiveEntryManifest(context.files[1], true),
		undefined,
	);
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

test("재시도에서 내용은 같고 제목은 다른 후보의 원래 보류·완료 상태를 확인한다", async () => {
	for (const phase of ["preview", "execute"])
		for (const status of [undefined, "ignored", "confirmed"]) {
			const artist = `Content-${phase}-${status ?? "pending"}`;
			const context = await setup("cleanup", [
				`[${artist}] Alpha.zip`,
				`[${artist}] Beta.zip`,
				`[${artist}] Gamma.zip`,
			]);
			context.options.contentScanMode = "metadata";
			for (const [index, file] of context.files.entries()) {
				await fs.promises.writeFile(file, pngArchive);
				const modified = 1_770_000_000 + [0, 20, 10][index];
				await fs.promises.utimes(file, modified, modified);
			}
			const plan = await preview(context.owner, context);
			assert.equal(eligible(plan).length, 1);
			assert.equal(plan.items[0].keepFiles[0].path, context.files[1]);
			const result = await executeAll(context, plan, ({ processed }) => {
				if (processed === 1) cancel(context.owner, plan.planId);
			});
			assert.equal(result.items[0].status, "partial");
			assert.equal(result.items[0].files[0].path, context.files[0]);
			let retry;
			if (phase === "execute")
				retry = await preview(context.owner, {
					...context,
					retryPlanId: plan.planId,
				});
			if (status)
				await markSimilarGroupReviewState({
					reviewKey: plan.items[0].group.reviewKey,
					contentSignature: plan.items[0].group.contentSignature,
					status,
				});
			if (phase === "preview")
				retry = await preview(context.owner, {
					...context,
					retryPlanId: plan.planId,
				});
			if (status && phase === "preview")
				assert.equal(eligible(retry).length, 0);
			else {
				assert.equal(eligible(retry).length, 1);
				assert.equal(eligible(retry)[0].processFiles.length, 1);
				const resumed = await executeAll(context, retry);
				assert.equal(resumed.items[0].status, status ? "skipped" : "succeeded");
				assert.equal(resumed.items[0].files.length, status ? 0 : 1);
			}
			assert.equal(await exists(context.files[1]), true);
			assert.equal(await exists(context.files[2]), Boolean(status));
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

test("일괄 재검증은 압축·검토 기록 읽기와 전체 디스크 인덱스 저장을 반복하지 않는다", async () => {
	const other = await setup("cleanup", [
		"[Other-cache] Other v1 (799999).zip",
		"[Other-cache] Other v2 (799999).zip",
	]);
	await preview(other.owner, other);
	const count = 20;
	const context = await setup(
		"cleanup",
		Array.from({ length: count }, (_, index) =>
			[1, 2].map(
				(version) => `[Perf${index}] Story v${version} (${800000 + index}).zip`,
			),
		).flat(),
	);
	context.options.contentScanMode = "smart";
	const metadata = Object.fromEntries(
		Array.from({ length: count }, (_, index) => [
			String(800000 + index),
			{
				galleryId: String(800000 + index),
				sourceKind: "ehentai-api",
				tags: [{ namespace: "artist", value: `Perf${index}`, position: 0 }],
			},
		]),
	);
	const resolve = () => metadata;
	for (const [index, file] of context.files.entries()) {
		const archive = Buffer.from(pngArchive);
		archive[105] = Math.floor(index / 2);
		const crc = crc32(archive.subarray(38, 106));
		archive.writeUInt32LE(crc, 14);
		archive.writeUInt32LE(crc, 122);
		await fs.promises.writeFile(file, archive);
	}
	const plan = await preview(context.owner, context, resolve);
	assert.equal(eligible(plan).length, count);
	let opens = 0;
	let reads = 0;
	let indexWrites = 0;
	const result = await patch(
		"open",
		(original) =>
			async (file, ...args) => {
				if (String(file).endsWith(".zip")) opens++;
				return original(file, ...args);
			},
		() =>
			patch(
				"readFile",
				(original) =>
					async (file, ...args) => {
						if (String(file).endsWith("similar-group-review-state.json"))
							reads++;
						return original(file, ...args);
					},
				() =>
					patch(
						"writeFile",
						(original) =>
							async (file, ...args) => {
								if (String(file).endsWith("similar-group-index-cache-v2.json"))
									indexWrites++;
								return original(file, ...args);
							},
						async () => {
							// A fresh preview also validates the inventory without reopening unchanged archives.
							const next = await preview(context.owner, context, resolve);
							return execute(
								context.owner,
								next.planId,
								eligible(next).map((item) => item.id),
								resolve,
							);
						},
					),
			),
	);
	assert.equal(
		result.items.filter((item) => item.status === "succeeded").length,
		count,
	);
	assert.equal(opens, 0);
	assert.ok(reads <= count * 2 + 1, `review reads: ${reads}`);
	assert.equal(indexWrites, 1);
	const diskCache = JSON.parse(
		await fs.promises.readFile(
			path.join(root, "similar-group-index-cache-v2.json"),
			"utf8",
		),
	);
	const cachedRoots = Object.values(diskCache.records).map(
		(entry) => entry.sourcePath,
	);
	assert.ok(!cachedRoots.includes(context.options.sourcePath));
	assert.ok(cachedRoots.includes(other.options.sourcePath));
	// Completion invalidates the memory index too, so a normal search inventories new files.
	for (const version of [1, 2])
		await fs.promises.writeFile(
			path.join(
				context.options.sourcePath,
				`[New] New v${version} (899999).zip`,
			),
			`new-${version}`,
		);
	const refreshed = await findSimilarGroups(
		{ ...context.options, forceRefresh: false },
		undefined,
		resolve,
	);
	assert.equal(refreshed.scannedCount, count + 2);
	assert.ok(refreshed.groups.some((group) => group.files[0].code === "899999"));
});

test("크기·수정 시각을 복원해도 바뀐 압축을 다시 읽고 실행하지 않는다", async () => {
	const context = await setup("cleanup", [
		"[Cache] Alpha.zip",
		"[Cache] Beta.zip",
	]);
	context.options.contentScanMode = "metadata";
	for (const file of context.files)
		await fs.promises.writeFile(file, pngArchive);
	const plan = await preview(context.owner, context);
	assert.equal(eligible(plan).length, 1);
	const keep = plan.items[0].keepFiles[0].path;
	const before = await fs.promises.stat(keep);
	const changed = Buffer.from(pngArchive);
	changed.writeUInt32LE(123, 122);
	await fs.promises.writeFile(keep, changed);
	await fs.promises.utimes(keep, before.atime, before.mtime);
	let opens = 0;
	const result = await patch(
		"open",
		(original) =>
			async (file, ...args) => {
				if (file === keep) opens++;
				return original(file, ...args);
			},
		() => executeAll(context, plan),
	);
	assert.ok(opens > 0);
	assert.equal(result.items[0].status, "skipped");
	assert.equal(result.items[0].files.length, 0);
	for (const file of context.files) assert.equal(await exists(file), true);
});

test("큰 NTFS 식별자는 다른 파일을 충돌로 오인하지 않고 하드 링크는 제외한다", async () => {
	const context = await setup("cleanup", [
		"[Ids] First v1 (810001).zip",
		"[Ids] First v2 (810001).zip",
		"[Ids] Second v1 (810002).zip",
		"[Ids] Second v2 (810002).zip",
	]);
	for (const hardLink of [false, true]) {
		const plan = await patch(
			"stat",
			(original) => async (file, options) => {
				const stats = await original(file, options);
				const index = context.files.indexOf(String(file));
				if (options?.bigint && index >= 0)
					stats.ino = 2n ** 54n + BigInt(hardLink && index === 2 ? 0 : index);
				return stats;
			},
			() => preview(context.owner, context),
		);
		assert.equal(eligible(plan).length, hardLink ? 0 : 2);
		if (hardLink)
			for (const item of plan.items)
				assert.match(item.exclusionReason, /겹칩니다/);
	}
});

test("메타데이터 객체를 제자리에서 변경해도 캐시된 분류를 갱신한다", async () => {
	const context = await setup("cleanup", [
		"[Alpha] Cached v1 (820001).zip",
		"[Alpha] Cached v2 (820001).zip",
	]);
	const metadata = {
		820001: {
			galleryId: "820001",
			sourceKind: "ehentai-api",
			tags: [{ namespace: "artist", value: "Alpha", position: 0 }],
		},
	};
	const resolve = () => metadata;
	const initial = await findSimilarGroups(context.options, undefined, resolve);
	assert.equal(initial.groups[0].files[0].artist, "Alpha");
	metadata[820001].tags[0].value = "Beta";
	const updated = await findSimilarGroups(
		{ ...context.options, forceRefresh: false, queue: "suspicious" },
		undefined,
		resolve,
	);
	assert.equal(updated.groups[0].files[0].artist, "Beta");
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
