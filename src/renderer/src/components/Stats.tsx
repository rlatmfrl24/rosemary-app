import { useState } from "react";
import type { GroupMergeCandidate } from "../../../shared/file-organizer";
import type { FileInfo } from "../types";
import { formatFileSize } from "../utils/file";
import { DuplicateFileHandler } from "./DuplicateFileHandler";

interface StatsProps {
	fileList: FileInfo[];
	selectedPath: string | null;
	onFileListChange?: (newFileList: FileInfo[]) => void;
}

interface DuplicateFile {
	sourceFile: string;
	sourcePath: string;
	sourceSize: number;
	targetPath: string;
	targetSize: number;
	relativePath: string;
}

interface FileEntryPayload {
	path: string;
	name: string;
	size: number;
}

export const Stats = ({
	fileList,
	selectedPath,
	onFileListChange,
}: StatsProps): React.JSX.Element => {
	const [isMovingFiles, setIsMovingFiles] = useState(false);
	const [duplicates, setDuplicates] = useState<DuplicateFile[]>([]);
	const [showDuplicateHandler, setShowDuplicateHandler] = useState(false);
	const [pendingGroupTargets, setPendingGroupTargets] = useState<
		Record<string, string>
	>({});

	const getTotalSize = (): string => {
		const totalBytes = fileList.reduce((sum, file) => sum + file.size, 0);
		return formatFileSize(totalBytes);
	};

	const getFileEntryPayloads = (): FileEntryPayload[] =>
		fileList.map((file) => ({
			path: file.path,
			name: file.name,
			size: file.size,
		}));

	const handleDuplicateComplete = async (
		actions: Record<string, "overwrite" | "skip">,
	) => {
		setShowDuplicateHandler(false);
		await executeMoveFiles(actions, pendingGroupTargets);
	};

	const handleDuplicateCancel = () => {
		setShowDuplicateHandler(false);
		setDuplicates([]);
		setPendingGroupTargets({});
		setIsMovingFiles(false);
	};

	const executeMoveFiles = async (
		actions: Record<string, "overwrite" | "skip">,
		groupTargetDirectories: Record<string, string> = pendingGroupTargets,
	) => {
		try {
			const groupTargetCount = Object.keys(groupTargetDirectories).length;
			// 최종 확인
			const confirm = window.confirm(
				`📦 총 ${fileList.length}개의 파일을 저장소로 이동하시겠습니까?\n\n` +
					(duplicates.length > 0
						? `🔄 중복 파일 ${duplicates.length}개 처리 설정 완료\n\n`
						: "") +
					(groupTargetCount > 0
						? `🗂 기존 그룹 편입 ${groupTargetCount}개 적용\n\n`
						: "") +
					"⚠️ 이 작업은 되돌릴 수 없습니다.",
			);

			if (!confirm) {
				return;
			}

			// 파일 이동
			const result = await window.electron.ipcRenderer.invoke(
				"move-all-files-to-store",
				getFileEntryPayloads(),
				selectedPath,
				actions,
				groupTargetDirectories,
			);

			// 결과 표시
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
					"파일 이동이 완료되었습니다! 🎉\n\n" +
						`📦 총 ${result.summary.total}개 중:\n` +
						`✅ 성공: ${result.summary.success}개\n` +
						`❌ 실패: ${result.summary.failed}개\n\n` +
						`📋 작업 내역:\n${summaryText}`,
				);
			} else {
				// 실패한 파일들 표시
				const failedFiles = result.results
					.filter((r) => !r.success)
					.map((r) => `${r.file}: ${r.error}`)
					.join("\n");

				alert(
					"일부 파일 이동에 실패했습니다. ⚠️\n\n" +
						`✅ 성공: ${result.summary.success}개\n` +
						`❌ 실패: ${result.summary.failed}개\n\n` +
						`❌ 실패한 파일들:\n${failedFiles}`,
				);
			}

			// 성공적으로 이동된 파일들을 목록에서 제거
			if (onFileListChange) {
				const remainingFiles = fileList.filter((file) => {
					const moveResult = result.results.find((r) => r.file === file.name);
					return moveResult && !moveResult.success;
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
			setPendingGroupTargets({});
			setIsMovingFiles(false);
		}
	};

	const getGroupTargetsFromCandidates = (
		candidates: GroupMergeCandidate[],
	): Record<string, string> =>
		Object.fromEntries(
			candidates.map((candidate) => [
				candidate.relativePath,
				candidate.groupPath,
			]),
		);

	const confirmGroupMergeCandidates = (
		candidates: GroupMergeCandidate[],
	): Record<string, string> => {
		if (candidates.length === 0) {
			return {};
		}

		const preview = candidates
			.slice(0, 8)
			.map(
				(candidate) =>
					`- ${candidate.fileName}\n  -> ${candidate.groupName} (${candidate.confidence})`,
			)
			.join("\n");
		const suffix =
			candidates.length > 8 ? `\n...외 ${candidates.length - 8}개 후보` : "";
		const confirmed = window.confirm(
			`기존 그룹에 편입할 가능성이 있는 신규 파일 ${candidates.length}개를 찾았습니다.\n\n${preview}${suffix}\n\n확인: 해당 그룹으로 편입해서 보관\n취소: 일반 보관으로 계속`,
		);

		return confirmed ? getGroupTargetsFromCandidates(candidates) : {};
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

		try {
			setIsMovingFiles(true);
			const groupMergeCandidates =
				await window.api.fileOrganizer.findGroupMergeCandidates(
					getFileEntryPayloads(),
					selectedPath,
				);
			const groupTargetDirectories =
				confirmGroupMergeCandidates(groupMergeCandidates);
			setPendingGroupTargets(groupTargetDirectories);

			// 1단계: 중복 파일 체크
			const duplicateCheck = await window.electron.ipcRenderer.invoke(
				"check-duplicate-files",
				getFileEntryPayloads(),
				selectedPath,
			);

			if (duplicateCheck.hasDuplicates) {
				setDuplicates(duplicateCheck.duplicates);
				setShowDuplicateHandler(true);
			} else {
				// 중복 파일이 없으면 바로 이동
				await executeMoveFiles({}, groupTargetDirectories);
			}
		} catch (error) {
			console.error("파일 체크 중 오류 발생:", error);
			const errorMessage =
				error instanceof Error
					? error.message
					: "알 수 없는 오류가 발생했습니다.";
			alert(`파일 체크 중 오류가 발생했습니다:\n${errorMessage}`);
			setIsMovingFiles(false);
		}
	};

	return (
		<>
			<div className="card bg-base-100 shadow-sm flex-shrink-0">
				<div className="card-body gap-3 p-3">
					<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
						<div className="flex flex-wrap items-center gap-2">
							<div className="text-sm font-semibold">스캔 결과</div>
							<div className="badge badge-neutral badge-sm">
								파일 {fileList.length}개
							</div>
							<div className="badge badge-outline badge-sm">
								용량 {getTotalSize()}
							</div>
						</div>

						{fileList.length > 0 && (
							<button
								type="button"
								className="btn btn-sm btn-success"
								onClick={handleMoveAllFilesToStore}
								disabled={isMovingFiles}
							>
								{isMovingFiles ? (
									<>
										<span className="loading loading-spinner loading-xs" />
										이동 중
									</>
								) : (
									"전체 보관"
								)}
							</button>
						)}
					</div>
				</div>
			</div>

			{/* 중복 파일 처리 핸들러 */}
			<DuplicateFileHandler
				duplicates={duplicates}
				isVisible={showDuplicateHandler}
				onComplete={handleDuplicateComplete}
				onCancel={handleDuplicateCancel}
			/>
		</>
	);
};
