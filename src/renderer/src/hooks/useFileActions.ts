import { type Dispatch, type SetStateAction, useCallback } from "react";
import type { FileInfo } from "../types";

interface UseFileActionsProps {
	fileList: FileInfo[];
	selectedRowIndex: number;
	setFileList: Dispatch<SetStateAction<FileInfo[]>>;
	setSelectedRowIndex: Dispatch<SetStateAction<number>>;
}

interface FileActions {
	handleCopyFile: (file: FileInfo) => Promise<void>;
	handleMoveFile: (file: FileInfo) => Promise<void>;
	handleKeepFile: (file: FileInfo) => Promise<void>;
}

export const useFileActions = ({
	fileList,
	selectedRowIndex,
	setFileList,
	setSelectedRowIndex,
}: UseFileActionsProps): FileActions => {
	const handleCopyFile = useCallback(async (file: FileInfo): Promise<void> => {
		try {
			const targetPath =
				await window.electron.ipcRenderer.invoke("get-target-path");
			if (!targetPath) return;

			const finalTargetPath = `${targetPath}/${file.name}`;
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

	const handleMoveFile = useCallback(
		async (file: FileInfo): Promise<void> => {
			try {
				const confirmMove = confirm(
					`파일을 이동하시겠습니까?\n파일: ${file.name}\n\n이동하면 원본 파일이 삭제됩니다.`,
				);
				if (!confirmMove) return;

				const targetPath =
					await window.electron.ipcRenderer.invoke("get-target-path");
				if (!targetPath) return;

				const finalTargetPath = `${targetPath}/${file.name}`;
				const result = await window.electron.ipcRenderer.invoke(
					"move-file",
					file.path,
					finalTargetPath,
				);

				if (result.success) {
					alert(
						`파일이 성공적으로 이동되었습니다.\n대상 경로: ${result.targetPath}`,
					);

					const newFileList = fileList.filter((f) => f.path !== file.path);
					setFileList(newFileList);

					if (newFileList.length === 0) {
						setSelectedRowIndex(-1);
					} else if (selectedRowIndex >= newFileList.length) {
						setSelectedRowIndex(newFileList.length - 1);
					}
				}
			} catch (error) {
				console.error("파일 이동 중 오류 발생:", error);
				alert(
					`파일 이동 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			}
		},
		[fileList, selectedRowIndex, setFileList, setSelectedRowIndex],
	);

	const handleKeepFile = useCallback(async (file: FileInfo): Promise<void> => {
		try {
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

	return {
		handleCopyFile,
		handleMoveFile,
		handleKeepFile,
	};
};
