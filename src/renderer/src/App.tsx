import { useCallback, useEffect, useRef, useState } from "react";
import type { ScanArchiveProgress } from "../../shared/file-organizer";
import {
	CrawlerDbPanel,
	CrawlerPanel,
	EmptyState,
	FileTable,
	GearIcon,
	Header,
	LoadingState,
	NoResults,
	RandomReviewPanel,
	RosemaryBrand,
	Settings,
	SimilarGroupPanel,
	Stats,
} from "./components";
import { useFileActions } from "./hooks/useFileActions";
import { useFileThumbnails } from "./hooks/useFileThumbnails";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { useScrollToRow } from "./hooks/useScrollToRow";
import type { FileInfo } from "./types";
import { getRelativePath, parseFileStructure } from "./utils/file";

type AppTab = "files" | "crawler" | "crawler-db" | "similar" | "review";

function App(): React.JSX.Element {
	const DEFAULT_PATH = "D:/hitomi_downloader_GUI/hitomi_downloaded/new";

	const [activeTab, setActiveTab] = useState<AppTab>("files");
	const [selectedPath, setSelectedPath] = useState<string | null>(DEFAULT_PATH);
	const [fileList, setFileList] = useState<FileInfo[]>([]);
	const [isScanning, setIsScanning] = useState(false);
	const [thumbnailEnabled, setThumbnailEnabled] = useState(false);
	const [scanProgress, setScanProgress] = useState<ScanArchiveProgress | null>(
		null,
	);
	const [scanComplete, setScanComplete] = useState(false);
	const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const tableContainerRef = useRef<HTMLDivElement>(null);
	const thumbnailProgress = useFileThumbnails({
		enabled: thumbnailEnabled,
		fileList,
		scanComplete,
		setFileList,
	});
	const { handleCopyFile, handleMoveFile, handleKeepFile } = useFileActions({
		fileList,
		selectedRowIndex,
		setFileList,
		setSelectedRowIndex,
	});

	// 커스텀 훅 사용
	useKeyboardNavigation({
		enabled: activeTab === "files",
		scanComplete,
		fileList,
		selectedRowIndex,
		setSelectedRowIndex,
		setFileList,
	});

	useScrollToRow({
		selectedRowIndex,
		tableContainerRef,
	});

	useEffect(() => {
		const unsubscribe = window.electron.ipcRenderer.on(
			"scan-files-progress",
			(_, progress: ScanArchiveProgress) => {
				setScanProgress(progress);
			},
		);

		return unsubscribe;
	}, []);

	// 파일 목록이 변경될 때 선택된 인덱스 초기화
	useEffect(() => {
		if (fileList.length > 0 && selectedRowIndex === -1) {
			setSelectedRowIndex(0);
		} else if (fileList.length === 0) {
			setSelectedRowIndex(-1);
		}
	}, [fileList, selectedRowIndex]);

	const getPath = useCallback(async (): Promise<void> => {
		try {
			const path = await window.electron.ipcRenderer.invoke("get-target-path");
			setSelectedPath(path);
			setFileList([]);
			setScanComplete(false);
			setSelectedRowIndex(-1);
			setScanProgress(null);
		} catch (error) {
			console.error("폴더 선택 중 오류 발생:", error);
		}
	}, []);

	const scanFiles = useCallback(async (): Promise<void> => {
		if (!selectedPath) {
			alert("먼저 폴더를 선택해주세요.");
			return;
		}

		setIsScanning(true);
		setScanComplete(false);
		setFileList([]);
		setSelectedRowIndex(-1);
		setScanProgress({
			phase: "searching",
			processed: 0,
			total: 1,
			foundFiles: 0,
			currentPath: selectedPath,
		});

		try {
			const files = await window.electron.ipcRenderer.invoke(
				"scan-files",
				selectedPath,
			);

			// 각 파일에 대해 파싱 정보 추가
			const parsedFiles: FileInfo[] = files.map((file: FileInfo) => {
				const relativePath = getRelativePath(file.path, selectedPath);
				const parsedData = parseFileStructure(relativePath);

				return {
					...file,
					...parsedData,
				};
			});

			setFileList(parsedFiles);
			setScanComplete(true);
			setScanProgress({
				phase: "complete",
				processed: parsedFiles.length,
				total: parsedFiles.length,
				foundFiles: parsedFiles.length,
			});
		} catch (error) {
			console.error("파일 스캔 중 오류 발생:", error);
			alert("파일 스캔 중 오류가 발생했습니다.");
		} finally {
			setIsScanning(false);
		}
	}, [selectedPath]);

	const handleRowClick = useCallback((index: number): void => {
		setSelectedRowIndex(index);
	}, []);

	// 설정 열기/닫기 함수
	const handleOpenSettings = useCallback(() => {
		setIsSettingsOpen(true);
	}, []);

	const handleCloseSettings = useCallback(() => {
		setIsSettingsOpen(false);
	}, []);

	return (
		<div className="flex h-screen flex-col overflow-hidden bg-base-200">
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
				<div className="card bg-base-100 shadow-sm flex-shrink-0">
					<div className="card-body p-3">
						<div className="flex items-center justify-between gap-3">
							<div className="flex flex-col gap-3 lg:flex-row lg:items-center">
								<RosemaryBrand />
								<div
									className="tabs tabs-boxed tabs-sm bg-base-200 p-1"
									role="tablist"
									aria-label="기능 탭"
								>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "files" ? "tab-active" : ""}`}
										aria-selected={activeTab === "files"}
										onClick={() => setActiveTab("files")}
									>
										신규 파일 정리
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "crawler" ? "tab-active" : ""}`}
										aria-selected={activeTab === "crawler"}
										onClick={() => setActiveTab("crawler")}
									>
										로컬 크롤링
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "crawler-db" ? "tab-active" : ""}`}
										aria-selected={activeTab === "crawler-db"}
										onClick={() => setActiveTab("crawler-db")}
									>
										DB 관리
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "similar" ? "tab-active" : ""}`}
										aria-selected={activeTab === "similar"}
										onClick={() => setActiveTab("similar")}
									>
										유사 그룹 정리
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "review" ? "tab-active" : ""}`}
										aria-selected={activeTab === "review"}
										onClick={() => setActiveTab("review")}
									>
										랜덤 재검토
									</button>
								</div>
							</div>

							<button
								type="button"
								className="btn btn-sm btn-ghost btn-square"
								onClick={handleOpenSettings}
								title="설정"
								aria-label="설정 열기"
							>
								<GearIcon className="h-4 w-4" />
							</button>
						</div>
					</div>
				</div>

				{activeTab === "files" ? (
					<>
						<Header
							selectedPath={selectedPath}
							isScanning={isScanning}
							thumbnailEnabled={thumbnailEnabled}
							onSelectPath={getPath}
							onScanFiles={scanFiles}
							onThumbnailEnabledChange={setThumbnailEnabled}
						/>

						{isScanning && <LoadingState progress={scanProgress} />}

						{!isScanning && !scanComplete && !selectedPath && (
							<EmptyState onSelectPath={getPath} />
						)}

						{scanComplete && fileList.length === 0 && <NoResults />}

						{scanComplete && fileList.length > 0 && (
							<div className="flex-1 flex flex-col gap-4 overflow-hidden">
								<Stats
									fileList={fileList}
									selectedPath={selectedPath}
									onFileListChange={setFileList}
								/>
								<FileTable
									fileList={fileList}
									selectedRowIndex={selectedRowIndex}
									selectedPath={selectedPath}
									thumbnailEnabled={thumbnailEnabled}
									thumbnailProgress={thumbnailProgress}
									tableContainerRef={tableContainerRef}
									onRowClick={handleRowClick}
									onCopyFile={handleCopyFile}
									onMoveFile={handleMoveFile}
									onKeepFile={handleKeepFile}
								/>
							</div>
						)}
					</>
				) : activeTab === "review" ? (
					<RandomReviewPanel />
				) : activeTab === "similar" ? (
					<SimilarGroupPanel />
				) : activeTab === "crawler" ? (
					<CrawlerPanel />
				) : (
					<CrawlerDbPanel />
				)}
			</div>

			{/* 설정 모달 */}
			<Settings isOpen={isSettingsOpen} onClose={handleCloseSettings} />
		</div>
	);
}

export default App;
