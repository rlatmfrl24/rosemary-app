import { useCallback, useEffect } from "react";
import type { FileInfo } from "../types";

interface UseKeyboardNavigationProps<TFile extends FileInfo = FileInfo> {
	enabled: boolean;
	scanComplete: boolean;
	fileList: TFile[];
	selectedRowIndex: number;
	setSelectedRowIndex: (index: number) => void;
	setFileList: (files: TFile[]) => void;
	visibleFileIndexes?: number[];
}

const getNextVisibleIndex = (
	visibleFileIndexes: number[],
	selectedRowIndex: number,
	direction: "previous" | "next",
): number => {
	if (visibleFileIndexes.length === 0) {
		return -1;
	}

	const currentPosition = visibleFileIndexes.indexOf(selectedRowIndex);
	if (currentPosition === -1) {
		return visibleFileIndexes[0] ?? -1;
	}

	const nextPosition =
		direction === "previous"
			? Math.max(0, currentPosition - 1)
			: Math.min(visibleFileIndexes.length - 1, currentPosition + 1);

	return visibleFileIndexes[nextPosition] ?? selectedRowIndex;
};

export const useKeyboardNavigation = <TFile extends FileInfo = FileInfo>({
	enabled,
	scanComplete,
	fileList,
	selectedRowIndex,
	setSelectedRowIndex,
	setFileList,
	visibleFileIndexes,
}: UseKeyboardNavigationProps<TFile>): void => {
	const handleKeyDown = useCallback(
		(event: KeyboardEvent): void => {
			if (!enabled || !scanComplete || fileList.length === 0) return;
			const navigableIndexes =
				visibleFileIndexes && visibleFileIndexes.length > 0
					? visibleFileIndexes
					: fileList.map((_, index) => index);

			switch (event.key) {
				case "ArrowUp":
					event.preventDefault();
					setSelectedRowIndex(
						getNextVisibleIndex(navigableIndexes, selectedRowIndex, "previous"),
					);
					break;

				case "ArrowDown":
					event.preventDefault();
					setSelectedRowIndex(
						getNextVisibleIndex(navigableIndexes, selectedRowIndex, "next"),
					);
					break;

				case "Enter":
					event.preventDefault();
					if (selectedRowIndex >= 0 && selectedRowIndex < fileList.length) {
						const selectedFile = fileList[selectedRowIndex];
						console.log("BandiView로 파일 열기:", selectedFile.name);

						// BandiView로 파일 열기
						window.electron.ipcRenderer
							.invoke("open-with-bandiview", selectedFile.path)
							.then((result) => {
								console.log("BandiView 실행 성공:", result.message);
							})
							.catch((error) => {
								console.error("BandiView 실행 실패:", error);
								alert(
									`BandiView로 파일을 열 수 없습니다:\n${error.message || error}`,
								);
							});
					}
					break;

				case "Delete":
					event.preventDefault();
					if (selectedRowIndex >= 0 && selectedRowIndex < fileList.length) {
						const selectedFile = fileList[selectedRowIndex];

						// Shift+Delete: 실제 파일 삭제
						if (event.shiftKey) {
							const groupedWarning = selectedFile.isGrouped
								? `\n\n⚠️ 이 파일은 그룹화된 만화${selectedFile.groupName ? ` (${selectedFile.groupName})` : ""}에 속해 있습니다. 삭제하면 해당 그룹에서도 파일이 사라집니다.`
								: "";
							const confirmDelete = confirm(
								`파일을 완전히 삭제하시겠습니까?\n\n파일명: ${selectedFile.name}\n\n이 작업은 되돌릴 수 없습니다.${groupedWarning}`,
							);

							if (confirmDelete) {
								console.log("파일 완전 삭제:", selectedFile.name);

								// 실제 파일 삭제 시도
								window.electron.ipcRenderer
									.invoke("delete-file", selectedFile.path)
									.then(() => {
										console.log(
											"파일이 성공적으로 삭제되었습니다:",
											selectedFile.name,
										);

										// 목록에서도 제거
										const newFileList = fileList.filter(
											(_, index) => index !== selectedRowIndex,
										);
										setFileList(newFileList);

										if (newFileList.length === 0) {
											setSelectedRowIndex(-1);
										} else if (selectedRowIndex >= newFileList.length) {
											setSelectedRowIndex(newFileList.length - 1);
										}
									})
									.catch((error) => {
										console.error("파일 삭제 실패:", error);
										alert(
											`파일 삭제에 실패했습니다:\n${error.message || error}`,
										);
									});
							}
						} else {
							// Delete: 목록에서만 제거
							console.log("목록에서 제거:", selectedFile.name);

							const newFileList = fileList.filter(
								(_, index) => index !== selectedRowIndex,
							);
							setFileList(newFileList);

							if (newFileList.length === 0) {
								setSelectedRowIndex(-1);
							} else if (selectedRowIndex >= newFileList.length) {
								setSelectedRowIndex(newFileList.length - 1);
							}
						}
					}
					break;
			}
		},
		[
			enabled,
			scanComplete,
			fileList,
			selectedRowIndex,
			setSelectedRowIndex,
			setFileList,
			visibleFileIndexes,
		],
	);

	useEffect(() => {
		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [handleKeyDown]);
};
