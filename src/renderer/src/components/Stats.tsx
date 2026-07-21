import { useEffect, useMemo, useState } from "react";
import type { ScanIndexSummary } from "../../../shared/file-organizer";
import type {
	DuplicateAction,
	DuplicateFileInfo,
	ReviewFileInfo,
} from "../types";
import { formatFileSize, getRelativePath } from "../utils/file";
import { DuplicateFileHandler } from "./DuplicateFileHandler";

type FileReviewPhase = "idle" | "checking" | "complete" | "failed";
type ArchiveDuplicateAction = Exclude<DuplicateAction, "keep">;

interface StatsProps {
	fileList: ReviewFileInfo[];
	selectedPath: string | null;
	fileReviewPhase: FileReviewPhase;
	scanIndexSummary: ScanIndexSummary | null;
	onFileListChange?: (newFileList: ReviewFileInfo[]) => void;
	onDuplicateActionsChange?: (actions: Record<string, DuplicateAction>) => void;
}

interface FileEntryPayload {
	path: string;
	name: string;
	size: number;
}

interface ArchiveConfirmationState {
	isOpen: boolean;
	duplicateActions: Record<string, DuplicateAction>;
	groupTargetDirectories: Record<string, string>;
	checkingCount: number;
	reviewErrorCount: number;
	unresolvedDuplicateCount: number;
	reviewIssueCount: number;
	favoriteArtistCandidateCount: number;
}

const createEmptyArchiveConfirmation = (): ArchiveConfirmationState => ({
	isOpen: false,
	duplicateActions: {},
	groupTargetDirectories: {},
	checkingCount: 0,
	reviewErrorCount: 0,
	unresolvedDuplicateCount: 0,
	reviewIssueCount: 0,
	favoriteArtistCandidateCount: 0,
});

const formatIndexedAt = (indexedAt: number): string =>
	new Intl.DateTimeFormat("ko-KR", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(indexedAt));

const getDuplicateActionLabel = (action: DuplicateAction): string =>
	action === "overwrite"
		? "덮어쓰기"
		: action === "skip"
			? "건너뛰기"
			: "목록 유지";

