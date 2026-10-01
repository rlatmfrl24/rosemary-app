import { clipboard, ipcMain } from "electron";
import { parseArchiveFileName } from "../shared/archive-name";
import type { ArchiveGalleryRecoveryEntry } from "../shared/crawler";
import type {
	ArchiveDuplicateDecision,
	GroupMergeSourceFile,
	RandomReviewOptions,
	SimilarGroupBatchRequest,
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
import { validateIpcInputs } from "./ipc-inputs";
import { assertTrustedSender } from "./ipc-security";
import { withOrganizerMutation } from "./organizer-operation";
import {
	ensurePathExists,
	ensureProcessRunning,
	launchDetachedProcess,
} from "./process-utils";
import { loadSettings, saveSettings } from "./settings";
import {
	cancelSimilarGroupBatch,
	executeSimilarGroupBatch,
	previewSimilarGroupBatch,
	releaseSimilarGroupBatch,
} from "./similar-group-batch";
import { createFileThumbnail } from "./thumbnails";

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

const mutationChannels = new Set([
	"trash-files",
	"move-group-to-folder",
	"merge-files-to-group",
	"execute-grouped-folder-migration",
	"delete-file",
	"move-all-files-to-store",
	"copy-file",
	"move-file",
	"keep-file",
	"move-file-to-favorite-artist",
	"mark-similar-group-review-state",
	"clear-similar-group-review-state",
]);

export const registerIpcHandlers = (crawlerService: CrawlerService): void => {
	const handle = (
		channel: string,
		listener: Parameters<typeof ipcMain.handle>[1],
	): void => {
		ipcMain.handle(channel, (event, ...args) => {
			assertTrustedSender(event);
			validateIpcInputs(channel, args);
			return mutationChannels.has(channel)
				? withOrganizerMutation(async () => listener(event, ...args))
				: listener(event, ...args);
		});
	};

	handle("clipboard-write-text", (_, text: string) => {
		if (typeof text !== "string") {
			throw new Error("복사할 텍스트가 올바르지 않습니다.");
		}

		clipboard.writeText(text);
		return true;
	});

	handle("get-target-path", async () => {
		return await selectDirectoryPath();
	});

	handle("get-settings", async () => {
		return await getSettings();
	});

	handle("save-settings", async (_, settings: AppSettings) => {
		return await saveSettings(settings);
	});

	handle("launch-hitomi-downloader", async () => {
		const settings = await getSettings();
		const executablePath = getConfiguredPath(
			settings.hitomiDownloaderPath,
			"Hitomi Downloader 실행 파일 경로가 설정되지 않았습니다. 설정에서 먼저 지정해주세요.",
		);

		await ensurePathExists(
			executablePath,
			"Hitomi Downloader 실행 파일을 찾을 수 없습니다. 설정 경로를 확인해주세요.",
		);

		const launched = await ensureProcessRunning(executablePath);

		return {
			success: true,
			message: !launched
				? "Hitomi Downloader가 이미 실행 중입니다."
				: process.platform === "win32"
					? "Hitomi Downloader를 실행하고 실행 여부를 확인했습니다."
					: "Hitomi Downloader 실행을 요청했습니다.",
			path: executablePath,
			launched,
			running: process.platform === "win32" ? true : null,
		};
	});

	handle("hitomi-api-install", async () => {
		const settings = await getSettings();
		return await installHitomiApiExtension(settings);
	});

	handle("hitomi-api-status", async () => {
		const settings = await getSettings();
		return await diagnoseHitomiApiConnection(settings);
	});

	handle("hitomi-api-prepare", async () => {
		const settings = await getSettings();
		return await prepareHitomiApiConnection(settings);
	});

	handle("hitomi-api-send-codes", async (_, codes: string[]) => {
		if (
			!Array.isArray(codes) ||
			codes.some((code) => typeof code !== "string")
		) {
			throw new Error("Hitomi API로 전송할 코드 목록이 올바르지 않습니다.");
		}

		const settings = await getSettings();
		return await sendCodesToHitomiApi(codes, settings);
	});

	handle("crawl-start", async (_, options) => {
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

	handle("crawl-stop", async () => {
		return await crawlerService.stop();
	});

	handle("crawl-status", () => {
		return crawlerService.getStatus();
	});

	handle("crawl-recent-items", (_, options) => {
		return crawlerService.getRecentItems(options);
	});

	handle("crawl-download-retry", (_, runId?: number) => {
		return crawlerService.retryFailedDownloads(runId);
	});

	handle("crawl-db-summary", () => {
		return crawlerService.getDatabaseSummary();
	});

	handle("hitomi-catalog-index-status", () => {
		return crawlerService.getHitomiCatalogStatus();
	});

	handle("crawl-db-list-items", (_, options) => {
		return crawlerService.listItems(options);
	});

	handle("crawl-db-create-item", (_, input) => {
		return crawlerService.createItem(input);
	});

	handle("crawl-db-update-item", (_, originalCode, input) => {
		return crawlerService.updateItem(originalCode, input);
	});

	handle("crawl-db-delete-item", (_, code: string) => {
		return crawlerService.deleteItem(code);
	});

	handle("crawl-db-reset", () => {
		return crawlerService.resetDatabase();
	});

	handle("tag-preferences-list", () => {
		return crawlerService.listTagPreferences();
	});

	handle("tag-preferences-upsert", (_, input) => {
		return crawlerService.upsertTagPreference(input);
	});

	handle("tag-preferences-delete", (_, input) => {
		return crawlerService.deleteTagPreference(input);
	});

	handle("archive-metadata-recovery-start", () => {
		return crawlerService.startArchiveMetadataRecovery();
	});

	handle(
		"archive-metadata-recovery-enqueue-files",
		(_, filePaths: string[]) => {
			return crawlerService.enqueueArchiveMetadataRecoveryFiles(filePaths);
		},
	);

	handle("archive-metadata-recovery-entries", (_, galleryIds: string[]) => {
		return crawlerService.getArchiveMetadataRecoveryEntries(galleryIds);
	});

	handle("archive-metadata-recovery-pause", () => {
		return crawlerService.pauseArchiveMetadataRecovery();
	});

	handle("archive-metadata-recovery-resume", () => {
		return crawlerService.resumeArchiveMetadataRecovery();
	});

	handle("archive-metadata-recovery-status", () => {
		return crawlerService.getArchiveMetadataRecoveryStatus();
	});

	handle("archive-metadata-recovery-failures", (_, limit?: number) => {
		return crawlerService.listArchiveMetadataRecoveryFailures(limit);
	});

	handle("archive-metadata-recovery-retry", () => {
		return crawlerService.retryArchiveMetadataRecoveryUnresolved();
	});

	handle(
		"select-file-path",
		async (
			_,
			title: string,
			filters?: { name: string; extensions: string[] }[],
		) => {
			return await selectFilePath(title, filters);
		},
	);

	handle("scan-files", async (event, targetPath: string) => {
		const result = await scanArchiveFiles(targetPath, (progress) => {
			event.sender.send("scan-files-progress", progress);
		});
		return {
			...result,
			files: attachSourceMetadata(result.files, crawlerService),
		};
	});

	handle("random-review-files", async (event, options: RandomReviewOptions) => {
		const result = await scanRandomReviewFiles(
			options,
			(progress) => {
				event.sender.send("random-review-files-progress", progress);
			},
			(galleryIds) => crawlerService.getMetadataByGalleryIds(galleryIds),
		);
		return {
			...result,
			files: attachSourceMetadata(result.files, crawlerService),
		};
	});

	handle("find-similar-groups", async (event, options: SimilarGroupOptions) => {
		return await findSimilarGroups(
			options,
			(progress) => {
				event.sender.send("find-similar-groups-progress", progress);
			},
			(galleryIds) => crawlerService.getMetadataByGalleryIds(galleryIds),
		);
	});

	handle(
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

	handle(
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

	const batchOwners = new Set<number>();
	handle(
		"preview-similar-group-batch",
		async (event, request: SimilarGroupBatchRequest) => {
			const owner = event.sender.id;
			if (!batchOwners.has(owner)) {
				batchOwners.add(owner);
				event.sender.once("destroyed", () => {
					releaseSimilarGroupBatch(owner);
					batchOwners.delete(owner);
				});
			}
			return previewSimilarGroupBatch(owner, request, (ids) =>
				crawlerService.getMetadataByGalleryIds(ids),
			);
		},
	);
	handle(
		"execute-similar-group-batch",
		async (event, planId: string, itemIds: string[]) =>
			executeSimilarGroupBatch(
				event.sender.id,
				planId,
				itemIds,
				(ids) => crawlerService.getMetadataByGalleryIds(ids),
				(progress) => {
					if (!event.sender.isDestroyed())
						event.sender.send("similar-group-batch-progress", progress);
				},
			),
	);
	handle("cancel-similar-group-batch", (event, planId: string) =>
		cancelSimilarGroupBatch(event.sender.id, planId),
	);

	handle("trash-files", async (_, filePaths: string[]) => {
		return await trashFilesToRecycleBin(filePaths);
	});

	handle(
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

	handle(
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

	handle(
		"mark-similar-group-review-state",
		async (_, input: SimilarGroupReviewStateInput) => {
			return await markSimilarGroupReviewState(input);
		},
	);

	handle(
		"clear-similar-group-review-state",
		async (_, reviewKey: string, contentSignature?: string) => {
			return await clearSimilarGroupReviewState(reviewKey, contentSignature);
		},
	);

	handle("preview-grouped-folder-migration", async (_, sourcePath: string) => {
		return await previewGroupedFolderMigration(sourcePath);
	});

	handle("execute-grouped-folder-migration", async (_, sourcePath: string) => {
		return await executeGroupedFolderMigration(sourcePath);
	});

	handle("get-file-thumbnail", async (_, filePath: string) => {
		return await createFileThumbnail(filePath);
	});

	handle("delete-file", async (_, filePath: string) => {
		return await deleteFile(filePath);
	});

	handle("open-with-bandiview", async (_, filePath: string) => {
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

		await launchDetachedProcess(executablePath, [filePath]);

		return { success: true, message: "BandiView로 파일을 열었습니다." };
	});

	handle(
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

	handle(
		"move-all-files-to-store",
		async (
			_,
			fileList: FileEntry[],
			scanPath: string,
			duplicateActions: Record<string, ArchiveDuplicateDecision> = {},
			groupTargetDirectories: Record<string, string> = {},
		) => {
			const settings = await getSettings();
			return await moveAllFilesToStore(
				fileList,
				scanPath,
				settings.storePath,
				duplicateActions,
				groupTargetDirectories,
				(galleryIds) => crawlerService.getMetadataByGalleryIds(galleryIds),
			);
		},
	);

	handle("copy-file", async (_, filePath: string, targetPath: string) => {
		return await copyFileToPath(filePath, targetPath);
	});

	handle("move-file", async (_, filePath: string, targetPath: string) => {
		return await moveFileToPath(filePath, targetPath);
	});

	handle("keep-file", async (_, filePath: string) => {
		const settings = await getSettings();
		return await moveFileToFavorite(filePath, settings.keepPath);
	});

	handle(
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
