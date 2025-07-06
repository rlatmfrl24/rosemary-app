import { useCallback, useEffect, useRef, useState } from "react";
import {
	EmptyState,
	FileTable,
	Header,
	LoadingState,
	NoResults,
	Settings,
	Stats,
} from "./components";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { useScrollToRow } from "./hooks/useScrollToRow";
import type { FileInfo } from "./types";
import { getRelativePath, parseFileStructure } from "./utils/file";

function App(): React.JSX.Element {
	const DEFAULT_PATH = "D:/hitomi_downloader_GUI/hitomi_downloaded/new";

	const [selectedPath, setSelectedPath] = useState<string | null>(DEFAULT_PATH);
	const [fileList, setFileList] = useState<FileInfo[]>([]);
	const [isScanning, setIsScanning] = useState(false);
	const [scanComplete, setScanComplete] = useState(false);
	const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const tableContainerRef = useRef<HTMLDivElement>(null);

	// 커스텀 훅 사용
	useKeyboardNavigation({
		scanComplete,
		fileList,
		selectedRowIndex,
		setSelectedRowIndex,
		setFileList,
	});

	useScrollToRow({
		selectedRowIndex,
		fileListLength: fileList.length,
		tableContainerRef,
	});

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
			<Header
				selectedPath={selectedPath}
				isScanning={isScanning}
				onSelectPath={getPath}
				onScanFiles={scanFiles}
				onOpenSettings={handleOpenSettings}
			/>

			<div className="flex-1 flex flex-col p-4 overflow-hidden">
				{isScanning && <LoadingState />}

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
							tableContainerRef={tableContainerRef}
							onRowClick={handleRowClick}
							onCopyFile={handleCopyFile}
							onMoveFile={handleMoveFile}
							onKeepFile={handleKeepFile}
						/>
					</div>
				)}
			</div>

			{/* 설정 모달 */}
			<Settings isOpen={isSettingsOpen} onClose={handleCloseSettings} />
		</div>
	);
}

export default App;
