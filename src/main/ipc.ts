import { clipboard, ipcMain } from "electron";
import { parseArchiveFileName } from "../shared/archive-name";
import type { ArchiveGalleryRecoveryEntry } from "../shared/crawler";
import type {
	GroupMergeSourceFile,
	RandomReviewOptions,
	SimilarGroupFolderSegments,
	SimilarGroupOptions,
	SimilarGroupReviewStateInput,
} from "../shared/file-organizer";
import type { GallerySourceMetadata } from "../shared/gallery-metadata";
import type { AppSettings } from "../shared/settings";
import type { CrawlerService } from "./crawler";
import { selectDirectoryPath, selectFilePath } from "./dialogs";
import {
	checkDuplicateFiles,
	clearSimilarGroupReviewState,
	copyFileToPath,
	deleteFile,
	executeGroupedFolderMigration,
	type FileEntry,
	findFavoriteArtistCandidates,
	findGroupMergeCandidates,
	findSimilarGroups,
	markSimilarGroupReviewState,
	mergeFilesToExistingGroup,
	moveAllFilesToStore,
	moveFileToFavorite,
	moveFileToFavoriteArtist,
	moveFileToPath,
	moveGroupFilesToFolder,
	previewGroupedFolderMigration,
	scanArchiveFiles,
	scanRandomReviewFiles,
	trashFilesToRecycleBin,
} from "./files";
import {
	diagnoseHitomiApiConnection,
	installHitomiApiExtension,
	prepareHitomiApiConnection,
	sendCodesToHitomiApi,
} from "./hitomi-api";
import {
	ensurePathExists,
	isProcessRunningByExecutablePath,
	launchDetachedProcess,
	waitForProcessByExecutablePath,
} from "./process-utils";
import { loadSettings, saveSettings } from "./settings";
import { createFileThumbnail } from "./thumbnails";

const HITOMI_DOWNLOADER_LAUNCH_WAIT_MS = 10000;

const attachSourceMetadata = <TFile extends { name: string }>(
	files: TFile[],
	crawlerService: CrawlerService,
): Array<
	TFile & {
		sourceMetadata?: GallerySourceMetadata;
		archiveRecovery?: ArchiveGalleryRecoveryEntry;
	}
