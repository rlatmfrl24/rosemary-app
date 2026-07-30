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
		retryFailedDownloads: async (runId) =>
			await electronAPI.ipcRenderer.invoke("crawl-download-retry", runId),
	},
	crawlerDb: {
		getSummary: async () =>
			await electronAPI.ipcRenderer.invoke("crawl-db-summary"),
		getHitomiCatalogStatus: async () =>
			await electronAPI.ipcRenderer.invoke("hitomi-catalog-index-status"),
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
		startArchiveMetadataRecovery: async () =>
			await electronAPI.ipcRenderer.invoke("archive-metadata-recovery-start"),
		enqueueArchiveMetadataRecoveryFiles: async (filePaths) =>
			await electronAPI.ipcRenderer.invoke(
				"archive-metadata-recovery-enqueue-files",
				filePaths,
			),
		getArchiveMetadataRecoveryEntries: async (galleryIds) =>
			await electronAPI.ipcRenderer.invoke(
				"archive-metadata-recovery-entries",
				galleryIds,
			),
		pauseArchiveMetadataRecovery: async () =>
			await electronAPI.ipcRenderer.invoke("archive-metadata-recovery-pause"),
		resumeArchiveMetadataRecovery: async () =>
			await electronAPI.ipcRenderer.invoke("archive-metadata-recovery-resume"),
		getArchiveMetadataRecoveryStatus: async () =>
			await electronAPI.ipcRenderer.invoke("archive-metadata-recovery-status"),
		listArchiveMetadataRecoveryFailures: async (limit) =>
			await electronAPI.ipcRenderer.invoke(
				"archive-metadata-recovery-failures",
				limit,
			),
		retryArchiveMetadataRecoveryUnresolved: async () =>
			await electronAPI.ipcRenderer.invoke("archive-metadata-recovery-retry"),
	},
	fileOrganizer: {
		randomReview: async (options) =>
			await electronAPI.ipcRenderer.invoke("random-review-files", options),
		findSimilarGroups: async (options) =>
			await electronAPI.ipcRenderer.invoke("find-similar-groups", options),
		trashFiles: async (filePaths) =>
			await electronAPI.ipcRenderer.invoke("trash-files", filePaths),
		moveGroupToFolder: async (
			sourcePath,
			filePaths,
			groupName,
			folderSegments,
		) =>
			await electronAPI.ipcRenderer.invoke(
				"move-group-to-folder",
				sourcePath,
				filePaths,
				groupName,
				folderSegments,
			),
		mergeFilesToGroup: async (sourcePath, filePaths, targetGroupPath) =>
			await electronAPI.ipcRenderer.invoke(
				"merge-files-to-group",
				sourcePath,
				filePaths,
				targetGroupPath,
			),
		findGroupMergeCandidates: async (files, scanPath) =>
			await electronAPI.ipcRenderer.invoke(
				"find-group-merge-candidates",
				files,
				scanPath,
			),
		findFavoriteArtistCandidates: async (files) =>
			await electronAPI.ipcRenderer.invoke(
				"find-favorite-artist-candidates",
				files,
			),
		moveFileToFavoriteArtist: async (filePath, artistFolderName) =>
			await electronAPI.ipcRenderer.invoke(
				"move-file-to-favorite-artist",
				filePath,
				artistFolderName,
			),
		markSimilarGroupReviewState: async (input) =>
			await electronAPI.ipcRenderer.invoke(
				"mark-similar-group-review-state",
				input,
			),
		clearSimilarGroupReviewState: async (reviewKey, contentSignature) =>
			await electronAPI.ipcRenderer.invoke(
				"clear-similar-group-review-state",
				reviewKey,
				contentSignature,
			),
		previewGroupedFolderMigration: async (sourcePath) =>
			await electronAPI.ipcRenderer.invoke(
				"preview-grouped-folder-migration",
				sourcePath,
			),
		executeGroupedFolderMigration: async (sourcePath) =>
			await electronAPI.ipcRenderer.invoke(
				"execute-grouped-folder-migration",
				sourcePath,
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
		installHitomiApiExtension: async () =>
			await electronAPI.ipcRenderer.invoke("hitomi-api-install"),
		getHitomiApiStatus: async () =>
			await electronAPI.ipcRenderer.invoke("hitomi-api-status"),
		prepareHitomiApiConnection: async () =>
			await electronAPI.ipcRenderer.invoke("hitomi-api-prepare"),
		sendHitomiApiCodes: async (codes) =>
			await electronAPI.ipcRenderer.invoke("hitomi-api-send-codes", codes),
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
