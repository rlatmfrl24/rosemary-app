import { useCallback, useEffect, useRef, useState } from "react";
import type {
	FileThumbnail,
	ScanArchiveProgress,
} from "../../shared/file-organizer";
import {
	CrawlerDbPanel,
	CrawlerPanel,
	EmptyState,
	FileTable,
	GearIcon,
	Header,
	LoadingState,
	NoResults,
	RosemaryBrand,
	Settings,
	Stats,
} from "./components";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { useScrollToRow } from "./hooks/useScrollToRow";
import type { FileInfo } from "./types";
import { getRelativePath, parseFileStructure } from "./utils/file";

type AppTab = "files" | "crawler" | "crawler-db";

interface ThumbnailProgress {
	loaded: number;
	total: number;
	currentFileName?: string;
}

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
	const [thumbnailProgress, setThumbnailProgress] =
		useState<ThumbnailProgress | null>(null);
	const [scanComplete, setScanComplete] = useState(false);
	const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const tableContainerRef = useRef<HTMLDivElement>(null);
	const fileListRef = useRef<FileInfo[]>([]);
	const thumbnailRequestIdRef = useRef(0);

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
		fileListRef.current = fileList;
	}, [fileList]);

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

	useEffect(() => {
		const currentFileList = fileListRef.current;
		const fileCount = fileList.length;

		if (!thumbnailEnabled || !scanComplete || fileCount === 0) {
			thumbnailRequestIdRef.current += 1;
			setThumbnailProgress(null);
			return;
		}

		const requestId = thumbnailRequestIdRef.current + 1;
		thumbnailRequestIdRef.current = requestId;
		const targets = currentFileList.filter(
			(file) => !file.thumbnail && file.thumbnailLoadState !== "failed",
		);
		const loadingPaths = new Set(targets.map((file) => file.path));
		let loadedCount = fileCount - targets.length;
		let nextIndex = 0;

		setThumbnailProgress({
			loaded: loadedCount,
			total: fileCount,
		});

		if (targets.length === 0) {
			return;
		}

		setFileList((prevList) =>
			prevList.map((file) =>
				loadingPaths.has(file.path)
					? {
							...file,
							thumbnailLoadState: "loading",
						}
					: file,
			),
		);

		const loadThumbnail = async (file: FileInfo): Promise<void> => {
			setThumbnailProgress({
				loaded: loadedCount,
				total: fileCount,
				currentFileName: file.name,
			});

			let thumbnail: FileThumbnail | null = null;

			try {
				thumbnail = (await window.electron.ipcRenderer.invoke(
					"get-file-thumbnail",
					file.path,
				)) as FileThumbnail | null;
			} catch (error) {
				console.warn("썸네일 로딩 실패:", file.path, error);
			}

			if (thumbnailRequestIdRef.current !== requestId) {
				return;
			}

			loadedCount += 1;
			setFileList((prevList) =>
				prevList.map((currentFile) => {
					if (currentFile.path !== file.path) {
						return currentFile;
					}

					return thumbnail
						? {
								...currentFile,
								thumbnail,
								thumbnailLoadState: undefined,
							}
						: {
								...currentFile,
								thumbnailLoadState: "failed",
							};
				}),
			);
			setThumbnailProgress({
				loaded: loadedCount,
				total: fileCount,
				currentFileName: loadedCount < fileCount ? file.name : undefined,
			});
		};

		const workerCount = Math.min(8, targets.length);
		const workers = Array.from({ length: workerCount }, async () => {
			while (
				thumbnailRequestIdRef.current === requestId &&
				nextIndex < targets.length
			) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				const file = targets[currentIndex];

				if (file) {
					await loadThumbnail(file);
				}
			}
		});

		void Promise.all(workers).then(() => {
			if (thumbnailRequestIdRef.current === requestId) {
				setThumbnailProgress((progress) =>
					progress
						? {
								loaded: progress.total,
								total: progress.total,
							}
						: progress,
				);
			}
		});

		return () => {
			thumbnailRequestIdRef.current += 1;
		};
	}, [fileList.length, thumbnailEnabled, scanComplete]);

	const getPath = useCallback(async (): Promise<void> => {
		try {
			const path = await window.electron.ipcRenderer.invoke("get-target-path");
			setSelectedPath(path);
			setFileList([]);
			setScanComplete(false);
			setSelectedRowIndex(-1);
			setScanProgress(null);
			setThumbnailProgress(null);
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
		setThumbnailProgress(null);

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

	// 파일 복사 핸들러
	const handleCopyFile = useCallback(async (file: FileInfo): Promise<void> => {
		try {
			// 사용자에게 대상 경로 선택 요청
			const targetPath =
				await window.electron.ipcRenderer.invoke("get-target-path");
			if (!targetPath) return;

			// 대상 파일 경로 생성
			const fileName = file.name;
			const finalTargetPath = `${targetPath}/${fileName}`;

			// 파일 복사 실행
			const result = await window.electron.ipcRenderer.invoke(
				"copy-file",
				file.path,
				finalTargetPath,
			);

			if (result.success) {
				alert(
					`파일이 성공적으로 복사되었습니다.\n대상 경로: ${result.targetPath}`,
				);
			}
		} catch (error) {
			console.error("파일 복사 중 오류 발생:", error);
			alert(
				`파일 복사 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		}
	}, []);

	// 파일 이동 핸들러
	const handleMoveFile = useCallback(
		async (file: FileInfo): Promise<void> => {
			try {
				const confirmMove = confirm(
					`파일을 이동하시겠습니까?\n파일: ${file.name}\n\n이동하면 원본 파일이 삭제됩니다.`,
				);
				if (!confirmMove) return;

				// 사용자에게 대상 경로 선택 요청
				const targetPath =
					await window.electron.ipcRenderer.invoke("get-target-path");
				if (!targetPath) return;

				// 대상 파일 경로 생성
				const fileName = file.name;
				const finalTargetPath = `${targetPath}/${fileName}`;

				// 파일 이동 실행
				const result = await window.electron.ipcRenderer.invoke(
					"move-file",
					file.path,
					finalTargetPath,
				);

				if (result.success) {
					alert(
						`파일이 성공적으로 이동되었습니다.\n대상 경로: ${result.targetPath}`,
					);

					// 파일 목록에서 이동된 파일 제거
					setFileList((prevList) =>
						prevList.filter((f) => f.path !== file.path),
					);

					// 선택된 인덱스 조정
					if (selectedRowIndex >= fileList.length - 1) {
						setSelectedRowIndex(Math.max(0, fileList.length - 2));
					}
				}
			} catch (error) {
				console.error("파일 이동 중 오류 발생:", error);
				alert(
					`파일 이동 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			}
		},
		[fileList.length, selectedRowIndex],
	);

	// 파일 보관 핸들러
	const handleKeepFile = useCallback(async (file: FileInfo): Promise<void> => {
		try {
			// 파일 보관 실행
			const result = await window.electron.ipcRenderer.invoke(
				"keep-file",
				file.path,
			);

			if (result.success) {
				alert(
					`파일이 성공적으로 보관되었습니다.\n보관 경로: ${result.targetPath}`,
				);
			}
		} catch (error) {
			console.error("파일 보관 중 오류 발생:", error);
			alert(
				`파일 보관 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		}
	}, []);

	return (
		<div className="min-h-screen bg-base-200 flex flex-col">
			<div className="flex-1 flex flex-col gap-3 overflow-hidden p-3">
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
										파일 정리
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
