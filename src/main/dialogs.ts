import { dialog } from "electron";

interface DialogFilter {
	name: string;
	extensions: string[];
}

const DEFAULT_EXECUTABLE_FILTERS: DialogFilter[] = [
	{ name: "실행 파일", extensions: ["exe"] },
	{ name: "모든 파일", extensions: ["*"] },
];

export const selectDirectoryPath = async (): Promise<string | null> => {
	const result = await dialog.showOpenDialog({
		properties: ["openDirectory", "createDirectory"],
	});

	if (result.canceled) {
		return null;
	}

	return result.filePaths[0];
};

export const selectFilePath = async (
	title: string,
	filters: DialogFilter[] = DEFAULT_EXECUTABLE_FILTERS,
): Promise<string | null> => {
	const result = await dialog.showOpenDialog({
		title,
		properties: ["openFile"],
		filters,
	});

	if (result.canceled) {
		return null;
	}

	return result.filePaths[0];
};
