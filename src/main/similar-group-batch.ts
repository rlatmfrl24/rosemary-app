import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArchiveFileName } from "../shared/archive-name";
import type {
	SimilarGroup,
	SimilarGroupBatchItem,
	SimilarGroupBatchItemResult,
	SimilarGroupBatchPreview,
	SimilarGroupBatchProgress,
	SimilarGroupBatchRequest,
	SimilarGroupBatchResult,
	SimilarGroupFile,
	SimilarGroupOptions,
} from "../shared/file-organizer";
import {
	buildGroupRecommendation,
	getSimilarGroupBatchExclusion,
} from "../shared/similar-group-recommendation";
import {
	findSimilarGroups,
	type GalleryMetadataResolver,
	isResolvedPathInside,
	markSimilarGroupReviewState,
	mergeFilesToExistingGroup,
	moveGroupFilesToFolder,
	trashFilesToRecycleBin,
} from "./files";
import { withOrganizerMutation } from "./organizer-operation";
import { getPathKey } from "./path-key";

interface Stamp {
	realPath: string;
	size: number;
	mtime: number;
	ino: number;
	dev: number;
	directory: boolean;
}
interface PlannedItem {
	item: SimilarGroupBatchItem;
	reviewGroup: SimilarGroup;
	stamps: Map<string, Stamp>;
	metadata: string;
	metadataIds: string[];
	completedFiles: SimilarGroupFile[];
}
interface Plan {
	id: string;
	owner: number;
	options: SimilarGroupOptions;
	items: PlannedItem[];
	targets: Map<string, Map<string, Stamp>>;
	consumed: boolean;
	cancelled: boolean;
	result?: SimilarGroupBatchResult;
}
const plans = new Map<number, Plan>();
const manualCopies = new Map<string, string>();
const continuationFolders = new Map<string, string>();
const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const unchanged = (left: unknown, right: unknown): boolean =>
	JSON.stringify(left) === JSON.stringify(right);
