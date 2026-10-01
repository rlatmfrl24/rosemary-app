import { useCallback, useEffect, useRef, useState } from "react";
import type {
	SimilarGroup,
	SimilarGroupBatchPreview,
	SimilarGroupBatchProgress,
	SimilarGroupBatchRequest,
	SimilarGroupBatchResult,
} from "../../../shared/file-organizer";
import { buildGroupRecommendation } from "../../../shared/similar-group-recommendation";
import { NativeDialog } from "./NativeDialog";

const statusLabels = {
	succeeded: "성공",
	partial: "일부 성공",
	failed: "실패",
	skipped: "제외",
	cancelled: "미실행",
};
const actionLabels = {
	trash: "휴지통 이동",
	group: "그룹 폴더로 이동",
	merge: "기존 그룹 편입",
	review: "수동 검토",
};

export const SimilarGroupBatchDialog = ({
	request,
	onClose,
	onComplete,
	onReview,
}: {
	request: SimilarGroupBatchRequest;
	onClose: () => void;
	onComplete: () => Promise<void>;
	onReview: (group: SimilarGroup) => void;
}): React.JSX.Element => {
	const [preview, setPreview] = useState<SimilarGroupBatchPreview | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [result, setResult] = useState<SimilarGroupBatchResult | null>(null);
	const [progress, setProgress] = useState<SimilarGroupBatchProgress | null>(
		null,
	);
	const [loading, setLoading] = useState(true);
	const [running, setRunning] = useState(false);
	const [stopping, setStopping] = useState(false);
	const [error, setError] = useState("");
	const planId = useRef<string | null>(null);
	const previewRequest = useRef<SimilarGroupBatchRequest | null>(null);
	const busy = loading || running;
	const loadPreview = useCallback(
		async (nextRequest: SimilarGroupBatchRequest): Promise<void> => {
			setLoading(true);
			setError("");
			try {
				const next =
					await window.api.fileOrganizer.previewSimilarGroupBatch(nextRequest);
				planId.current = next.planId;
				setPreview(next);
				setResult(null);
				setProgress(null);
				setSelected(
					new Set(
						next.items
							.filter((item) => !item.exclusionReason)
							.map((item) => item.id),
					),
				);
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setLoading(false);
			}
		},
		[],
	);
	useEffect(() => {
		if (previewRequest.current === request) return;
		previewRequest.current = request;
		void loadPreview(request);
	}, [loadPreview, request]);
	useEffect(
		() =>
			window.api.fileOrganizer.onSimilarGroupBatchProgress((next) => {
				if (next.planId === planId.current) setProgress(next);
			}),
		[],
	);
	const items = preview?.items.filter((item) => selected.has(item.id)) ?? [];
	const fileCount = new Set(
		items.flatMap((item) => item.processFiles.map((file) => file.path)),
	).size;
	const execute = async (): Promise<void> => {
		if (!preview || busy || !items.length) return;
		const actions = [
			...new Set(items.map((item) => actionLabels[item.action])),
		].join(", ");
		if (
			!confirm(
				`그룹 ${items.length}개, 파일 ${fileCount}개를 처리하시겠습니까?\n작업: ${actions}\n미리보기에 표시된 유지 파일은 보존합니다.`,
			)
		)
			return;
		setRunning(true);
		setStopping(false);
		setError("");
		try {
			setResult(
				await window.api.fileOrganizer.executeSimilarGroupBatch(
					preview.planId,
					[...selected],
				),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			try {
				await onComplete();
			} catch (cause) {
				setError(
					`결과 재검색 실패: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			}
			setRunning(false);
		}
	};
	const stop = async (): Promise<void> => {
		if (!preview) return;
		try {
			await window.api.fileOrganizer.cancelSimilarGroupBatch(preview.planId);
			setStopping(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};
	return (
		<NativeDialog
			aria-labelledby="similar-batch-title"
			onDismiss={() => {
				if (!busy) onClose();
			}}
			onCancel={(event) => {
				if (busy) event.preventDefault();
			}}
		>
			<div className="modal-box flex max-h-[90vh] w-[calc(100%-1rem)] max-w-5xl flex-col gap-3 overflow-hidden p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 id="similar-batch-title" className="font-semibold">
							{request.groupId ? "추천 처리 확인" : "추천 일괄 처리"}
						</h2>
						<p className="text-xs text-base-content/65">
							신뢰도는 후보 판단 점수이며 정확도 확률이 아닙니다. 유지 파일과
							처리 대상을 확인해주세요.
						</p>
					</div>
					<button
						type="button"
						className="btn btn-sm btn-ghost"
						disabled={busy}
						onClick={onClose}
					>
						닫기
					</button>
				</div>
				{error && (
					<div role="alert" className="alert alert-error break-words text-sm">
						{error}
					</div>
				)}
				{loading && (
					<div role="status" className="flex items-center gap-2">
						<span className="loading loading-spinner loading-sm" />
						최신 파일 상태로 미리보기를 준비하고 있습니다.
					</div>
				)}
				{running && (
					<div role="status" aria-live="polite" className="space-y-1">
						{progress && (
							<p className="break-words text-sm">
								그룹 {progress.groupIndex}/{progress.totalGroups} ·{" "}
								{progress.currentGroup}
							</p>
						)}
						<p className="break-all text-sm">
							{stopping ? "현재 파일 처리 후 중지합니다." : "처리 중"}{" "}
							{progress?.processed ?? 0}/{progress?.total ?? fileCount} ·{" "}
							{progress?.currentFile ?? "실행 전 재검증"}
						</p>
						<progress
							className="progress progress-primary w-full"
							value={progress?.processed ?? 0}
							max={progress?.total || fileCount || 1}
						/>
					</div>
				)}
				{result && (
					<div role="status" className="rounded bg-base-200 p-2 text-sm">
						{result.cancelled ? "중지 완료" : "처리 완료"} ·{" "}
						{Object.entries(statusLabels)
							.map(
								([status, label]) =>
									`${label} ${result.items.filter((item) => item.status === status).length}개`,
							)
							.join(" · ")}
					</div>
				)}
				<div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
					{preview && !preview.items.length && (
						<p className="py-4 text-sm">
							현재 조건에 해당하는 처리 후보가 없습니다.
						</p>
					)}
					{preview?.items.map((item) => {
						const outcome = result?.items.find(
							(entry) => entry.itemId === item.id,
						);
						const recommendation = buildGroupRecommendation(item.group);
						const target =
							outcome?.targetPath ??
							item.targetPath ??
							`_grouped/${Object.values(item.group.folderSegments).join("/")}`;
						return (
							<section
								key={item.id}
								className="rounded-box border border-base-content/15 p-3"
							>
								<label className="flex items-start gap-2">
									<input
										type="checkbox"
										className="checkbox checkbox-sm mt-0.5"
										checked={selected.has(item.id)}
										disabled={busy || !!result || !!item.exclusionReason}
										aria-label={`${item.group.representativeTitle} 처리 선택`}
										onChange={(event) => {
											const checked = event.target.checked;
											setSelected((current) => {
												const next = new Set(current);
												if (checked) next.add(item.id);
												else next.delete(item.id);
												return next;
											});
										}}
									/>
									<span className="min-w-0 flex-1 break-words font-medium">
										{item.group.representativeTitle}
									</span>
									<span className="badge badge-ghost shrink-0">
										{item.group.confidence}점
									</span>
								</label>
								<p className="mt-2 text-xs">
									{actionLabels[item.action]} · 처리 {item.processFiles.length}
									개 · 유지 {item.keepFiles.length}개
									{outcome && ` · ${statusLabels[outcome.status]}`}
								</p>
								<p className="mt-1 break-words text-xs text-base-content/65">
									{recommendation.reasons.join(" · ")}
								</p>
								{(item.exclusionReason || outcome?.message) && (
									<p className="mt-2 break-words text-sm text-warning">
										{item.exclusionReason ?? outcome?.message}
									</p>
								)}
								{item.exclusionReason && !result && (
									<button
										type="button"
										className="btn btn-xs btn-ghost"
										disabled={busy}
										onClick={() => onReview(item.group)}
									>
										개별 검토
									</button>
								)}
								{outcome?.reviewStateError && (
									<p className="mt-2 text-sm text-warning">
										파일 처리는 완료했지만 완료 상태 저장에 실패했습니다:{" "}
										{outcome.reviewStateError}
									</p>
								)}
								{item.action !== "trash" && item.action !== "review" && (
									<p className="mt-2 break-all font-mono text-xs">
										목적지: {target}
										{!item.targetPath &&
											!outcome?.targetPath &&
											" (동명 폴더는 번호를 붙여 보존)"}
									</p>
								)}
								<details
									className="mt-2"
									open={!!outcome?.files.some((file) => !file.success)}
								>
									<summary className="cursor-pointer text-sm focus-visible:outline focus-visible:outline-primary">
										유지·처리 파일 보기
									</summary>
									<ul className="mt-2 space-y-1 text-xs">
										{item.keepFiles.map((file) => (
											<li
												key={`keep-${file.path}`}
												className="break-all text-success"
											>
												유지 · {file.relativePath}
											</li>
										))}
										{item.processFiles.map((file) => {
											const fileResult = outcome?.files.find(
												(entry) => entry.path === file.path,
											);
											return (
												<li key={file.path} className="break-all">
													{fileResult
														? fileResult.success
															? "성공"
															: "실패"
														: outcome
															? "미실행"
															: "처리"}{" "}
													· {file.relativePath}
													{fileResult?.targetPath && (
														<span className="block text-base-content/60">
															→ {fileResult.targetPath}
														</span>
													)}
													{fileResult?.error && (
														<span className="block text-error">
															{fileResult.error}
														</span>
													)}
												</li>
											);
										})}
									</ul>
								</details>
							</section>
						);
					})}
				</div>
				<div className="flex flex-wrap items-center justify-between gap-2 border-t border-base-content/10 pt-3">
					<span className="text-sm">
						선택 {items.length}개 그룹 · 처리 {fileCount}개 파일
					</span>
					<div className="flex flex-wrap gap-2">
						{running ? (
							<button
								type="button"
								className="btn btn-sm btn-outline"
								onClick={() => void stop()}
								disabled={stopping}
							>
								중지
							</button>
						) : result ? (
							<button
								type="button"
								className="btn btn-sm btn-outline"
								disabled={
									loading ||
									!result.items.some((item) => item.status !== "succeeded")
								}
								onClick={() =>
									void loadPreview({
										...request,
										groupId: undefined,
										retryPlanId: result.planId,
									})
								}
							>
								남은 항목 다시 검토
							</button>
						) : (
							<button
								type="button"
								className="btn btn-sm btn-primary"
								onClick={() => void execute()}
								disabled={busy || !items.length}
							>
								선택 항목 실행
							</button>
						)}
					</div>
				</div>
			</div>
		</NativeDialog>
	);
};
