import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge } from "electron";
import type { CrawlerApi, CrawlerDatabaseApi } from "../shared/crawler";
import type { AppSettingsApi } from "../shared/settings";

// Custom APIs for renderer
const api: {
	crawler: CrawlerApi;
	crawlerDb: CrawlerDatabaseApi;
	settings: AppSettingsApi;
} = {
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