const stamp = async (filePath: string): Promise<Stamp> => {
	const stat = await fs.stat(filePath);
	return {
		realPath: getPathKey(await fs.realpath(filePath)),
		size: stat.isDirectory() ? 0 : stat.size,
		mtime: stat.isDirectory() ? 0 : stat.mtimeMs,
		ino: stat.ino,
		dev: stat.dev,
		directory: stat.isDirectory(),
	};
};
const exists = async (filePath: string): Promise<boolean> => {
	try {
		await fs.stat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
};
const tree = async (directory: string): Promise<Map<string, Stamp>> => {
	const entries = new Map<string, Stamp>();
	const visit = async (current: string): Promise<void> => {
		const info = await stamp(current);
		entries.set(getPathKey(current), info);
		if (info.directory)
			for (const entry of await fs.readdir(current, { withFileTypes: true })) {
				if (entry.isSymbolicLink())
					throw new Error("편입 대상에 연결 경로가 있어 직접 검토해야 합니다.");
				await visit(path.join(current, entry.name));
			}
	};
	await visit(directory);
	return entries;
};
const sameTree = (
	left: Map<string, Stamp>,
	right: Map<string, Stamp>,
): boolean =>
	left.size === right.size &&
	[...left].every(([key, value]) => unchanged(value, right.get(key)));
const metadataSnapshot = (
	ids: string[],
	resolve?: GalleryMetadataResolver,
): string => {
	const data = resolve?.(ids) ?? {};
	return JSON.stringify(ids.map((id) => [id, data[id] ?? null]));
};
const groupEvidence = (group: SimilarGroup): string =>
	JSON.stringify({
		files: [...group.files].sort((left, right) =>
			getPathKey(left.path).localeCompare(getPathKey(right.path)),
		),
		queue: group.queue,
		action: group.recommendationAction,
		confidence: group.confidence,
		reasons: group.reasons,
		folder: group.folderSegments,
		target: group.targetGroupPath,
		reviewed: group.reviewStatus,
	});
const publicPreview = (plan: Plan): SimilarGroupBatchPreview => ({
	planId: plan.id,
	items: plan.items.map(({ item }) => item),
});
const getPlan = (owner: number, planId: string): Plan => {
	const plan = plans.get(owner);
	if (!plan || plan.id !== planId)
		throw new Error("실행 계획이 만료되었습니다. 미리보기를 다시 열어주세요.");
	return plan;
};

export const excludeBatchConflicts = (
	items: SimilarGroupBatchItem[],
	key = getPathKey,
): void => {
	const owners = new Map<
		string,
		{ item: SimilarGroupBatchItem; process: boolean }[]
	>();
	for (const item of items.filter((entry) => !entry.exclusionReason)) {
		for (const [files, process] of [
			[item.processFiles, true],
			[item.keepFiles, false],
		] as const) {
			for (const file of files) {
				const entries = owners.get(key(file.path)) ?? [];
				entries.push({ item, process });
				owners.set(key(file.path), entries);
			}
		}
	}
	for (const entries of owners.values()) {
		if (
			new Set(entries.map(({ item }) => item.id)).size > 1 &&
			entries.some((entry) => entry.process)
		) {
			for (const { item } of entries)
				item.exclusionReason =
					"다른 후보의 처리·유지 파일과 겹칩니다. 개별 검토해주세요.";
		}
	}
};

const createBatchItem = (
	group: SimilarGroup,
	minConfidence: number,
	completed: Set<string> = new Set(),
): SimilarGroupBatchItem => {
	const recommendation = buildGroupRecommendation(group);
	const remaining = (files: SimilarGroupFile[]) =>
		files.filter((file) => !completed.has(getPathKey(file.path)));
	return {
		id: randomUUID(),
		group: { ...group, files: remaining(group.files) },
		action: recommendation.action,
		processFiles: remaining(
			recommendation.action === "trash"
				? recommendation.selectedFiles
				: recommendation.action === "review"
					? []
					: group.files,
		),
		keepFiles: remaining(recommendation.keepFiles),
		targetPath: group.targetGroupPath,
		exclusionReason: getSimilarGroupBatchExclusion(group, minConfidence),
	};
};

const readCandidates = async (
	options: SimilarGroupOptions,
	resolve: GalleryMetadataResolver | undefined,
	completedFiles: SimilarGroupFile[],
): Promise<{ groups: SimilarGroup[]; items: SimilarGroupBatchItem[] }> => {
	const { groups } = await findSimilarGroups(
		{ ...options, forceRefresh: true },
		undefined,
		resolve,
		completedFiles,
	);
	const completed = new Set(
		completedFiles.map((file) => getPathKey(file.path)),
	);
	const items = groups.map((group) =>
		createBatchItem(group, options.minConfidence, completed),
	);
	const identities = new Map<string, string>();
	for (const item of items.filter((entry) => !entry.exclusionReason))
		for (const file of [...item.processFiles, ...item.keepFiles]) {
			const key = getPathKey(file.path);
			if (identities.has(key)) continue;
			try {
				const current = await stamp(file.path);
				identities.set(
					key,
					`${current.dev}:${current.ino}:${current.ino ? "" : current.realPath}`,
				);
			} catch {
				// The selected candidate's source validation reports missing files.
				identities.set(key, key);
			}
		}
	excludeBatchConflicts(
		items,
		(filePath) => identities.get(getPathKey(filePath)) ?? getPathKey(filePath),
	);
	return { groups, items };
};

export const previewSimilarGroupBatch = async (
	owner: number,
	request: SimilarGroupBatchRequest,
	resolve?: GalleryMetadataResolver,
): Promise<SimilarGroupBatchPreview> =>
	withOrganizerMutation(async () => {
		const previous = request.retryPlanId
			? getPlan(owner, request.retryPlanId)
			: undefined;
		if (previous && !previous.result)
			throw new Error("아직 재검토할 실행 결과가 없습니다.");
		const options = previous?.options ?? {
			...request.options,
			forceRefresh: true,
			includeReviewed: true,
		};
		const retries =
			previous?.items.flatMap((original) => {
				const { item } = original;
				const result = previous.result?.items.find(
					(entry) => entry.itemId === item.id,
				);
				if (!result || result.status === "succeeded" || item.exclusionReason)
					return [];
				const completed = new Set([
					...original.completedFiles.map((file) => getPathKey(file.path)),
					...result.files
						.filter((entry) => entry.success)
						.map((entry) => getPathKey(entry.path)),
				]);
				return [
					{
						original,
						completedFiles: original.reviewGroup.files.filter((file) =>
							completed.has(getPathKey(file.path)),
						),
					},
				];
			}) ?? [];
		const latest = await readCandidates(
			options,
			resolve,
			retries.flatMap((entry) => entry.completedFiles),
		);
		const groups = previous
			? retries.map(({ original }) => original.reviewGroup)
			: latest.groups;
		const plan: Plan = {
			id: randomUUID(),
			owner,
			options,
			items: [],
			targets: new Map(),
			consumed: false,
			cancelled: false,
		};
		for (const group of groups) {
			const retry = retries.find(
				({ original }) => original.reviewGroup.id === group.id,
			);
			const original = retry?.original;
			const completedFiles = retry?.completedFiles ?? [];
			const item = createBatchItem(
				group,
				options.minConfidence,
				new Set(completedFiles.map((file) => getPathKey(file.path))),
			);
			const current = latest.groups.find((entry) => entry.id === group.id);
			item.exclusionReason =
				!current || groupEvidence(current) !== groupEvidence(group)
					? "후보 또는 추천이 변경되었습니다. 다시 검토해주세요."
					: latest.items.find((entry) => entry.group.id === group.id)
							?.exclusionReason;
			const continuations = new Set(
				item.processFiles
					.map((file) => continuationFolders.get(getPathKey(file.path)))
					.filter(Boolean),
			);
			if (item.action === "group" && continuations.size === 1)
				item.targetPath = [...continuations][0];
			if (continuations.size > 1)
				item.exclusionReason =
					"이전에 생성된 대상 폴더가 서로 다릅니다. 직접 검토해주세요.";
			const planned: PlannedItem = {
				item,
				reviewGroup: original?.reviewGroup ?? group,
				stamps: new Map(),
				metadata: "",
				metadataIds: [],
				completedFiles,
			};
			try {
				for (const file of item.group.files) {
					if (!(await isResolvedPathInside(options.sourcePath, file.path)))
						throw new Error("저장소 밖의 파일입니다.");
					const current = await stamp(file.path);
					if (
						current.directory ||
						current.size !== file.size ||
						current.mtime !== file.modifiedTimeMs
					)
						throw new Error(
							"검색 이후 파일이 변경되었습니다. 다시 검색해주세요.",
						);
					if (
						original &&
						!unchanged(current, original.stamps.get(getPathKey(file.path)))
					)
						throw new Error(
							"이전 실행 이후 파일이 변경되었습니다. 직접 검토해주세요.",
						);
					planned.stamps.set(getPathKey(file.path), current);
					const copied = manualCopies.get(getPathKey(file.path));
					if (copied && (await exists(copied)))
						throw new Error(
							"이전 이동에서 원본과 복사본이 모두 남았습니다. 직접 검토해주세요.",
						);
				}
				if (item.targetPath) {
					if (
						!(await isResolvedPathInside(
							path.join(options.sourcePath, "_grouped"),
							item.targetPath,
						))
					)
						throw new Error("저장소 그룹 폴더 밖의 대상입니다.");
					const target = await tree(item.targetPath);
					if (!target.get(getPathKey(item.targetPath))?.directory)
						throw new Error("대상 그룹 폴더가 없습니다.");
					const previousTarget = previous?.targets.get(
						getPathKey(item.targetPath),
					);
					if (previousTarget && !sameTree(previousTarget, target))
						throw new Error(
							"이전 실행 이후 대상 그룹이 변경되었습니다. 직접 검토해주세요.",
						);
					plan.targets.set(getPathKey(item.targetPath), target);
				}
				planned.metadataIds = [
					...new Set(
						[
							...group.files.map((file) => file.code),
							...[
								...(item.targetPath
									? (plan.targets.get(getPathKey(item.targetPath))?.keys() ??
										[])
									: []),
							].map((file) => parseArchiveFileName(path.basename(file)).code),
						].filter((id): id is string => !!id),
					),
				].sort();
				planned.metadata = metadataSnapshot(planned.metadataIds, resolve);
				if (
					original &&
					metadataSnapshot(original.metadataIds, resolve) !== original.metadata
				)
					throw new Error(
						"이전 실행 이후 메타데이터가 변경되었습니다. 직접 검토해주세요.",
					);
			} catch (error) {
				item.exclusionReason = message(error);
			}
			plan.items.push(planned);
		}
		if (request.groupId) {
			plan.items = plan.items.filter(
				({ item }) => item.group.id === request.groupId,
			);
			if (!plan.items.length)
				throw new Error("선택한 후보가 변경되었습니다. 다시 검색해주세요.");
		}
		plans.set(owner, plan);
		return publicPreview(plan);
	});

export const cancelSimilarGroupBatch = (
	owner: number,
	planId: string,
): boolean => {
	getPlan(owner, planId).cancelled = true;
	return true;
};
export const releaseSimilarGroupBatch = (owner: number): void => {
	const plan = plans.get(owner);
	if (plan) plan.cancelled = true;
	plans.delete(owner);
};

export const executeSimilarGroupBatch = async (
	owner: number,
	planId: string,
	itemIds: string[],
	resolve?: GalleryMetadataResolver,
	onProgress?: (progress: SimilarGroupBatchProgress) => void,
): Promise<SimilarGroupBatchResult> => {
	const plan = getPlan(owner, planId);
	return withOrganizerMutation(
		async () => {
			if (plan.consumed)
				throw new Error(
					"이미 실행한 계획입니다. 남은 항목을 다시 검토해주세요.",
				);
			const selected = new Set(itemIds);
			if (
				!selected.size ||
				selected.size !== itemIds.length ||
				itemIds.some(
					(id) =>
						!plan.items.some(
							({ item }) => item.id === id && !item.exclusionReason,
						),
				)
			)
				throw new Error("실행 항목이 올바르지 않습니다.");
			plan.consumed = true;
			const result: SimilarGroupBatchResult = {
				planId,
				items: [],
				cancelled: false,
			};
			plan.result = result;
			const total = plan.items
				.filter(({ item }) => selected.has(item.id))
				.reduce((sum, { item }) => sum + item.processFiles.length, 0);
			let processed = 0;
			for (const planned of plan.items) {
				const { item } = planned;
				const outcome: SimilarGroupBatchItemResult = {
					itemId: item.id,
					status: "skipped",
					files: [],
					manualReviewPaths: [],
					targetPath: item.targetPath,
				};
				result.items.push(outcome);
				if (!selected.has(item.id)) {
					outcome.message = item.exclusionReason ?? "선택하지 않은 후보입니다.";
					continue;
				}
				if (plan.cancelled) {
					outcome.status = "cancelled";
					continue;
				}
				try {
					// ponytail: rescan per group for fresh recommendations; optimize with validated index revisions if needed.
					const latest = await readCandidates(
						plan.options,
						resolve,
						plan.items.flatMap((entry) => entry.completedFiles),
					);
					const current = latest.groups.find(
						(group) => group.id === item.group.id,
					);
					if (
						!current ||
						groupEvidence(current) !== groupEvidence(planned.reviewGroup)
					)
						throw new Error(
							"후보 또는 추천이 변경되었습니다. 다시 검토해주세요.",
						);
					const exclusion = latest.items.find(
						(entry) => entry.group.id === item.group.id,
					)?.exclusionReason;
					if (exclusion) throw new Error(exclusion);
					const pending = new Set(
						item.group.files.map((file) => getPathKey(file.path)),
					);
					const check = async (): Promise<void> => {
						if (
							metadataSnapshot(planned.metadataIds, resolve) !==
							planned.metadata
						)
							throw new Error(
								"메타데이터가 변경되었습니다. 다시 검토해주세요.",
							);
						for (const file of item.group.files.filter((entry) =>
							pending.has(getPathKey(entry.path)),
						)) {
							if (
								!(await isResolvedPathInside(
									plan.options.sourcePath,
									file.path,
								)) ||
								!unchanged(
									await stamp(file.path),
									planned.stamps.get(getPathKey(file.path)),
								)
							)
								throw new Error(`파일이 변경되었습니다: ${file.name}`);
						}
						if (outcome.targetPath) {
							if (
								!(await isResolvedPathInside(
									path.join(plan.options.sourcePath, "_grouped"),
									outcome.targetPath,
								))
							)
								throw new Error("편입 대상 경로가 변경되었습니다.");
							const expected = plan.targets.get(getPathKey(outcome.targetPath));
							if (
								!expected ||
								!sameTree(expected, await tree(outcome.targetPath))
							)
								throw new Error(
									"대상 그룹이 변경되었습니다. 다시 검토해주세요.",
								);
						}
					};
					await check();
					const reportProgress = (currentFile: string): void =>
						onProgress?.({
							planId,
							processed,
							total,
							currentFile,
							groupIndex: result.items.filter((entry) =>
								selected.has(entry.itemId),
							).length,
							totalGroups: selected.size,
							currentGroup: item.group.representativeTitle,
						});
					for (const file of item.processFiles) {
						if (plan.cancelled) break;
						await check();
						if (plan.cancelled) break;
						reportProgress(file.name);
						const operation =
							item.action === "trash"
								? await trashFilesToRecycleBin([file.path])
								: outcome.targetPath
									? await mergeFilesToExistingGroup(
											plan.options.sourcePath,
											[file.path],
											outcome.targetPath,
										)
									: await moveGroupFilesToFolder(
											plan.options.sourcePath,
											[file.path],
											item.group.representativeTitle,
											item.group.folderSegments,
										);
						if (operation.targetFolderPath && !outcome.targetPath) {
							outcome.targetPath = operation.targetFolderPath;
							for (const remaining of item.processFiles)
								continuationFolders.set(
									getPathKey(remaining.path),
									outcome.targetPath,
								);
						}
						const fileResult = operation.results[0];
						if (!fileResult) throw new Error("파일 처리 결과가 없습니다.");
						outcome.files.push(fileResult);
						try {
							if (fileResult.success && (await exists(file.path)))
								throw new Error("처리 후에도 원본 파일이 남아 있습니다.");
							if (
								fileResult.success &&
								fileResult.targetPath &&
								(await fs.stat(fileResult.targetPath)).size !== file.size
							)
								throw new Error("이동된 파일의 크기가 일치하지 않습니다.");
							for (const keep of item.keepFiles)
								if (
									!unchanged(
										await stamp(keep.path),
										planned.stamps.get(getPathKey(keep.path)),
									)
								)
									throw new Error("유지 파일 상태가 변경되었습니다.");
						} catch (error) {
							fileResult.success = false;
							fileResult.error = message(error);
						}
						if (
							!fileResult.success &&
							fileResult.targetPath &&
							(await exists(fileResult.targetPath))
						) {
							manualCopies.set(getPathKey(file.path), fileResult.targetPath);
							outcome.manualReviewPaths.push(file.path);
							fileResult.error = `${fileResult.error ?? "이동 실패"} 원본·대상 파일을 직접 검토해주세요.`;
						}
						if (fileResult.success) {
							pending.delete(getPathKey(file.path));
							continuationFolders.delete(getPathKey(file.path));
						}
						if (outcome.targetPath) {
							const actual = await tree(outcome.targetPath);
							const expected = new Map(
								plan.targets.get(getPathKey(outcome.targetPath)) ?? [
									[
										getPathKey(outcome.targetPath),
										await stamp(outcome.targetPath),
									],
								],
							);
							if (
								fileResult.targetPath &&
								actual.has(getPathKey(fileResult.targetPath))
							)
								expected.set(
									getPathKey(fileResult.targetPath),
									actual.get(getPathKey(fileResult.targetPath)) as Stamp,
								);
							if (!sameTree(expected, actual))
								throw new Error(
									"실행 중 대상 그룹이 변경되었습니다. 다시 검토해주세요.",
								);
							plan.targets.set(getPathKey(outcome.targetPath), actual);
						}
						processed += 1;
						reportProgress(file.name);
					}
					const successful = outcome.files.filter(
						(entry) => entry.success,
					).length;
					outcome.status =
						successful === item.processFiles.length
							? "succeeded"
							: successful
								? "partial"
								: plan.cancelled
									? "cancelled"
									: "failed";
					if (outcome.status === "succeeded") {
						try {
							await markSimilarGroupReviewState({
								reviewKey: planned.reviewGroup.reviewKey,
								contentSignature: planned.reviewGroup.contentSignature,
								status: "confirmed",
							});
						} catch (error) {
							outcome.reviewStateError = message(error);
						}
					}
				} catch (error) {
					outcome.message = message(error);
					outcome.status = outcome.files.some((entry) => entry.success)
						? "partial"
						: outcome.files.length
							? "failed"
							: "skipped";
				}
			}
			result.cancelled = plan.cancelled;
			return result;
		},
		() => {
			plan.cancelled = true;
		},
	);
};
