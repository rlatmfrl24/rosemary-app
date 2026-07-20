import type { FileInfo } from "../types";

interface NextSelectionAfterRemovalParams<TFile extends FileInfo> {
	currentFiles: TFile[];
	removedPath: string;
	selectedRowIndex: number;
	visibleFileIndexes?: number[];
}

const getDisplayIndexes = <TFile extends FileInfo>(
	currentFiles: TFile[],
	visibleFileIndexes?: number[],
): number[] => {
	if (visibleFileIndexes && visibleFileIndexes.length > 0) {
		return visibleFileIndexes.filter(
			(index) => index >= 0 && index < currentFiles.length,
		);
	}

	return currentFiles.map((_, index) => index);
};

export const getNextSelectedRowIndexAfterRemoval = <TFile extends FileInfo>({
	currentFiles,
	removedPath,
	selectedRowIndex,
	visibleFileIndexes,
}: NextSelectionAfterRemovalParams<TFile>): number => {
	const removedIndex = currentFiles.findIndex(
		(file) => file.path === removedPath,
	);

	if (removedIndex === -1) {
		return selectedRowIndex >= 0 && selectedRowIndex < currentFiles.length
			? selectedRowIndex
			: -1;
	}

	const nextLength = currentFiles.length - 1;
	if (nextLength === 0) {
		return -1;
	}

	const selectedFile = currentFiles[selectedRowIndex];
	if (selectedFile && selectedFile.path !== removedPath) {
		return selectedRowIndex > removedIndex
			? selectedRowIndex - 1
			: selectedRowIndex;
	}

	const displayIndexes = getDisplayIndexes(currentFiles, visibleFileIndexes);
	const removedDisplayPosition = displayIndexes.indexOf(removedIndex);
	const candidateIndex =
		removedDisplayPosition >= 0
			? (displayIndexes[removedDisplayPosition + 1] ??
				displayIndexes[removedDisplayPosition - 1])
			: undefined;

	if (candidateIndex !== undefined) {
		return candidateIndex > removedIndex ? candidateIndex - 1 : candidateIndex;
	}

	return Math.min(removedIndex, nextLength - 1);
};
