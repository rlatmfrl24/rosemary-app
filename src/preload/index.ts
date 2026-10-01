import { contextBridge, ipcRenderer } from "electron";
import type { ClipboardApi } from "../shared/clipboard";
import type { CrawlerApi, CrawlerDatabaseApi } from "../shared/crawler";
import type {
	FileOrganizerApi,
	ScanArchiveProgress,
	SimilarGroupBatchProgress,
} from "../shared/file-organizer";
import type { AppSettingsApi } from "../shared/settings";

const subscribeProgress = <T = ScanArchiveProgress>(
	channel: string,
	callback: (progress: T) => void,
): (() => void) => {
	const listener = (_event: Electron.IpcRendererEvent, progress: T): void =>
		callback(progress);
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
};

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
			await ipcRenderer.invoke("clipboard-write-text", text),
	},
	crawler: {
		start: async (options) => await ipcRenderer.invoke("crawl-start", options),
		stop: async () => await ipcRenderer.invoke("crawl-stop"),
		getStatus: async () => await ipcRenderer.invoke("crawl-status"),
		getRecentItems: async (options) =>
			await ipcRenderer.invoke("crawl-recent-items", options),
		retryFailedDownloads: async (runId) =>
			await ipcRenderer.invoke("crawl-download-retry", runId),
	},
	crawlerDb: {
		getSummary: async () => await ipcRenderer.invoke("crawl-db-summary"),
		getHitomiCatalogStatus: async () =>
			await ipcRenderer.invoke("hitomi-catalog-index-status"),
		listItems: async (options) =>
			await ipcRenderer.invoke("crawl-db-list-items", options),
		createItem: async (input) =>
			await ipcRenderer.invoke("crawl-db-create-item", input),
		updateItem: async (originalCode, input) =>
			await ipcRenderer.invoke("crawl-db-update-item", originalCode, input),
		deleteItem: async (code) =>
			await ipcRenderer.invoke("crawl-db-delete-item", code),
		resetDatabase: async () => await ipcRenderer.invoke("crawl-db-reset"),
		listTagPreferences: async () =>
			await ipcRenderer.invoke("tag-preferences-list"),
		upsertTagPreference: async (input) =>
			await ipcRenderer.invoke("tag-preferences-upsert", input),
		deleteTagPreference: async (input) =>
			await ipcRenderer.invoke("tag-preferences-delete", input),
		startArchiveMetadataRecovery: async () =>
			await ipcRenderer.invoke("archive-metadata-recovery-start"),
		enqueueArchiveMetadataRecoveryFiles: async (filePaths) =>
			await ipcRenderer.invoke(
				"archive-metadata-recovery-enqueue-files",
				filePaths,
			),
		getArchiveMetadataRecoveryEntries: async (galleryIds) =>
			await ipcRenderer.invoke("archive-metadata-recovery-entries", galleryIds),
		pauseArchiveMetadataRecovery: async () =>
			await ipcRenderer.invoke("archive-metadata-recovery-pause"),
		resumeArchiveMetadataRecovery: async () =>
			await ipcRenderer.invoke("archive-metadata-recovery-resume"),
		getArchiveMetadataRecoveryStatus: async () =>
			await ipcRenderer.invoke("archive-metadata-recovery-status"),
		listArchiveMetadataRecoveryFailures: async (limit) =>
			await ipcRenderer.invoke("archive-metadata-recovery-failures", limit),
		retryArchiveMetadataRecoveryUnresolved: async () =>
			await ipcRenderer.invoke("archive-metadata-recovery-retry"),
	},
	fileOrganizer: {
		scan: async (sourcePath) =>
			await ipcRenderer.invoke("scan-files", sourcePath),
		checkDuplicates: async (files, scanPath) =>
			await ipcRenderer.invoke("check-duplicate-files", files, scanPath),
		getThumbnail: async (filePath) =>
			await ipcRenderer.invoke("get-file-thumbnail", filePath),
		copyFile: async (filePath, targetPath) =>
			await ipcRenderer.invoke("copy-file", filePath, targetPath),
		moveFile: async (filePath, targetPath) =>
			await ipcRenderer.invoke("move-file", filePath, targetPath),
		keepFile: async (filePath) =>
			await ipcRenderer.invoke("keep-file", filePath),
		deleteFile: async (filePath) =>
			await ipcRenderer.invoke("delete-file", filePath),
		openFile: async (filePath) =>
			await ipcRenderer.invoke("open-with-bandiview", filePath),
		onScanProgress: (callback) =>
			subscribeProgress("scan-files-progress", callback),
		archiveFiles: async (files, scanPath, decisions, groupTargets) =>
			await ipcRenderer.invoke(
				"move-all-files-to-store",
				files,
				scanPath,
				decisions,
				groupTargets,
			),
		randomReview: async (options) =>
			await ipcRenderer.invoke("random-review-files", options),
		findSimilarGroups: async (options) =>
			await ipcRenderer.invoke("find-similar-groups", options),
		previewSimilarGroupBatch: async (request) =>
			ipcRenderer.invoke("preview-similar-group-batch", request),
		executeSimilarGroupBatch: async (planId, itemIds) =>
			ipcRenderer.invoke("execute-similar-group-batch", planId, itemIds),
		cancelSimilarGroupBatch: async (planId) =>
			ipcRenderer.invoke("cancel-similar-group-batch", planId),
		onSimilarGroupBatchProgress: (callback) =>
			subscribeProgress<SimilarGroupBatchProgress>(
				"similar-group-batch-progress",
				callback,
			),
		trashFiles: async (filePaths) =>
			await ipcRenderer.invoke("trash-files", filePaths),
		moveGroupToFolder: async (
			sourcePath,
			filePaths,
			groupName,
			folderSegments,
		) =>
			await ipcRenderer.invoke(
				"move-group-to-folder",
				sourcePath,
				filePaths,
				groupName,
				folderSegments,
			),
		mergeFilesToGroup: async (sourcePath, filePaths, targetGroupPath) =>
			await ipcRenderer.invoke(
				"merge-files-to-group",
				sourcePath,
				filePaths,
				targetGroupPath,
			),
		findGroupMergeCandidates: async (files, scanPath) =>
			await ipcRenderer.invoke("find-group-merge-candidates", files, scanPath),
		findFavoriteArtistCandidates: async (files) =>
			await ipcRenderer.invoke("find-favorite-artist-candidates", files),
		moveFileToFavoriteArtist: async (filePath, artistFolderName) =>
			await ipcRenderer.invoke(
				"move-file-to-favorite-artist",
				filePath,
				artistFolderName,
			),
		markSimilarGroupReviewState: async (input) =>
			await ipcRenderer.invoke("mark-similar-group-review-state", input),
		clearSimilarGroupReviewState: async (reviewKey, contentSignature) =>
			await ipcRenderer.invoke(
				"clear-similar-group-review-state",
				reviewKey,
				contentSignature,
			),
		previewGroupedFolderMigration: async (sourcePath) =>
			await ipcRenderer.invoke("preview-grouped-folder-migration", sourcePath),
		executeGroupedFolderMigration: async (sourcePath) =>
			await ipcRenderer.invoke("execute-grouped-folder-migration", sourcePath),
		onRandomReviewProgress: (callback) =>
			subscribeProgress("random-review-files-progress", callback),
		onSimilarGroupsProgress: (callback) =>
			subscribeProgress("find-similar-groups-progress", callback),
	},
	settings: {
		get: async () => await ipcRenderer.invoke("get-settings"),
		save: async (settings) =>
			await ipcRenderer.invoke("save-settings", settings),
		selectExecutable: async (title) =>
			await ipcRenderer.invoke("select-file-path", title, [
				{ name: "실행 파일", extensions: ["exe"] },
				{ name: "모든 파일", extensions: ["*"] },
			]),
		selectDirectory: async () => await ipcRenderer.invoke("get-target-path"),
		launchHitomiDownloader: async () =>
			await ipcRenderer.invoke("launch-hitomi-downloader"),
		installHitomiApiExtension: async () =>
			await ipcRenderer.invoke("hitomi-api-install"),
		getHitomiApiStatus: async () =>
			await ipcRenderer.invoke("hitomi-api-status"),
		prepareHitomiApiConnection: async () =>
			await ipcRenderer.invoke("hitomi-api-prepare"),
		sendHitomiApiCodes: async (codes) =>
			await ipcRenderer.invoke("hitomi-api-send-codes", codes),
	},
};

contextBridge.exposeInMainWorld("api", api);
