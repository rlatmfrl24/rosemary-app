import { useState } from "react";
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

export const Stats = ({
	fileList,
	selectedPath,
	onFileListChange,
}: StatsProps): React.JSX.Element => {
	const [isMovingFiles, setIsMovingFiles] = useState(false);
	const [duplicates, setDuplicates] = useState<DuplicateFile[]>([]);
	const [showDuplicateHandler, setShowDuplicateHandler] = useState(false);

	const getTotalSize = (): string => {
		const totalBytes = fileList.reduce((sum, file) => sum + file.size, 0);
		return formatFileSize(totalBytes);
	};

	const handleDuplicateComplete = async (
		actions: Record<string, "overwrite" | "skip">,
	) => {
		setShowDuplicateHandler(false);
		await executeMoveFiles(actions);
	};

	const handleDuplicateCancel = () => {
		setShowDuplicateHandler(false);
		setDuplicates([]);
		setIsMovingFiles(false);
	};

	const executeMoveFiles = async (
		actions: Record<string, "overwrite" | "skip">,
	) => {
		try {
			// 최종 확인
			const confirm = window.confirm(
				`📦 총 ${fileList.length}개의 파일을 저장소로 이동하시겠습니까?\n\n` +
					(duplicates.length > 0
						? `🔄 중복 파일 ${duplicates.length}개 처리 설정 완료\n\n`
						: "") +
					"⚠️ 이 작업은 되돌릴 수 없습니다.",
			);

			if (!confirm) {
				return;
			}

			// 파일 이동
			const result = await window.electron.ipcRenderer.invoke(
				"move-all-files-to-store",
				fileList,
				selectedPath,
				actions,
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
			setIsMovingFiles(false);
		}
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

			// 1단계: 중복 파일 체크
			const duplicateCheck = await window.electron.ipcRenderer.invoke(
				"check-duplicate-files",
				fileList,
				selectedPath,
			);

			if (duplicateCheck.hasDuplicates) {
				setDuplicates(duplicateCheck.duplicates);
				setShowDuplicateHandler(true);
			} else {
				// 중복 파일이 없으면 바로 이동
				await executeMoveFiles({});
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
			<div className="card bg-base-100 shadow-lg flex-shrink-0">
				<div className="card-body p-4">
					<h2 className="card-title text-xl mb-4">
						<span>📊</span>
						스캔 결과
					</h2>

					<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
						<div className="stat bg-base-200 rounded-box p-4">
							<div className="stat-figure text-primary">
								<span className="text-2xl">📦</span>
							</div>
							<div className="stat-title text-sm">압축파일 개수</div>
							<div className="stat-value text-primary text-2xl">
								{fileList.length}
							</div>
							<div className="stat-desc text-xs">개의 파일</div>
						</div>

						<div className="stat bg-base-200 rounded-box p-4">
							<div className="stat-figure text-secondary">
								<span className="text-2xl">💾</span>
							</div>
							<div className="stat-title text-sm">총 용량</div>
							<div className="stat-value text-secondary text-2xl break-all">
								{getTotalSize()}
							</div>
							<div className="stat-desc text-xs">압축파일 총 크기</div>
						</div>
					</div>

					{fileList.length > 0 && (
						<div className="flex justify-center">
							<button
								type="button"
								className="btn btn-success btn-block"
								onClick={handleMoveAllFilesToStore}
								disabled={isMovingFiles}
							>
								{isMovingFiles ? (
									<>
										<span className="loading loading-spinner loading-sm" />
										이동 중...
									</>
								) : (
									<>
										<span>📁</span>
										모든 작품 보관
									</>
								)}
							</button>
						</div>
					)}
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
