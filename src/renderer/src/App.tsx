import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	DuplicateCheckResult,
	FavoriteArtistCandidate,
	FavoriteArtistCandidateResult,
	GroupMergeCandidate,
	GroupMergeCandidateResult,
	ScanArchiveProgress,
	ScanArchiveResult,
	ScanIndexSummary,
} from "../../shared/file-organizer";
import type { OrganizationReviewIssue } from "../../shared/organization-metadata";
import {
	countMatchingTagPreferences,
	getTagPreferenceKey,
	type TagPreference,
	type TagPreferenceIdentity,
	type TagPreferenceInput,
} from "../../shared/tag-preferences";
import {
	EmptyState,
	FileTable,
	GearIcon,
	Header,
	LoadingState,
	NoResults,
	RosemaryBrand,
	Stats,
} from "./components";
import { useArchiveMetadataRecovery } from "./hooks/useArchiveMetadataRecovery";
import { useFileActions } from "./hooks/useFileActions";
import { useFileThumbnails } from "./hooks/useFileThumbnails";
import { useKeyboardNavigation } from "./hooks/useKeyboardNavigation";
import { useScrollToRow } from "./hooks/useScrollToRow";
import type {
	DuplicateAction,
	DuplicateFileInfo,
	FileInfo,
	FileReviewFilter,
	ReviewFileInfo,
} from "./types";
import { getRelativePath, parseFileStructure } from "./utils/file";

type AppTab = "files" | "crawler" | "crawler-db" | "similar" | "review";
type FileReviewPhase = "idle" | "checking" | "complete" | "failed";

const CrawlerDbPanel = lazy(async () => {
	const module = await import("./components/CrawlerDbPanel");
	return { default: module.CrawlerDbPanel };
});
const CrawlerPanel = lazy(async () => {
	const module = await import("./components/CrawlerPanel");
	return { default: module.CrawlerPanel };
});
const RandomReviewPanel = lazy(async () => {
	const module = await import("./components/RandomReviewPanel");
	return { default: module.RandomReviewPanel };
});
const Settings = lazy(async () => {
	const module = await import("./components/Settings");
	return { default: module.Settings };
});
const SimilarGroupPanel = lazy(async () => {
	const module = await import("./components/SimilarGroupPanel");
	return { default: module.SimilarGroupPanel };
});

const DeferredPanelFallback = (): React.JSX.Element => (
	<output
		className="flex min-h-0 flex-1 items-center justify-center"
		aria-label="화면 불러오는 중"
	>
		<span className="loading loading-spinner loading-md" />
	</output>
);

const isScanArchiveResult = (value: unknown): value is ScanArchiveResult =>
	typeof value === "object" &&
	value !== null &&
	"files" in value &&
	Array.isArray((value as ScanArchiveResult).files);

const getFileEntryPayloads = (files: FileInfo[]) =>
	files.map((file) => ({
		path: file.path,
		name: file.name,
		size: file.size,
		artist: file.artist,
		type: file.type,
		origin: file.origin,
		sourceMetadata: file.sourceMetadata,
	}));

const createReviewFile = (file: FileInfo): ReviewFileInfo => ({
	...file,
	reviewStatus: "checking",
	reviewChecks: {
		duplicates: false,
		groups: false,
		favoriteArtists: false,
	},
});

const deriveReviewStatus = (file: ReviewFileInfo): ReviewFileInfo => {
	if (file.reviewError) {
		return {
			...file,
			reviewStatus: "review-needed",
		};
	}

	if (file.reviewIssues && file.reviewIssues.length > 0) {
		return {
			...file,
			reviewStatus: "review-needed",
			useGroupTarget: file.groupCandidate ? false : file.useGroupTarget,
		};
	}

	if (
		!file.reviewChecks.duplicates ||
		!file.reviewChecks.groups ||
		!file.reviewChecks.favoriteArtists
	) {
		return {
			...file,
			reviewStatus: "checking",
		};
	}

	if (
		file.duplicate &&
		(file.duplicateAction === "skip" || file.duplicateAction === "keep")
	) {
		return {
			...file,
			reviewStatus: "review-needed",
		};
	}

	if (file.duplicate && !file.duplicateAction) {
		return {
			...file,
			reviewStatus: "duplicate",
		};
	}

	if (file.groupCandidate && file.useGroupTarget !== false) {
		return {
			...file,
			reviewStatus: "group-merge",
		};
	}

	return {
		...file,
		reviewStatus: "ready",
	};
};

