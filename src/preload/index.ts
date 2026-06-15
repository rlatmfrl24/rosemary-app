import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge } from "electron";
import type { ClipboardApi } from "../shared/clipboard";
import type { CrawlerApi, CrawlerDatabaseApi } from "../shared/crawler";
import type { FileOrganizerApi } from "../shared/file-organizer";
import type { AppSettingsApi } from "../shared/settings";

// Custom APIs for renderer
const api: {
	clipboard: ClipboardApi;
	crawler: CrawlerApi;
	crawlerDb: CrawlerDatabaseApi;
	fileOrganizer: FileOrganizerApi;
	settings: AppSettingsApi;
} = {
	clipboard: {
		writeText: async (text) =>
			await electronAPI.ipcRenderer.invoke("clipboard-write-text", text),
	},
	crawler: {
		start: async (options) =>
			await electronAPI.ipcRenderer.invoke("crawl-start", options),
		stop: async () => await electronAPI.ipcRenderer.invoke("crawl-stop"),
		getStatus: async () => await electronAPI.ipcRenderer.invoke("crawl-status"),
		getRecentItems: async (options) =>
			await electronAPI.ipcRenderer.invoke("crawl-recent-items", options),
	},
	crawlerDb: {
		getSummary: async () =>
			await electronAPI.ipcRenderer.invoke("crawl-db-summary"),
		listItems: async (options) =>
			await electronAPI.ipcRenderer.invoke("crawl-db-list-items", options),
		createItem: async (input) =>
			await electronAPI.ipcRenderer.invoke("crawl-db-create-item", input),
		updateItem: async (originalCode, input) =>
			await electronAPI.ipcRenderer.invoke(
				"crawl-db-update-item",
				originalCode,
				input,
			),
		deleteItem: async (code) =>
			await electronAPI.ipcRenderer.invoke("crawl-db-delete-item", code),
		resetDatabase: async () =>
			await electronAPI.ipcRenderer.invoke("crawl-db-reset"),
	},
	fileOrganizer: {
		randomReview: async (options) =>
			await electronAPI.ipcRenderer.invoke("random-review-files", options),
		findSimilarGroups: async (options) =>
			await electronAPI.ipcRenderer.invoke("find-similar-groups", options),
		trashFiles: async (filePaths) =>
			await electronAPI.ipcRenderer.invoke("trash-files", filePaths),
		moveGroupToFolder: async (sourcePath, filePaths, groupName) =>
			await electronAPI.ipcRenderer.invoke(
				"move-group-to-folder",
				sourcePath,
				filePaths,
				groupName,
			),
		findGroupMergeCandidates: async (files, scanPath) =>
			await electronAPI.ipcRenderer.invoke(
				"find-group-merge-candidates",
				files,
				scanPath,
			),
		onRandomReviewProgress: (callback) =>
			electronAPI.ipcRenderer.on(
				"random-review-files-progress",
				(_, progress) => {
					callback(progress);
				},
			),
		onSimilarGroupsProgress: (callback) =>
			electronAPI.ipcRenderer.on(
				"find-similar-groups-progress",
				(_, progress) => {
					callback(progress);
				},
			),
	},
	settings: {
		get: async () => await electronAPI.ipcRenderer.invoke("get-settings"),
		save: async (settings) =>
			await electronAPI.ipcRenderer.invoke("save-settings", settings),
		selectExecutable: async (title) =>
			await electronAPI.ipcRenderer.invoke("select-file-path", title, [
				{ name: "실행 파일", extensions: ["exe"] },
				{ name: "모든 파일", extensions: ["*"] },
			]),
		selectDirectory: async () =>
			await electronAPI.ipcRenderer.invoke("get-target-path"),
		launchHitomiDownloader: async () =>
			await electronAPI.ipcRenderer.invoke("launch-hitomi-downloader"),
	},
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
	try {
		contextBridge.exposeInMainWorld("electron", electronAPI);
		contextBridge.exposeInMainWorld("api", api);
	} catch (error) {
		console.error(error);
	}
} else {
	// @ts-ignore (define in dts)
	window.electron = electronAPI;
	// @ts-ignore (define in dts)
	window.api = api;
}