> => {
	const galleryIds = files
		.map((file) => parseArchiveFileName(file.name).code)
		.filter((galleryId): galleryId is string => galleryId !== undefined);
	const metadataByGalleryId =
		crawlerService.getMetadataByGalleryIds(galleryIds);
	const recoveryByGalleryId =
		crawlerService.getArchiveMetadataRecoveryEntries(galleryIds);

	return files.map((file) => {
		const galleryId = parseArchiveFileName(file.name).code;
		return {
			...file,
			sourceMetadata: galleryId ? metadataByGalleryId[galleryId] : undefined,
			archiveRecovery: galleryId ? recoveryByGalleryId[galleryId] : undefined,
		};
	});
};

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

	ipcMain.handle("clipboard-write-text", (_, text: string) => {
		if (typeof text !== "string") {
			throw new Error("복사할 텍스트가 올바르지 않습니다.");
		}

		clipboard.writeText(text);
		return true;
	});

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

		const wasRunning = await isProcessRunningByExecutablePath(executablePath);
		if (!wasRunning) {
			launchDetachedProcess(executablePath);
		}

		const running =
			wasRunning ||
			(await waitForProcessByExecutablePath(
				executablePath,
				HITOMI_DOWNLOADER_LAUNCH_WAIT_MS,
			));

		if (!running) {
			throw new Error(
				"Hitomi Downloader 실행을 요청했지만 실행 중인 프로세스를 확인하지 못했습니다.",
			);
		}

		return {
			success: true,
			message: wasRunning
				? "Hitomi Downloader가 이미 실행 중입니다."
				: "Hitomi Downloader를 실행하고 실행 여부를 확인했습니다.",
			path: executablePath,
			launched: !wasRunning,
			running,
		};
	});

	ipcMain.handle("hitomi-api-install", async () => {
		const settings = await getSettings();
		return await installHitomiApiExtension(settings);
	});

	ipcMain.handle("hitomi-api-status", async () => {
		const settings = await getSettings();
		return await diagnoseHitomiApiConnection(settings);
	});

	ipcMain.handle("hitomi-api-prepare", async () => {
		const settings = await getSettings();
		return await prepareHitomiApiConnection(settings);
	});

	ipcMain.handle("hitomi-api-send-codes", async (_, codes: string[]) => {
		if (
			!Array.isArray(codes) ||
			codes.some((code) => typeof code !== "string")
		) {
			throw new Error("Hitomi API로 전송할 코드 목록이 올바르지 않습니다.");
		}

		const settings = await getSettings();
		return await sendCodesToHitomiApi(codes, settings);
	});

	ipcMain.handle("crawl-start", async (_, options) => {
		const settings = await getSettings();
		const hitomiReady = await prepareHitomiApiConnection(settings);
		if (
			!hitomiReady.success ||
			!hitomiReady.running ||
			!hitomiReady.apiConnected
		) {
			throw new Error(
				`Hitomi Downloader 실행 상태와 API 연결을 확인한 뒤 크롤링을 시작할 수 있습니다. ${hitomiReady.message}`,
			);
		}
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

	ipcMain.handle("crawl-download-retry", (_, runId?: number) => {
		return crawlerService.retryFailedDownloads(runId);
	});

	ipcMain.handle("crawl-db-summary", () => {
		return crawlerService.getDatabaseSummary();
	});

	ipcMain.handle("hitomi-catalog-index-status", () => {
		return crawlerService.getHitomiCatalogStatus();
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

	ipcMain.handle("archive-metadata-recovery-start", () => {
		return crawlerService.startArchiveMetadataRecovery();
	});

	ipcMain.handle(
		"archive-metadata-recovery-enqueue-files",
		(_, filePaths: string[]) => {
			return crawlerService.enqueueArchiveMetadataRecoveryFiles(filePaths);
		},
	);

	ipcMain.handle(
		"archive-metadata-recovery-entries",
		(_, galleryIds: string[]) => {
			return crawlerService.getArchiveMetadataRecoveryEntries(galleryIds);
		},
	);

	ipcMain.handle("archive-metadata-recovery-pause", () => {
		return crawlerService.pauseArchiveMetadataRecovery();
	});

	ipcMain.handle("archive-metadata-recovery-resume", () => {
		return crawlerService.resumeArchiveMetadataRecovery();
	});

	ipcMain.handle("archive-metadata-recovery-status", () => {
		return crawlerService.getArchiveMetadataRecoveryStatus();
	});

	ipcMain.handle("archive-metadata-recovery-failures", (_, limit?: number) => {
		return crawlerService.listArchiveMetadataRecoveryFailures(limit);
	});

	ipcMain.handle("archive-metadata-recovery-retry", () => {
		return crawlerService.retryArchiveMetadataRecoveryUnresolved();
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

	ipcMain.handle("scan-files", async (event, targetPath: string) => {
		const result = await scanArchiveFiles(targetPath, (progress) => {
			event.sender.send("scan-files-progress", progress);
		});
		return {
			...result,
			files: attachSourceMetadata(result.files, crawlerService),
		};
	});

	ipcMain.handle(
		"random-review-files",
		async (event, options: RandomReviewOptions) => {
			const result = await scanRandomReviewFiles(options, (progress) => {
				event.sender.send("random-review-files-progress", progress);
			});
			return {
				...result,
				files: attachSourceMetadata(result.files, crawlerService),
			};
		},
	);

	ipcMain.handle(
		"find-similar-groups",
		async (event, options: SimilarGroupOptions) => {
			return await findSimilarGroups(
				options,
				(progress) => {
					event.sender.send("find-similar-groups-progress", progress);
				},
				(galleryIds) => crawlerService.getMetadataByGalleryIds(galleryIds),
			);
		},
	);

	ipcMain.handle(
		"find-group-merge-candidates",
		async (_, fileList: GroupMergeSourceFile[], scanPath: string) => {
			const settings = await getSettings();
			return await findGroupMergeCandidates(
				fileList,
				scanPath,
				settings.storePath,
				(galleryIds) => crawlerService.getMetadataByGalleryIds(galleryIds),
			);
		},
	);

	ipcMain.handle(
		"find-favorite-artist-candidates",
		async (_, fileList: GroupMergeSourceFile[]) => {
			const settings = await getSettings();
			return await findFavoriteArtistCandidates(
				fileList,
				settings.favoriteArtistPath,
				(galleryIds) => crawlerService.getMetadataByGalleryIds(galleryIds),
			);
		},
	);

	ipcMain.handle("trash-files", async (_, filePaths: string[]) => {
		return await trashFilesToRecycleBin(filePaths);
	});

	ipcMain.handle(
		"move-group-to-folder",
		async (
			_,
			sourcePath: string,
			filePaths: string[],
			groupName: string,
			folderSegments?: SimilarGroupFolderSegments,
		) => {
			return await moveGroupFilesToFolder(
				sourcePath,
				filePaths,
				groupName,
				folderSegments,
			);
		},
	);

	ipcMain.handle(
		"merge-files-to-group",
		async (
			_,
			sourcePath: string,
			filePaths: string[],
			targetGroupPath: string,
		) => {
			return await mergeFilesToExistingGroup(
				sourcePath,
				filePaths,
				targetGroupPath,
			);
		},
	);

	ipcMain.handle(
		"mark-similar-group-review-state",
		async (_, input: SimilarGroupReviewStateInput) => {
			return await markSimilarGroupReviewState(input);
		},
	);

	ipcMain.handle(
		"clear-similar-group-review-state",
		async (_, reviewKey: string, contentSignature?: string) => {
			return await clearSimilarGroupReviewState(reviewKey, contentSignature);
		},
	);

	ipcMain.handle(
		"preview-grouped-folder-migration",
		async (_, sourcePath: string) => {
			return await previewGroupedFolderMigration(sourcePath);
		},
	);

	ipcMain.handle(
		"execute-grouped-folder-migration",
		async (_, sourcePath: string) => {
			return await executeGroupedFolderMigration(sourcePath);
		},
	);

	ipcMain.handle("get-file-thumbnail", async (_, filePath: string) => {
		return await createFileThumbnail(filePath);
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
			return await checkDuplicateFiles(
				fileList,
				scanPath,
				settings.storePath,
				(galleryIds) => crawlerService.getMetadataByGalleryIds(galleryIds),
			);
		},
	);

	ipcMain.handle(
		"move-all-files-to-store",
		async (
			_,
			fileList: FileEntry[],
			scanPath: string,
			duplicateActions: Record<string, "overwrite" | "skip"> = {},
			groupTargetDirectories: Record<string, string> = {},
		) => {
			const settings = await getSettings();
			return await moveAllFilesToStore(
				fileList,
				scanPath,
				settings.storePath,
				duplicateActions,
				groupTargetDirectories,
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
		return await moveFileToFavorite(filePath, settings.keepPath);
	});

	ipcMain.handle(
		"move-file-to-favorite-artist",
		async (_, filePath: string, artistFolderName: string) => {
			const settings = await getSettings();
			return await moveFileToFavoriteArtist(
				filePath,
				artistFolderName,
				settings.favoriteArtistPath,
			);
		},
	);
};