export const Stats = ({
	fileList,
	selectedPath,
	fileReviewPhase,
	scanIndexSummary,
	onFileListChange,
	onDuplicateActionsChange,
}: StatsProps): React.JSX.Element => {
	const [isMovingFiles, setIsMovingFiles] = useState(false);
	const [duplicates, setDuplicates] = useState<DuplicateFileInfo[]>([]);
	const [showDuplicateHandler, setShowDuplicateHandler] = useState(false);
	const [archiveConfirmation, setArchiveConfirmation] =
		useState<ArchiveConfirmationState>(createEmptyArchiveConfirmation);

	const getTotalSize = (): string => {
		const totalBytes = fileList.reduce((sum, file) => sum + file.size, 0);
		return formatFileSize(totalBytes);
	};

	const getEffectiveDuplicateAction = (
		file: ReviewFileInfo,
		actions: Record<string, DuplicateAction> = {},
	): DuplicateAction | undefined => {
		if (file.duplicateAction) {
			return file.duplicateAction;
		}

		if (!file.duplicate) {
			return undefined;
		}

		const relativePath = selectedPath
			? getRelativePath(file.path, selectedPath)
			: file.name;

		return (
			actions[file.duplicate.relativePath] ||
			actions[relativePath] ||
			actions[file.name]
		);
	};

	const shouldExcludeFromArchive = (
		file: ReviewFileInfo,
		actions: Record<string, DuplicateAction> = {},
	): boolean => {
		const action = getEffectiveDuplicateAction(file, actions);
		return action === "skip" || action === "keep";
	};

	const getFileEntryPayloads = (
		actions: Record<string, DuplicateAction> = {},
	): FileEntryPayload[] =>
		fileList
			.filter((file) => !shouldExcludeFromArchive(file, actions))
			.map((file) => ({
				path: file.path,
				name: file.name,
				size: file.size,
			}));

	const getDuplicateActionsFromFiles = (): Record<string, DuplicateAction> => {
		const actions: Record<string, DuplicateAction> = {};

		for (const file of fileList) {
			if (!file.duplicate || !file.duplicateAction) {
				continue;
			}

			actions[file.duplicate.relativePath] = file.duplicateAction;
		}

		return actions;
	};

	const getArchiveDuplicateActions = (
		actions: Record<string, DuplicateAction>,
	): Record<string, ArchiveDuplicateAction> =>
		Object.fromEntries(
			Object.entries(actions).filter(
				(entry): entry is [string, ArchiveDuplicateAction] =>
					entry[1] !== "keep",
			),
		);

	const getGroupTargetDirectories = (): Record<string, string> =>
		Object.fromEntries(
			fileList
				.filter(
					(file) =>
						file.groupCandidate &&
						!file.duplicate &&
						file.useGroupTarget !== false &&
						!shouldExcludeFromArchive(file),
				)
				.map((file) => [
					file.groupCandidate?.relativePath ?? file.name,
					file.groupCandidate?.groupPath ?? "",
				])
				.filter(([, groupPath]) => Boolean(groupPath)),
		);

	const getUnresolvedDuplicates = (): DuplicateFileInfo[] =>
		fileList
			.filter((file) => file.duplicate && !file.duplicateAction)
			.map((file) => file.duplicate)
			.filter((duplicate): duplicate is DuplicateFileInfo =>
				Boolean(duplicate),
			);

	const reviewCounts = useMemo(
		() =>
			fileList.reduce(
				(counts, file) => {
					counts.total += 1;
					if (file.reviewStatus === "ready" && !file.favoriteArtistCandidate) {
						counts.ready += 1;
					}
					if (file.reviewStatus === "checking") {
						counts.checking += 1;
					}
					if (file.duplicate) {
						counts.duplicate += 1;
					}
					if (file.groupCandidate) {
						counts.groupCandidate += 1;
					}
					if (file.favoriteArtistCandidate) {
						counts.favoriteArtistCandidate += 1;
					}
					if (file.duplicate && !file.duplicateAction) {
						counts.unresolved += 1;
					}
					if (
						file.reviewStatus === "review-needed" ||
						file.reviewStatus === "checking" ||
						(file.duplicate && !file.duplicateAction)
					) {
						counts.needsAttention += 1;
					}
					if (file.duplicateAction === "skip") {
						counts.skipped += 1;
					}
					if (file.duplicateAction === "keep") {
						counts.held += 1;
					}
					if (file.reviewError) {
						counts.errors += 1;
					}
					return counts;
				},
				{
					total: 0,
					checking: 0,
					ready: 0,
					duplicate: 0,
					groupCandidate: 0,
					favoriteArtistCandidate: 0,
					unresolved: 0,
					needsAttention: 0,
					skipped: 0,
					held: 0,
					errors: 0,
				} as {
					total: number;
					checking: number;
					ready: number;
					duplicate: number;
					groupCandidate: number;
					favoriteArtistCandidate: number;
					unresolved: number;
					needsAttention: number;
					skipped: number;
					held: number;
					errors: number;
				},
			),
		[fileList],
	);

	const reviewPhaseLabel =
		fileReviewPhase === "checking"
			? "검토 중"
			: fileReviewPhase === "complete"
				? "검토 완료"
				: fileReviewPhase === "failed"
					? "검토 오류"
					: "대기";

	const openArchiveConfirmation = (
		duplicateActions: Record<string, DuplicateAction>,
		groupTargetDirectories: Record<string, string>,
	): void => {
		const unresolvedDuplicateCount = fileList.filter((file) => {
			if (!file.duplicate) {
				return false;
			}

			return !(
				file.duplicateAction ||
				duplicateActions[file.duplicate.relativePath] ||
				duplicateActions[file.name]
			);
		}).length;
		const favoriteArtistCandidateCount = fileList.filter(
			(file) =>
				file.favoriteArtistCandidate &&
				!shouldExcludeFromArchive(file, duplicateActions),
		).length;
		const reviewIssueCount = fileList.filter(
			(file) => (file.reviewIssues?.length ?? 0) > 0,
		).length;

		setArchiveConfirmation({
			isOpen: true,
			duplicateActions,
			groupTargetDirectories,
			checkingCount: reviewCounts.checking,
			reviewErrorCount: reviewCounts.errors,
			unresolvedDuplicateCount,
			reviewIssueCount,
			favoriteArtistCandidateCount,
		});
	};

	const handleMoveAllFilesToStore = async (): Promise<void> => {
		if (fileList.length === 0) {
			alert("이동할 파일이 없습니다.");
			return;
		}

		if (!selectedPath) {
			alert("스캔 경로 정보가 없습니다.");
			return;
		}

		const unresolvedDuplicates = getUnresolvedDuplicates();
		setIsMovingFiles(true);

		if (unresolvedDuplicates.length > 0) {
			setDuplicates(unresolvedDuplicates);
			setShowDuplicateHandler(true);
			return;
		}

		openArchiveConfirmation(
			getDuplicateActionsFromFiles(),
			getGroupTargetDirectories(),
		);
	};

	const handleDuplicateComplete = (
		actions: Record<string, DuplicateAction>,
	): void => {
		setShowDuplicateHandler(false);
		onDuplicateActionsChange?.(actions);
		openArchiveConfirmation(
			{
				...getDuplicateActionsFromFiles(),
				...actions,
			},
			getGroupTargetDirectories(),
		);
	};

	const handleDuplicateCancel = () => {
		setShowDuplicateHandler(false);
		setDuplicates([]);
		setIsMovingFiles(false);
	};

	const handleArchiveCancel = (): void => {
		setArchiveConfirmation(createEmptyArchiveConfirmation());
		setIsMovingFiles(false);
	};

	useEffect(() => {
		if (!archiveConfirmation.isOpen) {
			return;
		}

		const handleKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setArchiveConfirmation(createEmptyArchiveConfirmation());
				setIsMovingFiles(false);
			}
		};

		document.addEventListener("keydown", handleKeyDown);

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [archiveConfirmation.isOpen]);

	const executeMoveFiles = async (): Promise<void> => {
		if (!selectedPath) {
			alert("스캔 경로 정보가 없습니다.");
			setIsMovingFiles(false);
			return;
		}

		try {
			const fileEntryPayloads = getFileEntryPayloads(
				archiveConfirmation.duplicateActions,
			);
			if (fileEntryPayloads.length === 0) {
				alert(
					"보관할 파일이 없습니다. 건너뛰기/목록 유지 항목은 목록에 남깁니다.",
				);
				setArchiveConfirmation(createEmptyArchiveConfirmation());
				setDuplicates([]);
				setIsMovingFiles(false);
				return;
			}

			const result = await window.electron.ipcRenderer.invoke(
				"move-all-files-to-store",
				fileEntryPayloads,
				selectedPath,
				getArchiveDuplicateActions(archiveConfirmation.duplicateActions),
				archiveConfirmation.groupTargetDirectories,
			);

			if (result.success) {
				const actionSummary = result.results.reduce(
					(acc, r) => {
						if (r.success && r.action) {
							acc[r.action] = (acc[r.action] || 0) + 1;
						}
						return acc;
					},
					{} as Record<string, number>,
				);

				const summaryText = Object.entries(actionSummary)
					.map(([action, count]) => `${action}: ${count}개`)
					.join("\n");

				alert(
					"파일 이동이 완료되었습니다.\n\n" +
						`총 ${result.summary.total}개 중:\n` +
						`성공: ${result.summary.success}개\n` +
						`실패: ${result.summary.failed}개\n\n` +
						`작업 내역:\n${summaryText}`,
				);
			} else {
				const failedFiles = result.results
					.filter((r) => !r.success)
					.map((r) => `${r.file}: ${r.error}`)
					.join("\n");

				alert(
					"일부 파일 이동에 실패했습니다.\n\n" +
						`성공: ${result.summary.success}개\n` +
						`실패: ${result.summary.failed}개\n\n` +
						`실패한 파일:\n${failedFiles}`,
				);
			}

			if (onFileListChange) {
				const remainingFiles = fileList.filter((file) => {
					const moveResult = result.results.find(
						(r) => r.sourcePath === file.path,
					);
					return !moveResult || !moveResult.success;
				});
				onFileListChange(remainingFiles);
			}
		} catch (error) {
			console.error("파일 이동 중 오류 발생:", error);
			const errorMessage =
				error instanceof Error
					? error.message
					: "알 수 없는 오류가 발생했습니다.";
			alert(`파일 이동 중 오류가 발생했습니다:\n${errorMessage}`);
		} finally {
			setArchiveConfirmation(createEmptyArchiveConfirmation());
			setDuplicates([]);
			setIsMovingFiles(false);
		}
	};

	const duplicateActionCounts = Object.values(
		archiveConfirmation.duplicateActions,
	).reduce(
		(counts, action) => {
			counts[action] += 1;
			return counts;
		},
		{ overwrite: 0, skip: 0, keep: 0 } as Record<DuplicateAction, number>,
	);
	const groupTargetCount = Object.keys(
		archiveConfirmation.groupTargetDirectories,
	).length;
	const archiveCandidateCount = Math.max(
		0,
		fileList.length - duplicateActionCounts.skip - duplicateActionCounts.keep,
	);
	const directMoveCount = Math.max(
		0,
		archiveCandidateCount - duplicateActionCounts.overwrite - groupTargetCount,
	);

	return (
		<>
			<div className="card flex-shrink-0 bg-base-100 shadow-sm">
				<div className="card-body p-3">
					<div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
						<div className="flex min-w-0 flex-1 flex-col gap-2 lg:flex-row lg:items-center lg:gap-4">
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-sm font-semibold">스캔 결과</span>
								<span className="badge badge-neutral badge-sm">
									파일 {reviewCounts.total}개
								</span>
								<span className="badge badge-outline badge-sm">
									용량 {getTotalSize()}
								</span>
								<span
									className={`badge badge-sm ${
										fileReviewPhase === "failed"
											? "badge-error"
											: fileReviewPhase === "checking"
												? "badge-info"
												: "badge-ghost"
									}`}
								>
									{fileReviewPhase === "checking" && (
										<span className="loading loading-spinner loading-xs" />
									)}
									{reviewPhaseLabel}
								</span>
							</div>

							<div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-base-content/10 pt-2 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
								<span className="hidden text-[11px] font-semibold text-base-content/45 2xl:inline">
									검토
								</span>
								<span className="badge badge-success badge-sm">
									일반 보관 {reviewCounts.ready}개
								</span>
								<span className="badge badge-warning badge-sm">
									그룹 후보 {reviewCounts.groupCandidate}개
								</span>
								<span className="badge badge-info badge-sm">
									작가 후보 {reviewCounts.favoriteArtistCandidate}개
								</span>
								<span className="badge badge-error badge-sm">
									중복 {reviewCounts.duplicate}개
								</span>
								<span className="badge badge-ghost badge-sm">
									확인 필요 {reviewCounts.needsAttention}개
								</span>
							</div>

							<div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-base-content/10 pt-2 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
								<span className="hidden text-[11px] font-semibold text-base-content/45 2xl:inline">
									DB
								</span>
								{scanIndexSummary ? (
									<>
										<span className="badge badge-ghost badge-sm">
											{scanIndexSummary.cacheUsed ? "사용" : "생성"}
										</span>
										<span className="badge badge-ghost badge-sm">
											재사용 {scanIndexSummary.reusedCount}개
										</span>
										<span className="badge badge-ghost badge-sm">
											신규/갱신 {scanIndexSummary.refreshedCount}개
										</span>
										{scanIndexSummary.removedCount > 0 && (
											<span className="badge badge-warning badge-sm">
												정리 {scanIndexSummary.removedCount}개
											</span>
										)}
										<span className="badge badge-ghost badge-sm">
											{formatIndexedAt(scanIndexSummary.indexedAt)}
										</span>
									</>
								) : (
									<span className="text-xs text-base-content/45">
										인덱스 정보 없음
									</span>
								)}
							</div>
						</div>

						{fileList.length > 0 && (
							<button
								type="button"
								className="btn btn-sm btn-success w-full md:w-auto xl:justify-self-end"
								onClick={handleMoveAllFilesToStore}
								disabled={isMovingFiles}
								aria-label="검토된 신규 파일을 저장소로 전체 보관"
							>
								{isMovingFiles ? (
									<>
										<span className="loading loading-spinner loading-xs" />
										준비 중
									</>
								) : (
									"저장소로 전체 보관"
								)}
							</button>
						)}
					</div>
				</div>
			</div>

			<DuplicateFileHandler
				duplicates={duplicates}
				isVisible={showDuplicateHandler}
				onComplete={handleDuplicateComplete}
				onCancel={handleDuplicateCancel}
			/>

			{archiveConfirmation.isOpen && (
				<dialog
					className="modal modal-open"
					open
					aria-labelledby="archive-confirmation-title"
				>
					<div className="modal-box max-w-2xl">
						<h3 id="archive-confirmation-title" className="text-lg font-bold">
							저장소 보관 실행 확인
						</h3>
						<p className="mt-2 text-sm text-base-content/70">
							현재 검토 결과와 선택한 중복 처리 기준으로 파일을 일반 저장소로
							이동합니다. Favorite 이동과는 별도 작업이며 이 작업은 되돌릴 수
							없습니다.
						</p>

						<div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
							<div className="rounded-box bg-base-200 p-3">
								<div className="text-xs text-base-content/55">일반 이동</div>
								<div className="text-lg font-bold">{directMoveCount}개</div>
							</div>
							<div className="rounded-box bg-base-200 p-3">
								<div className="text-xs text-base-content/55">그룹 편입</div>
								<div className="text-lg font-bold">{groupTargetCount}개</div>
							</div>
							<div className="rounded-box bg-base-200 p-3">
								<div className="text-xs text-base-content/55">
									중복 덮어쓰기
								</div>
								<div className="text-lg font-bold">
									{duplicateActionCounts.overwrite}개
								</div>
							</div>
							<div className="rounded-box bg-base-200 p-3">
								<div className="text-xs text-base-content/55">
									중복 건너뛰기
								</div>
								<div className="text-lg font-bold">
									{duplicateActionCounts.skip}개
								</div>
							</div>
							<div className="rounded-box bg-base-200 p-3">
								<div className="text-xs text-base-content/55">목록 유지</div>
								<div className="text-lg font-bold">
									{duplicateActionCounts.keep}개
								</div>
							</div>
						</div>

						{(archiveConfirmation.checkingCount > 0 ||
							archiveConfirmation.reviewErrorCount > 0 ||
							archiveConfirmation.unresolvedDuplicateCount > 0 ||
							archiveConfirmation.reviewIssueCount > 0) && (
							<div className="alert alert-warning mt-4 py-3 text-sm">
								<span>
									검토 미완료 {archiveConfirmation.checkingCount}개, 검토 오류{" "}
									{archiveConfirmation.reviewErrorCount}개, 미해결 중복{" "}
									{archiveConfirmation.unresolvedDuplicateCount}개, 확인 필요{" "}
									{archiveConfirmation.reviewIssueCount}개가 현재 선택 기준대로
									처리됩니다.
								</span>
							</div>
						)}

						{archiveConfirmation.favoriteArtistCandidateCount > 0 && (
							<div className="alert alert-info mt-4 py-3 text-sm">
								<span>
									Favorite Artist 작가 폴더와 일치하는 파일{" "}
									{archiveConfirmation.favoriteArtistCandidateCount}개가
									포함되어 있습니다. 이 파일들은 상세 패널의 작가 버튼으로 작가
									폴더에 직접 이동할 수 있습니다.
								</span>
							</div>
						)}

						{Object.entries(archiveConfirmation.duplicateActions).length >
							0 && (
							<div className="mt-4 rounded-box border border-base-300 p-3">
								<div className="mb-2 text-xs font-semibold text-base-content/60">
									중복 처리 요약
								</div>
								<div className="max-h-28 overflow-auto font-mono text-[11px] text-base-content/70">
									{Object.entries(archiveConfirmation.duplicateActions).map(
										([relativePath, action]) => (
											<div key={relativePath} className="truncate">
												{relativePath}: {getDuplicateActionLabel(action)}
											</div>
										),
									)}
								</div>
							</div>
						)}

						<div className="modal-action">
							<button
								type="button"
								className="btn btn-outline"
								onClick={handleArchiveCancel}
							>
								취소
							</button>
							<button
								type="button"
								className="btn btn-success"
								onClick={executeMoveFiles}
								aria-label="저장소 전체 보관 실행"
							>
								저장소 보관 실행
							</button>
						</div>
					</div>
					<form method="dialog" className="modal-backdrop">
						<button
							type="button"
							aria-label="저장소 보관 확인 닫기"
							onClick={handleArchiveCancel}
						>
							close
						</button>
					</form>
				</dialog>
			)}
		</>
	);
};