const mergeReviewIssues = (
	currentIssues: OrganizationReviewIssue[] | undefined,
	incomingIssues: OrganizationReviewIssue[],
): OrganizationReviewIssue[] | undefined => {
	const issuesByKey = new Map<string, OrganizationReviewIssue>();
	for (const issue of [...(currentIssues ?? []), ...incomingIssues]) {
		const key = [
			issue.kind,
			issue.field ?? "",
			issue.message,
			...(issue.candidatePaths ?? []),
			issue.blockedGroupPath ?? "",
		].join("|");
		issuesByKey.set(key, issue);
	}
	const issues = [...issuesByKey.values()];
	return issues.length > 0 ? issues : undefined;
};

const applyDuplicateResults = (
	files: ReviewFileInfo[],
	duplicates: DuplicateFileInfo[],
	issues: OrganizationReviewIssue[],
): ReviewFileInfo[] => {
	const duplicatesByPath = new Map(
		duplicates.map((duplicate) => [duplicate.sourcePath, duplicate]),
	);

	return files.map((file) => {
		const duplicate = duplicatesByPath.get(file.path);
		const fileIssues = issues.filter((issue) => issue.filePath === file.path);
		return deriveReviewStatus({
			...file,
			duplicate,
			duplicateAction: duplicate ? file.duplicateAction : undefined,
			reviewIssues: mergeReviewIssues(file.reviewIssues, fileIssues),
			reviewChecks: {
				...file.reviewChecks,
				duplicates: true,
			},
		});
	});
};

const applyGroupCandidates = (
	files: ReviewFileInfo[],
	candidates: GroupMergeCandidate[],
	issues: OrganizationReviewIssue[],
): ReviewFileInfo[] => {
	const candidatesByPath = new Map(
		candidates.map((candidate) => [candidate.filePath, candidate]),
	);

	return files.map((file) => {
		const groupCandidate = candidatesByPath.get(file.path);
		const fileIssues = issues.filter((issue) => issue.filePath === file.path);
		const reviewIssues = mergeReviewIssues(file.reviewIssues, fileIssues);
		return deriveReviewStatus({
			...file,
			groupCandidate,
			useGroupTarget: groupCandidate
				? reviewIssues
					? false
					: (file.useGroupTarget ?? true)
				: undefined,
			reviewIssues,
			reviewChecks: {
				...file.reviewChecks,
				groups: true,
			},
		});
	});
};

const applyFavoriteArtistCandidates = (
	files: ReviewFileInfo[],
	candidates: FavoriteArtistCandidate[],
	issues: OrganizationReviewIssue[],
): ReviewFileInfo[] => {
	const candidatesByPath = new Map(
		candidates.map((candidate) => [candidate.filePath, candidate]),
	);

	return files.map((file) => {
		const fileIssues = issues.filter((issue) => issue.filePath === file.path);
		const reviewIssues = mergeReviewIssues(file.reviewIssues, fileIssues);
		return deriveReviewStatus({
			...file,
			favoriteArtistCandidate: reviewIssues
				? undefined
				: candidatesByPath.get(file.path),
			reviewIssues,
			reviewChecks: {
				...file.reviewChecks,
				favoriteArtists: true,
			},
		});
	});
};

const applyReviewError = (
	files: ReviewFileInfo[],
	check: keyof ReviewFileInfo["reviewChecks"],
	message: string,
): ReviewFileInfo[] =>
	files.map((file) =>
		deriveReviewStatus({
			...file,
			reviewError: file.reviewError
				? `${file.reviewError} / ${message}`
				: message,
			reviewChecks: {
				...file.reviewChecks,
				[check]: true,
			},
		}),
	);

const matchesFileFilter = (
	file: ReviewFileInfo,
	filter: FileReviewFilter,
): boolean => {
	if (filter === "all") {
		return true;
	}

	if (filter === "review-needed") {
		return (
			file.reviewStatus === "review-needed" ||
			file.reviewStatus === "checking" ||
			Boolean(file.duplicate && !file.duplicateAction)
		);
	}

	if (filter === "ready") {
		return file.reviewStatus === "ready" && !file.favoriteArtistCandidate;
	}

	if (filter === "duplicate") {
		return Boolean(file.duplicate);
	}

	if (filter === "favorite-artist") {
		return Boolean(file.favoriteArtistCandidate);
	}

	if (filter === "group-merge") {
		return Boolean(file.groupCandidate);
	}

	return file.reviewStatus === filter;
};

