import { type Dispatch, type SetStateAction, useCallback } from "react";
import type { FavoriteArtistCandidate } from "../../../shared/file-organizer";
import type { FileInfo } from "../types";
import { getNextSelectedRowIndexAfterRemoval } from "../utils/selection";

interface FavoriteArtistActionFile extends FileInfo {
	favoriteArtistCandidate?: FavoriteArtistCandidate;
}

interface UseFileActionsProps<
	TFile extends FavoriteArtistActionFile = FavoriteArtistActionFile,
> {
	fileList: TFile[];
	selectedRowIndex: number;
	setFileList: Dispatch<SetStateAction<TFile[]>>;
	setSelectedRowIndex: Dispatch<SetStateAction<number>>;
	visibleFileIndexes?: number[];
}

interface FileActions<
	TFile extends FavoriteArtistActionFile = FavoriteArtistActionFile,
> {
	handleCopyFile: (file: TFile) => Promise<void>;
	handleMoveFile: (file: TFile) => Promise<void>;
	handleKeepFile: (file: TFile) => Promise<void>;
	handleMoveToFavoriteArtist: (file: TFile) => Promise<void>;
}

export const useFileActions = <
	TFile extends FavoriteArtistActionFile = FavoriteArtistActionFile,
>({
	fileList,
	selectedRowIndex,
	setFileList,
	setSelectedRowIndex,
	visibleFileIndexes,
}: UseFileActionsProps<TFile>): FileActions<TFile> => {
	const removeFileFromList = useCallback(
		(file: TFile): void => {
			const nextSelectedRowIndex = getNextSelectedRowIndexAfterRemoval({
				currentFiles: fileList,
				removedPath: file.path,
				selectedRowIndex,
				visibleFileIndexes,
			});

			setFileList((currentFiles) =>
				currentFiles.filter((currentFile) => currentFile.path !== file.path),
			);
			setSelectedRowIndex(nextSelectedRowIndex);
		},
		[
			fileList,
			selectedRowIndex,
			setFileList,
			setSelectedRowIndex,
			visibleFileIndexes,
		],
	);

	const getFavoriteArtistWarning = useCallback(
		(file: TFile, targetLabel: string): string => {
			const candidate = file.favoriteArtistCandidate;
			if (!candidate) {
				return "";
			}

			return (
				"\n\n주의: 이 파일은 Favorite Artist 작가 폴더와 일치합니다.\n" +
				`작가 폴더: ${candidate.relativeTargetDirectory}\n` +
				"'작가' 버튼을 사용하면 해당 작가 폴더로 이동할 수 있습니다.\n" +
				`그래도 ${targetLabel}로 이동하시겠습니까?`
			);
		},
		[],
	);

	const handleCopyFile = useCallback(async (file: TFile): Promise<void> => {
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
		async (file: TFile): Promise<void> => {
			try {
				const confirmMove = confirm(
					`파일을 저장소 루트로 이동하시겠습니까?\n파일: ${file.name}\n\n일반 전체 보관처럼 상대 경로를 유지하지 않고 저장소 폴더 바로 아래로 이동합니다.${getFavoriteArtistWarning(file, "저장소")}`,
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

					removeFileFromList(file);
				}
			} catch (error) {
				console.error("파일 이동 중 오류 발생:", error);
				alert(
					`파일 이동 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			}
		},
		[getFavoriteArtistWarning, removeFileFromList],
	);

	const handleKeepFile = useCallback(
		async (file: TFile): Promise<void> => {
			try {
				const confirmFavoriteMove = confirm(
					`파일을 Favorite 폴더로 이동하시겠습니까?\n파일: ${file.name}\n\n이동하면 원본 파일은 현재 위치에서 제거됩니다.${getFavoriteArtistWarning(file, "Favorite")}`,
				);
				if (!confirmFavoriteMove) return;

				const result = await window.electron.ipcRenderer.invoke(
					"keep-file",
					file.path,
				);

				if (result.success) {
					alert(
						`파일이 Favorite 폴더로 이동되었습니다.\nFavorite 경로: ${result.targetPath}`,
					);

					removeFileFromList(file);
				}
			} catch (error) {
				console.error("Favorite 이동 중 오류 발생:", error);
				alert(
					`Favorite 이동 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			}
		},
		[getFavoriteArtistWarning, removeFileFromList],
	);

	const handleMoveToFavoriteArtist = useCallback(
		async (file: TFile): Promise<void> => {
			const candidate = file.favoriteArtistCandidate;
			if (!candidate) {
				alert("이 파일과 매칭된 Favorite Artist 작가 폴더가 없습니다.");
				return;
			}

			try {
				const confirmFavoriteArtistMove = confirm(
					`파일을 Favorite Artist 작가 폴더로 이동하시겠습니까?\n파일: ${file.name}\n대상: ${candidate.relativeTargetDirectory}\n\n이동하면 원본 파일은 현재 위치에서 제거됩니다.`,
				);
				if (!confirmFavoriteArtistMove) return;

				const result = await window.api.fileOrganizer.moveFileToFavoriteArtist(
					file.path,
					candidate.artistFolderName,
				);

				if (result.success) {
					alert(
						`파일이 Favorite Artist 작가 폴더로 이동되었습니다.\n대상 경로: ${result.targetPath}`,
					);

					removeFileFromList(file);
				}
			} catch (error) {
				console.error("Favorite Artist 이동 중 오류 발생:", error);
				alert(
					`Favorite Artist 이동 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			}
		},
		[removeFileFromList],
	);

	return {
		handleCopyFile,
		handleMoveFile,
		handleKeepFile,
		handleMoveToFavoriteArtist,
	};
};
