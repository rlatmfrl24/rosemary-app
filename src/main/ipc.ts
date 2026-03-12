import { ipcMain } from "electron";
import type { AppSettings } from "../shared/settings";
import type { CrawlerService } from "./crawler";
import { selectDirectoryPath, selectFilePath } from "./dialogs";
import {
	checkDuplicateFiles,
	copyFileToPath,
	deleteFile,
	type FileEntry,
	keepFileCopy,
	moveAllFilesToStore,
	moveFileToPath,
	scanArchiveFiles,
} from "./files";
import { ensurePathExists, launchDetachedProcess } from "./process-utils";
import { loadSettings, saveSettings } from "./settings";

const getConfiguredPath = (value: string, errorMessage: string): string => {
	const normalizedValue = value.trim();
	if (!normalizedValue) {
		throw new Error(errorMessage);
	}

	return normalizedValue;
};

const getSettings = async (): Promise<AppSettings> => {
	return await loadSettings();
};

export const registerIpcHandlers = (crawlerService: CrawlerService): void => {
	ipcMain.on("ping", () => console.log("pong"));

	ipcMain.handle("get-target-path", async () => {
		return await selectDirectoryPath();
	});

	ipcMain.handle("get-settings", async () => {
		return await getSettings();
	});

	ipcMain.handle("save-settings", async (_, settings: AppSettings) => {
		return await saveSettings(settings);
	});

	ipcMain.handle("launch-hitomi-downloader", async () => {
		const settings = await getSettings();
		const executablePath = getConfiguredPath(
			settings.hitomiDownloaderPath,
			"Hitomi Downloader 실행 파일 경로가 설정되지 않았습니다. 설정에서 먼저 지정해주세요.",
		);

		await ensurePathExists(
			executablePath,
			"Hitomi Downloader 실행 파일을 찾을 수 없습니다. 설정 경로를 확인해주세요.",
		);

		launchDetachedProcess(executablePath);

		return {
			success: true,
			message: "Hitomi Downloader를 실행했습니다.",
			path: executablePath,
		};
	});

	ipcMain.handle("crawl-start", (_, options) => {
		return crawlerService.start(options);
	});

	ipcMain.handle("crawl-stop", async () => {
		return await crawlerService.stop();
	});

	ipcMain.handle("crawl-status", () => {
		return crawlerService.getStatus();
	});

	ipcMain.handle("crawl-recent-items", (_, options) => {
		return crawlerService.getRecentItems(options);
	});

	ipcMain.handle("crawl-db-summary", () => {
		return crawlerService.getDatabaseSummary();
	});

	ipcMain.handle("crawl-db-list-items", (_, options) => {
		return crawlerService.listItems(options);
	});

	ipcMain.handle("crawl-db-create-item", (_, input) => {
		return crawlerService.createItem(input);
	});

	ipcMain.handle("crawl-db-update-item", (_, originalCode, input) => {
		return crawlerService.updateItem(originalCode, input);
	});

	ipcMain.handle("crawl-db-delete-item", (_, code: string) => {
		return crawlerService.deleteItem(code);
	});

	ipcMain.handle("crawl-db-reset", () => {
		return crawlerService.resetDatabase();
	});

	ipcMain.handle(
		"select-file-path",
		async (
			_,
			title: string,
			filters?: { name: string; extensions: string[] }[],
		) => {
			return await selectFilePath(title, filters);
		},
	);

	ipcMain.handle("scan-files", async (_, targetPath: string) => {
		return await scanArchiveFiles(targetPath);
	});

	ipcMain.handle("delete-file", async (_, filePath: string) => {
		return await deleteFile(filePath);
	});

	ipcMain.handle("open-with-bandiview", async (_, filePath: string) => {
		const settings = await getSettings();
		const executablePath = getConfiguredPath(
			settings.bandiViewPath,
			"BandiView 실행 파일 경로가 설정되지 않았습니다. 설정에서 먼저 지정해주세요.",
		);

		await ensurePathExists(filePath, "파일이 존재하지 않습니다.");
		await ensurePathExists(
			executablePath,
			"BandiView가 설치되어 있지 않거나 경로를 찾을 수 없습니다.",
		);

		launchDetachedProcess(executablePath, [filePath]);

		return { success: true, message: "BandiView로 파일을 열었습니다." };
	});

	ipcMain.handle(
		"check-duplicate-files",
		async (_, fileList: FileEntry[], scanPath: string) => {
			const settings = await getSettings();
			return await checkDuplicateFiles(fileList, scanPath, settings.storePath);
		},
	);

	ipcMain.handle(
		"move-all-files-to-store",
		async (
			_,
			fileList: FileEntry[],
			scanPath: string,
			duplicateActions: Record<string, "overwrite" | "skip"> = {},
		) => {
			const settings = await getSettings();
			return await moveAllFilesToStore(
				fileList,
				scanPath,
				settings.storePath,
				duplicateActions,
			);
		},
	);

	ipcMain.handle(
		"copy-file",
		async (_, filePath: string, targetPath: string) => {
			return await copyFileToPath(filePath, targetPath);
		},
	);

	ipcMain.handle(
		"move-file",
		async (_, filePath: string, targetPath: string) => {
			return await moveFileToPath(filePath, targetPath);
		},
	);

	ipcMain.handle("keep-file", async (_, filePath: string) => {
		const settings = await getSettings();
		return await keepFileCopy(filePath, settings.keepPath);
	});
};