const getVisibleFileIndexes = (
	files: ReviewFileInfo[],
	filter: FileReviewFilter,
	preferredTags: TagPreferenceIdentity[],
): number[] =>
	files
		.map((file, index) => ({ file, index }))
		.filter(({ file }) => matchesFileFilter(file, filter))
		.map(({ file, index }) => ({
			file,
			index,
			preferredTagMatchCount: file.sourceMetadata
				? countMatchingTagPreferences(file.sourceMetadata.tags, preferredTags)
				: 0,
		}))
		.sort(
			(left, right) =>
				right.preferredTagMatchCount - left.preferredTagMatchCount ||
				left.index - right.index,
		)
		.map(({ index }) => index);

function App(): React.JSX.Element {
	const DEFAULT_PATH = "D:/hitomi_downloader_GUI/hitomi_downloaded/new";

	const [activeTab, setActiveTab] = useState<AppTab>("files");
	const [selectedPath, setSelectedPath] = useState<string | null>(DEFAULT_PATH);
	const [fileList, setFileList] = useState<ReviewFileInfo[]>([]);
	const [isScanning, setIsScanning] = useState(false);
	const [thumbnailEnabled, setThumbnailEnabled] = useState(false);
	const [scanProgress, setScanProgress] = useState<ScanArchiveProgress | null>(
		null,
	);
	const [scanIndexSummary, setScanIndexSummary] =
		useState<ScanIndexSummary | null>(null);
	const [fileReviewPhase, setFileReviewPhase] =
		useState<FileReviewPhase>("idle");
	const [activeFileFilter, setActiveFileFilter] =
		useState<FileReviewFilter>("all");
	const [scanComplete, setScanComplete] = useState(false);
	const [selectedRowIndex, setSelectedRowIndex] = useState<number>(-1);
	const [isSettingsOpen, setIsSettingsOpen] = useState(false);
	const [tagPreferences, setTagPreferences] = useState<TagPreference[]>([]);
	const reviewRunIdRef = useRef(0);
	const tableContainerRef = useRef<HTMLDivElement>(null);
	const preferredTags = useMemo(
		() =>
			tagPreferences.filter((preference) => preference.kind === "preferred"),
		[tagPreferences],
	);
	const visibleFileIndexes = useMemo(
		() => getVisibleFileIndexes(fileList, activeFileFilter, preferredTags),
		[fileList, activeFileFilter, preferredTags],
	);
	const thumbnailProgress = useFileThumbnails({
		enabled: thumbnailEnabled,
		fileList,
		scanComplete,
		setFileList,
	});
	const { requestSourceMetadata, isRequestingSourceMetadata } =
		useArchiveMetadataRecovery(fileList, setFileList);
	const {
		handleCopyFile,
		handleMoveFile,
		handleKeepFile,
		handleMoveToFavoriteArtist,
	} = useFileActions({
		fileList,
		selectedRowIndex,
		setFileList,
		setSelectedRowIndex,
		visibleFileIndexes,
	});

	// 커스텀 훅 사용
	useKeyboardNavigation({
		enabled: activeTab === "files",
		scanComplete,
		fileList,
		selectedRowIndex,
		setSelectedRowIndex,
		setFileList,
		visibleFileIndexes,
	});

	useScrollToRow({
		selectedRowIndex,
		tableContainerRef,
	});

	useEffect(() => {
		const unsubscribe = window.electron.ipcRenderer.on(
			"scan-files-progress",
			(_, progress: ScanArchiveProgress) => {
				setScanProgress(progress);
			},
		);

		return unsubscribe;
	}, []);

	useEffect(() => {
		if (activeTab !== "files") return;
		let isCancelled = false;

		window.api.crawlerDb
			.listTagPreferences()
			.then((preferences) => {
				if (!isCancelled) {
					setTagPreferences(preferences);
				}
			})
			.catch((error) => {
				console.error("사용자 태그 설정 조회 실패:", error);
			});

		return () => {
			isCancelled = true;
		};
	}, [activeTab]);

	// 파일 목록/필터가 변경될 때 선택된 인덱스 초기화
	useEffect(() => {
		if (fileList.length === 0 || visibleFileIndexes.length === 0) {
			setSelectedRowIndex(-1);
		} else if (!visibleFileIndexes.includes(selectedRowIndex)) {
			setSelectedRowIndex(visibleFileIndexes[0] ?? -1);
		}
	}, [fileList.length, selectedRowIndex, visibleFileIndexes]);

	const getPath = useCallback(async (): Promise<void> => {
		try {
			const path = await window.electron.ipcRenderer.invoke("get-target-path");
			setSelectedPath(path);
			setFileList([]);
			setScanComplete(false);
			setSelectedRowIndex(-1);
			setScanProgress(null);
			setScanIndexSummary(null);
			setFileReviewPhase("idle");
			setActiveFileFilter("all");
			reviewRunIdRef.current += 1;
		} catch (error) {
			console.error("폴더 선택 중 오류 발생:", error);
		}
	}, []);

	const runFileReviewChecks = useCallback(
		async (
			files: ReviewFileInfo[],
			scanPath: string,
			runId: number,
		): Promise<void> => {
			setFileReviewPhase("checking");
			const payloads = getFileEntryPayloads(files);

			const duplicatePromise = window.electron.ipcRenderer
				.invoke("check-duplicate-files", payloads, scanPath)
				.then((result: DuplicateCheckResult) => {
					if (reviewRunIdRef.current !== runId) {
						return;
					}

					setFileList((currentFiles) =>
						applyDuplicateResults(
							currentFiles,
							result.duplicates ?? [],
							result.issues ?? [],
						),
					);
				})
				.catch((error) => {
					console.error("중복 파일 검토 중 오류 발생:", error);
					if (reviewRunIdRef.current !== runId) {
						return;
					}

					setFileList((currentFiles) =>
						applyReviewError(currentFiles, "duplicates", "중복 검토 실패"),
					);
				});

			const groupPromise = window.api.fileOrganizer
				.findGroupMergeCandidates(payloads, scanPath)
				.then((result: GroupMergeCandidateResult) => {
					if (reviewRunIdRef.current !== runId) {
						return;
					}

					setFileList((currentFiles) =>
						applyGroupCandidates(
							currentFiles,
							result.candidates,
							result.issues,
						),
					);
				})
				.catch((error) => {
					console.error("기존 그룹 후보 검토 중 오류 발생:", error);
					if (reviewRunIdRef.current !== runId) {
						return;
					}

					setFileList((currentFiles) =>
						applyReviewError(currentFiles, "groups", "그룹 후보 검토 실패"),
					);
				});

			const favoriteArtistPromise = window.api.fileOrganizer
				.findFavoriteArtistCandidates(payloads)
				.then((result: FavoriteArtistCandidateResult) => {
					if (reviewRunIdRef.current !== runId) {
						return;
					}

					setFileList((currentFiles) =>
						applyFavoriteArtistCandidates(
							currentFiles,
							result.candidates,
							result.issues,
						),
					);
				})
				.catch((error) => {
					console.error("Favorite Artist 후보 검토 중 오류 발생:", error);
					if (reviewRunIdRef.current !== runId) {
						return;
					}

					setFileList((currentFiles) =>
						applyFavoriteArtistCandidates(currentFiles, [], []),
					);
				});

			const results = await Promise.allSettled([
				duplicatePromise,
				groupPromise,
				favoriteArtistPromise,
			]);
			if (reviewRunIdRef.current !== runId) {
				return;
			}

			setFileReviewPhase(
				results.some((result) => result.status === "rejected")
					? "failed"
					: "complete",
			);
		},
		[],
	);

	const handleDuplicateActionChange = useCallback(
		(filePath: string, action: DuplicateAction): void => {
			setFileList((currentFiles) =>
				currentFiles.map((file) =>
					file.path === filePath
						? deriveReviewStatus({
								...file,
								duplicateAction: action,
							})
						: file,
				),
			);
		},
		[],
	);

	const handleDuplicateActionsChange = useCallback(
		(actions: Record<string, DuplicateAction>): void => {
			setFileList((currentFiles) =>
				currentFiles.map((file) => {
					const relativePath = selectedPath
						? getRelativePath(file.path, selectedPath)
						: file.name;
					const action = actions[relativePath] ?? actions[file.name];

					return action
						? deriveReviewStatus({
								...file,
								duplicateAction: action,
							})
						: file;
				}),
			);
		},
		[selectedPath],
	);

	const handleGroupTargetChange = useCallback(
		(filePath: string, useGroupTarget: boolean): void => {
			setFileList((currentFiles) =>
				currentFiles.map((file) =>
					file.path === filePath
						? deriveReviewStatus({
								...file,
								useGroupTarget,
							})
						: file,
				),
			);
		},
		[],
	);

	const handleUpsertTagPreference = useCallback(
		async (input: TagPreferenceInput): Promise<void> => {
			try {
				const saved = await window.api.crawlerDb.upsertTagPreference(input);
				setTagPreferences((current) => [
					...current.filter((preference) => preference.key !== saved.key),
					saved,
				]);
			} catch (error) {
				console.error("사용자 태그 설정 저장 실패:", error);
				alert(
					`태그 설정을 저장하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			}
		},
		[],
	);

	const handleDeleteTagPreference = useCallback(
		async (input: TagPreferenceIdentity): Promise<void> => {
			try {
				await window.api.crawlerDb.deleteTagPreference(input);
				const deletedKey = getTagPreferenceKey(input);
				setTagPreferences((current) =>
					current.filter((preference) => preference.key !== deletedKey),
				);
			} catch (error) {
				console.error("사용자 태그 설정 삭제 실패:", error);
				alert(
					`태그 설정을 삭제하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			}
		},
		[],
	);

	const scanFiles = useCallback(async (): Promise<void> => {
		if (!selectedPath) {
			alert("먼저 폴더를 선택해주세요.");
			return;
		}

		setIsScanning(true);
		setScanComplete(false);
		setFileList([]);
		setSelectedRowIndex(-1);
		setScanIndexSummary(null);
		setFileReviewPhase("idle");
		setActiveFileFilter("all");
		reviewRunIdRef.current += 1;
		setScanProgress({
			phase: "searching",
			processed: 0,
			total: 1,
			foundFiles: 0,
			currentPath: selectedPath,
		});

		try {
			const scanResult = await window.electron.ipcRenderer.invoke(
				"scan-files",
				selectedPath,
			);
			const files = isScanArchiveResult(scanResult)
				? scanResult.files
				: (scanResult as FileInfo[]);

			// 각 파일에 대해 파싱 정보 추가
			const parsedFiles: ReviewFileInfo[] = files.map((file: FileInfo) => {
				const relativePath = getRelativePath(file.path, selectedPath);
				const parsedData = parseFileStructure(relativePath);

				return createReviewFile({
					...file,
					...parsedData,
				});
			});
			const nextReviewRunId = reviewRunIdRef.current;

			setFileList(parsedFiles);
			setScanIndexSummary(
				isScanArchiveResult(scanResult) ? scanResult.indexSummary : null,
			);
			setScanComplete(true);
			setScanProgress({
				phase: "complete",
				processed: parsedFiles.length,
				total: parsedFiles.length,
				foundFiles: parsedFiles.length,
			});
			setFileReviewPhase(parsedFiles.length > 0 ? "checking" : "idle");

			if (parsedFiles.length > 0) {
				void runFileReviewChecks(parsedFiles, selectedPath, nextReviewRunId);
			}
		} catch (error) {
			console.error("파일 스캔 중 오류 발생:", error);
			alert("파일 스캔 중 오류가 발생했습니다.");
		} finally {
			setIsScanning(false);
		}
	}, [runFileReviewChecks, selectedPath]);

	const handleRowClick = useCallback((index: number): void => {
		setSelectedRowIndex(index);
	}, []);

	// 설정 열기/닫기 함수
	const handleOpenSettings = useCallback(() => {
		setIsSettingsOpen(true);
	}, []);

	const handleCloseSettings = useCallback(() => {
		setIsSettingsOpen(false);
	}, []);

	return (
		<div className="flex h-screen flex-col overflow-hidden bg-base-200">
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
				<div className="card bg-base-100 shadow-sm flex-shrink-0">
					<div className="card-body p-3">
						<div className="flex items-center justify-between gap-3">
							<div className="flex flex-col gap-3 lg:flex-row lg:items-center">
								<RosemaryBrand />
								<div
									className="tabs tabs-boxed tabs-sm bg-base-200 p-1"
									role="tablist"
									aria-label="기능 탭"
								>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "files" ? "tab-active" : ""}`}
										aria-selected={activeTab === "files"}
										onClick={() => setActiveTab("files")}
									>
										신규 파일 정리
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "crawler" ? "tab-active" : ""}`}
										aria-selected={activeTab === "crawler"}
										onClick={() => setActiveTab("crawler")}
									>
										로컬 크롤링
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "crawler-db" ? "tab-active" : ""}`}
										aria-selected={activeTab === "crawler-db"}
										onClick={() => setActiveTab("crawler-db")}
									>
										DB 관리
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "similar" ? "tab-active" : ""}`}
										aria-selected={activeTab === "similar"}
										onClick={() => setActiveTab("similar")}
									>
										유사 그룹 정리
									</button>
									<button
										type="button"
										role="tab"
										className={`tab ${activeTab === "review" ? "tab-active" : ""}`}
										aria-selected={activeTab === "review"}
										onClick={() => setActiveTab("review")}
									>
										랜덤 재검토
									</button>
								</div>
							</div>

							<button
								type="button"
								className="btn btn-sm btn-ghost btn-square"
								onClick={handleOpenSettings}
								title="설정"
								aria-label="설정 열기"
							>
								<GearIcon className="h-4 w-4" />
							</button>
						</div>
					</div>
				</div>

				<Suspense fallback={<DeferredPanelFallback />}>
					{activeTab === "files" ? (
						<>
							<Header
								selectedPath={selectedPath}
								isScanning={isScanning}
								thumbnailEnabled={thumbnailEnabled}
								onSelectPath={getPath}
								onScanFiles={scanFiles}
								onThumbnailEnabledChange={setThumbnailEnabled}
							/>

							{isScanning && <LoadingState progress={scanProgress} />}

							{!isScanning && !scanComplete && !selectedPath && (
								<EmptyState onSelectPath={getPath} />
							)}

							{scanComplete && fileList.length === 0 && <NoResults />}

							{scanComplete && fileList.length > 0 && (
								<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
									<Stats
										fileList={fileList}
										selectedPath={selectedPath}
										fileReviewPhase={fileReviewPhase}
										scanIndexSummary={scanIndexSummary}
										onFileListChange={setFileList}
										onDuplicateActionsChange={handleDuplicateActionsChange}
									/>
									<FileTable
										fileList={fileList}
										visibleFileIndexes={visibleFileIndexes}
										activeFilter={activeFileFilter}
										selectedRowIndex={selectedRowIndex}
										selectedPath={selectedPath}
										thumbnailEnabled={thumbnailEnabled}
										thumbnailProgress={thumbnailProgress}
										tableContainerRef={tableContainerRef}
										reviewPhase={fileReviewPhase}
										onRowClick={handleRowClick}
										onFilterChange={setActiveFileFilter}
										onDuplicateActionChange={handleDuplicateActionChange}
										onGroupTargetChange={handleGroupTargetChange}
										onCopyFile={handleCopyFile}
										onMoveFile={handleMoveFile}
										onKeepFile={handleKeepFile}
										onMoveToFavoriteArtist={handleMoveToFavoriteArtist}
										onRequestSourceMetadata={requestSourceMetadata}
										isRequestingSourceMetadata={isRequestingSourceMetadata}
										tagPreferences={tagPreferences}
										onUpsertTagPreference={handleUpsertTagPreference}
										onDeleteTagPreference={handleDeleteTagPreference}
									/>
								</div>
							)}
						</>
					) : activeTab === "review" ? (
						<RandomReviewPanel />
					) : activeTab === "similar" ? (
						<SimilarGroupPanel />
					) : activeTab === "crawler" ? (
						<CrawlerPanel />
					) : (
						<CrawlerDbPanel />
					)}
				</Suspense>
			</div>

			{/* 설정 모달 */}
			{isSettingsOpen && (
				<Suspense fallback={null}>
					<Settings isOpen onClose={handleCloseSettings} />
				</Suspense>
			)}
		</div>
	);
}

export default App;
