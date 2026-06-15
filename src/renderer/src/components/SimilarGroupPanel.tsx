import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	FileThumbnail,
	GroupOperationResult,
	ScanArchiveProgress,
	SimilarGroup,
	SimilarGroupFile,
	SimilarGroupOptions,
} from "../../../shared/file-organizer";
import { formatFileSize } from "../utils/file";
import { ExternalLinkIcon, FolderIcon, TrashIcon } from "./Icons";
import { LoadingState } from "./LoadingState";

const DEFAULT_MIN_GROUP_SIZE = 2;
const DEFAULT_MIN_CONFIDENCE = 86;

interface ThumbnailEntry {
	thumbnail?: FileThumbnail | null;
	loadState?: "loading" | "failed";
	requestId?: number;
}

type RecommendationAction = "trash" | "group" | "review";

interface GroupRecommendation {
	caseLabel: string;
	title: string;
	description: string;
	action: RecommendationAction;
	actionLabel: string;
	selectedFiles: SimilarGroupFile[];
	keepFiles: SimilarGroupFile[];
	reasons: string[];
	confidenceLabel: "높음" | "중간" | "검토";
}

const isEditableTarget = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) {
		return false;
	}

	const tagName = target.tagName.toLowerCase();
	return (
		target.isContentEditable ||
		tagName === "input" ||
		tagName === "textarea" ||
		tagName === "select"
	);
};

const formatDate = (modifiedTimeMs: number | undefined): string => {
	if (typeof modifiedTimeMs !== "number") {
		return "-";
	}

	return new Intl.DateTimeFormat("ko-KR", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(modifiedTimeMs));
};

const formatIndexedAt = (indexedAt: number | undefined): string => {
	if (typeof indexedAt !== "number") {
		return "-";
	}

	return new Intl.DateTimeFormat("ko-KR", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(indexedAt));
};

const getOperationMessage = (
	result: GroupOperationResult,
	successLabel: string,
): string =>
	result.summary.failed === 0
		? `${successLabel}\n처리: ${result.summary.success}/${result.summary.total}개`
		: `${successLabel} 일부 실패\n성공: ${result.summary.success}개\n실패: ${result.summary.failed}개`;

const getGroupFolderName = (group: SimilarGroup): string =>
	`${group.artist ? `${group.artist} - ` : ""}${group.representativeTitle}`;

const getComparableLength = (value: string | undefined): number =>
	(value ?? "")
		.normalize("NFKC")
		.replace(/[^0-9a-zA-Z가-힣ぁ-んァ-ン一-龥]/g, "").length;

const COMPLETE_TEXT_PATTERN =
	/\b(?:complete|final|compilation|compiled|collection|all in one)\b|완전판|합본|총집편|총集編|総集編|合集|まとめ/i;

const getSeriesKey = (file: SimilarGroupFile): string =>
	[...file.seriesTokens].sort().join("|");

const hasSeriesToken = (file: SimilarGroupFile): boolean =>
	getSeriesKey(file).length > 0;

const isCompleteLikeFile = (file: SimilarGroupFile): boolean => {
	const text = [
		file.name,
		file.title,
		file.baseTitle,
		...file.editionTokens,
	].join(" ");
	return COMPLETE_TEXT_PATTERN.test(text);
};

const getRevisionValue = (file: SimilarGroupFile): number => {
	const text = [...file.editionTokens, file.name].join(" ");
	const versionMatch = text.match(/\b(?:v|ver\.?\s*)(\d{1,3})\b/i);
	return versionMatch ? Number.parseInt(versionMatch[1] ?? "0", 10) : 0;
};

const getEditionScore = (file: SimilarGroupFile): number => {
	const text = [...file.editionTokens, file.name, file.title]
		.join(" ")
		.toLowerCase();
	let score = 0;

	if (isCompleteLikeFile(file)) {
		score += 80;
	}

	if (/\b(?:uncensored|decensored)\b/.test(text)) {
		score += 28;
	}

	if (/\b(?:rev|revised|v\d+|ver\.?\s*\d+)\b/.test(text)) {
		score += 20 + getRevisionValue(file);
	}

	if (/\bdigital\b/.test(text)) {
		score += 8;
	}

	if (/\b(?:full color|color)\b/.test(text)) {
		score += 6;
	}

	return score;
};

const getMetadataScore = (file: SimilarGroupFile): number =>
	(file.code ? 6 : 0) +
	(file.artist ? 4 : 0) +
	(file.origin ? 3 : 0) +
	(file.category ? 1 : 0) +
	Math.min(6, getComparableLength(file.baseTitle || file.title));

const sortByPreferredFile = (files: SimilarGroupFile[]): SimilarGroupFile[] =>
	[...files].sort((left, right) => {
		const editionDelta = getEditionScore(right) - getEditionScore(left);
		if (editionDelta !== 0) {
			return editionDelta;
		}

		const modifiedDelta =
			(right.modifiedTimeMs ?? 0) - (left.modifiedTimeMs ?? 0);
		if (modifiedDelta !== 0) {
			return modifiedDelta;
		}

		const sizeDelta = right.size - left.size;
		if (sizeDelta !== 0) {
			return sizeDelta;
		}

		const metadataDelta = getMetadataScore(right) - getMetadataScore(left);
		if (metadataDelta !== 0) {
			return metadataDelta;
		}

		return right.name.localeCompare(left.name);
	});

const getPreferredFile = (
	files: SimilarGroupFile[],
): SimilarGroupFile | undefined => sortByPreferredFile(files)[0];

const createUniqueFiles = (
	files: SimilarGroupFile[],
	excludePaths: Set<string> = new Set(),
): SimilarGroupFile[] => {
	const seenPaths = new Set<string>();
	const uniqueFiles: SimilarGroupFile[] = [];

	for (const file of files) {
		if (seenPaths.has(file.path) || excludePaths.has(file.path)) {
			continue;
		}

		seenPaths.add(file.path);
		uniqueFiles.push(file);
	}

	return uniqueFiles;
};

const getDuplicateRecommendation = (
	files: SimilarGroupFile[],
): Pick<GroupRecommendation, "selectedFiles" | "keepFiles" | "reasons"> => {
	const buckets = new Map<string, SimilarGroupFile[]>();

	for (const file of files) {
		if (file.code) {
			const codeKey = `code:${file.code}`;
			buckets.set(codeKey, [...(buckets.get(codeKey) ?? []), file]);
		}

		const seriesKey = getSeriesKey(file);
		if (seriesKey) {
			const seriesBucketKey = `series:${seriesKey}`;
			buckets.set(seriesBucketKey, [
				...(buckets.get(seriesBucketKey) ?? []),
				file,
			]);
		}
	}

	const selectedFiles: SimilarGroupFile[] = [];
	const keepFiles: SimilarGroupFile[] = [];
	const reasons = new Set<string>();

	for (const bucketFiles of buckets.values()) {
		if (bucketFiles.length < 2) {
			continue;
		}

		const keepFile = getPreferredFile(bucketFiles);
		if (!keepFile) {
			continue;
		}

		keepFiles.push(keepFile);
		selectedFiles.push(
			...bucketFiles.filter((file) => file.path !== keepFile.path),
		);
		reasons.add(
			bucketFiles.some((file) => file.code)
				? "같은 코드 중 최신/큰 파일 우선"
				: "같은 회차 표식 중 최신/큰 파일 우선",
		);
	}

	const keepPathSet = new Set(keepFiles.map((file) => file.path));
	return {
		selectedFiles: createUniqueFiles(selectedFiles, keepPathSet),
		keepFiles: createUniqueFiles(keepFiles),
		reasons: Array.from(reasons),
	};
};

const buildGroupRecommendation = (group: SimilarGroup): GroupRecommendation => {
	const files = group.files;
	const seriesFiles = files.filter(hasSeriesToken);
	const completeFiles = files.filter(isCompleteLikeFile);
	const nonSeriesFiles = files.filter((file) => !hasSeriesToken(file));
	const duplicateRecommendation = getDuplicateRecommendation(files);
	const hasDifferentSeries = new Set(seriesFiles.map(getSeriesKey)).size > 1;

	if (seriesFiles.length >= 2 && completeFiles.length > 0) {
		const keepFile = getPreferredFile(completeFiles);
		const keepPaths = new Set(keepFile ? [keepFile.path] : []);
		const selectedFiles = createUniqueFiles(
			files.filter(
				(file) =>
					!keepPaths.has(file.path) &&
					(hasSeriesToken(file) || isCompleteLikeFile(file)),
			),
		);

		if (keepFile && selectedFiles.length > 0) {
			return {
				caseLabel: "합본/완전판",
				title: "합쳐진 작품을 남기고 회차본을 정리하는 추천입니다.",
				description:
					"complete/final/합본 계열 표식이 있고 회차 표식 파일이 함께 있어, 합본 후보를 유지 대상으로 잡았습니다.",
				action: "trash",
				actionLabel: "추천 선택 적용",
				selectedFiles,
				keepFiles: [keepFile],
				reasons: ["합본 표식 발견", "회차본 동시 존재", "최신/큰 합본 우선"],
				confidenceLabel: "높음",
			};
		}
	}

	if (seriesFiles.length >= 2 && nonSeriesFiles.length > 0) {
		const keepFile = getPreferredFile(nonSeriesFiles);
		const largestSeriesSize = Math.max(...seriesFiles.map((file) => file.size));
		const seriesTotalSize = seriesFiles.reduce(
			(sum, file) => sum + file.size,
			0,
		);

		if (
			keepFile &&
			(keepFile.size >= largestSeriesSize * 1.35 ||
				keepFile.size >= seriesTotalSize * 0.55)
		) {
			return {
				caseLabel: "합본 의심",
				title: "단일 파일이 회차본을 대체했을 가능성이 있습니다.",
				description:
					"회차 표식이 있는 파일들과 표식 없는 큰 파일이 같이 있어, 큰 단일 파일을 유지 후보로 잡았습니다.",
				action: "trash",
				actionLabel: "추천 선택 적용",
				selectedFiles: createUniqueFiles(
					files.filter((file) => file.path !== keepFile.path),
				),
				keepFiles: [keepFile],
				reasons: ["회차본 + 단일 파일", "단일 파일 크기 우세"],
				confidenceLabel: "중간",
			};
		}
	}

	if (duplicateRecommendation.selectedFiles.length > 0) {
		return {
			caseLabel: "중복/업데이트",
			title:
				"같은 코드나 같은 회차 안에서 덜 유리한 파일을 정리하는 추천입니다.",
			description:
				"버전 표식, 수정일, 파일 크기, 메타데이터 완성도를 기준으로 유지 후보를 골랐습니다.",
			action: "trash",
			actionLabel: "추천 선택 적용",
			selectedFiles: duplicateRecommendation.selectedFiles,
			keepFiles: duplicateRecommendation.keepFiles,
			reasons: duplicateRecommendation.reasons,
			confidenceLabel: "높음",
		};
	}

	if (
		group.reasons.includes("버전 표식 차이") &&
		!hasDifferentSeries &&
		files.length >= 2
	) {
		const keepFile = getPreferredFile(files);
		if (keepFile) {
			return {
				caseLabel: "버전 차이",
				title:
					"같은 작품의 버전 차이로 보여 가장 유리한 파일을 유지 후보로 잡았습니다.",
				description:
					"uncensored/decensored/rev/digital 같은 버전 표식과 최신 수정일, 크기를 함께 봤습니다.",
				action: "trash",
				actionLabel: "추천 선택 적용",
				selectedFiles: files.filter((file) => file.path !== keepFile.path),
				keepFiles: [keepFile],
				reasons: ["버전 표식 차이", "최신/큰 파일 우선"],
				confidenceLabel: "중간",
			};
		}
	}

	if (hasDifferentSeries) {
		return {
			caseLabel: "시리즈물",
			title: "서로 다른 회차/권으로 보여 자동 삭제 추천은 하지 않습니다.",
			description:
				"회차나 권 표식이 서로 달라 하나의 시리즈로 묶는 작업을 우선 권장합니다.",
			action: "group",
			actionLabel: "_grouped로 묶기",
			selectedFiles: [],
			keepFiles: [],
			reasons: ["서로 다른 회차 표식", "삭제보다 그룹 묶기 우선"],
			confidenceLabel: "검토",
		};
	}

	return {
		caseLabel: "수동 검토",
		title: "자동으로 삭제 후보를 고르기에는 근거가 부족합니다.",
		description:
			"제목은 유사하지만 회차/합본/업데이트 신호가 약해 직접 확인하는 편이 안전합니다.",
		action: "review",
		actionLabel: "추천 없음",
		selectedFiles: [],
		keepFiles: [],
		reasons: ["근거 부족", "수동 검토 권장"],
		confidenceLabel: "검토",
	};
};

export const SimilarGroupPanel = (): React.JSX.Element => {
	const [sourcePath, setSourcePath] = useState<string | null>(null);
	const [recursive, setRecursive] = useState(true);
	const [minGroupSize, setMinGroupSize] = useState(
		String(DEFAULT_MIN_GROUP_SIZE),
	);
	const [minConfidence, setMinConfidence] = useState(
		String(DEFAULT_MIN_CONFIDENCE),
	);
	const [includeKeyword, setIncludeKeyword] = useState("");
	const [excludeKeyword, setExcludeKeyword] = useState("");
	const [groups, setGroups] = useState<SimilarGroup[]>([]);
	const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
	const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
	const [isScanning, setIsScanning] = useState(false);
	const [scanComplete, setScanComplete] = useState(false);
	const [scanProgress, setScanProgress] = useState<ScanArchiveProgress | null>(
		null,
	);
	const [cacheUsed, setCacheUsed] = useState(false);
	const [indexedAt, setIndexedAt] = useState<number | undefined>();
	const [scannedCount, setScannedCount] = useState(0);
	const [groupedFileCount, setGroupedFileCount] = useState(0);
	const [thumbnailEnabled, setThumbnailEnabled] = useState(false);
	const [thumbnailMap, setThumbnailMap] = useState<
		Record<string, ThumbnailEntry>
	>({});
	const thumbnailMapRef = useRef<Record<string, ThumbnailEntry>>({});
	const thumbnailRequestIdRef = useRef(0);

	const selectedGroup = useMemo(
		() => groups.find((group) => group.id === selectedGroupId) ?? null,
		[groups, selectedGroupId],
	);
	const recommendation = useMemo(
		() => (selectedGroup ? buildGroupRecommendation(selectedGroup) : null),
		[selectedGroup],
	);
	const recommendedSelectPathSet = useMemo(
		() => new Set(recommendation?.selectedFiles.map((file) => file.path) ?? []),
		[recommendation],
	);
	const recommendedKeepPathSet = useMemo(
		() => new Set(recommendation?.keepFiles.map((file) => file.path) ?? []),
		[recommendation],
	);

	useEffect(() => {
		let isCancelled = false;

		window.api.settings
			.get()
			.then((settings) => {
				if (isCancelled) {
					return;
				}

				const configuredStorePath = settings.storePath.trim();
				if (configuredStorePath) {
					setSourcePath((currentPath) => currentPath ?? configuredStorePath);
				}
			})
			.catch((error) => {
				console.error("저장소 경로를 불러오지 못했습니다:", error);
			});

		return () => {
			isCancelled = true;
		};
	}, []);

	useEffect(() => {
		const unsubscribe = window.api.fileOrganizer.onSimilarGroupsProgress(
			(progress) => {
				setScanProgress(progress);
			},
		);

		return unsubscribe;
	}, []);

	useEffect(() => {
		thumbnailMapRef.current = thumbnailMap;
	}, [thumbnailMap]);

	useEffect(() => {
		if (!thumbnailEnabled || !selectedGroup) {
			thumbnailRequestIdRef.current += 1;
			return;
		}

		const activeRequestId = thumbnailRequestIdRef.current;
		const targets = selectedGroup.files.filter((file) => {
			const entry = thumbnailMapRef.current[file.path];
			return (
				!entry?.thumbnail &&
				!(
					entry?.loadState === "loading" && entry.requestId === activeRequestId
				) &&
				entry?.loadState !== "failed"
			);
		});

		if (targets.length === 0) {
			return;
		}

		const requestId = thumbnailRequestIdRef.current + 1;
		thumbnailRequestIdRef.current = requestId;
		const loadingPaths = new Set(targets.map((file) => file.path));
		setThumbnailMap((currentMap) => {
			const nextMap = { ...currentMap };
			for (const file of targets) {
				nextMap[file.path] = { loadState: "loading", requestId };
			}
			return nextMap;
		});

		let nextIndex = 0;

		const loadThumbnail = async (file: SimilarGroupFile): Promise<void> => {
			let thumbnail: FileThumbnail | null = null;

			try {
				thumbnail = (await window.electron.ipcRenderer.invoke(
					"get-file-thumbnail",
					file.path,
				)) as FileThumbnail | null;
			} catch (error) {
				console.warn("유사 그룹 썸네일 로딩 실패:", file.path, error);
			}

			if (thumbnailRequestIdRef.current !== requestId) {
				return;
			}

			setThumbnailMap((currentMap) => ({
				...currentMap,
				[file.path]: thumbnail
					? { thumbnail }
					: { thumbnail: null, loadState: "failed" },
			}));
		};

		const workerCount = Math.min(6, targets.length);
		const workers = Array.from({ length: workerCount }, async () => {
			while (
				thumbnailRequestIdRef.current === requestId &&
				nextIndex < targets.length
			) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				const file = targets[currentIndex];

				if (file && loadingPaths.has(file.path)) {
					await loadThumbnail(file);
				}
			}
		});

		void Promise.all(workers);

		return () => {
			thumbnailRequestIdRef.current += 1;
		};
	}, [selectedGroup, thumbnailEnabled]);

	const resetResults = useCallback(() => {
		setGroups([]);
		setSelectedGroupId(null);
		setSelectedPaths(new Set());
		setScanComplete(false);
		setScanProgress(null);
		setCacheUsed(false);
		setIndexedAt(undefined);
		setScannedCount(0);
		setGroupedFileCount(0);
	}, []);

	const handleSelectPath = useCallback(async (): Promise<void> => {
		try {
			const selectedDirectory = await window.api.settings.selectDirectory();
			if (!selectedDirectory) {
				return;
			}

			setSourcePath(selectedDirectory);
			resetResults();
		} catch (error) {
			console.error("유사 그룹 폴더 선택 중 오류 발생:", error);
		}
	}, [resetResults]);

	const buildOptions = useCallback(
		(forceRefresh = false): SimilarGroupOptions | null => {
			if (!sourcePath) {
				alert("먼저 저장소 경로를 선택해주세요.");
				return null;
			}

			const parsedMinGroupSize = Number.parseInt(minGroupSize, 10);
			const parsedMinConfidence = Number.parseInt(minConfidence, 10);

			return {
				sourcePath,
				recursive,
				forceRefresh,
				minGroupSize: Number.isFinite(parsedMinGroupSize)
					? Math.max(2, parsedMinGroupSize)
					: DEFAULT_MIN_GROUP_SIZE,
				minConfidence: Number.isFinite(parsedMinConfidence)
					? Math.min(100, Math.max(0, parsedMinConfidence))
					: DEFAULT_MIN_CONFIDENCE,
				includeKeyword: includeKeyword.trim() || undefined,
				excludeKeyword: excludeKeyword.trim() || undefined,
			};
		},
		[
			excludeKeyword,
			includeKeyword,
			minConfidence,
			minGroupSize,
			recursive,
			sourcePath,
		],
	);

	const findGroups = useCallback(
		async (forceRefresh = false): Promise<void> => {
			const options = buildOptions(forceRefresh);
			if (!options) {
				return;
			}

			setIsScanning(true);
			setScanComplete(false);
			setGroups([]);
			setSelectedGroupId(null);
			setSelectedPaths(new Set());
			setScanProgress({
				phase: "searching",
				processed: 0,
				total: 1,
				foundFiles: 0,
				currentPath: options.sourcePath,
			});

			try {
				const result =
					await window.api.fileOrganizer.findSimilarGroups(options);
				setGroups(result.groups);
				setSelectedGroupId(result.groups[0]?.id ?? null);
				setCacheUsed(result.cacheUsed);
				setIndexedAt(result.indexedAt);
				setScannedCount(result.scannedCount);
				setGroupedFileCount(result.groupedFileCount);
				setScanComplete(true);
				setScanProgress({
					phase: "complete",
					processed: result.scannedCount,
					total: result.scannedCount,
					foundFiles: result.groups.length,
				});
			} catch (error) {
				console.error("유사 그룹 검색 실패:", error);
				alert(
					`유사 그룹 검색 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			} finally {
				setIsScanning(false);
			}
		},
		[buildOptions],
	);

	const removeProcessedPaths = useCallback((processedPaths: string[]) => {
		const processedPathSet = new Set(processedPaths);
		setGroups((currentGroups) => {
			const nextGroups = currentGroups
				.map((group) => ({
					...group,
					files: group.files.filter((file) => !processedPathSet.has(file.path)),
				}))
				.filter((group) => group.files.length >= 2)
				.map((group) => ({
					...group,
					totalSize: group.files.reduce((sum, file) => sum + file.size, 0),
				}));

			setSelectedGroupId((currentId) => {
				if (nextGroups.some((group) => group.id === currentId)) {
					return currentId;
				}

				return nextGroups[0]?.id ?? null;
			});

			return nextGroups;
		});
		setSelectedPaths(new Set());
	}, []);

	const handleFileChecked = useCallback(
		(filePath: string, checked: boolean) => {
			setSelectedPaths((currentPaths) => {
				const nextPaths = new Set(currentPaths);
				if (checked) {
					nextPaths.add(filePath);
				} else {
					nextPaths.delete(filePath);
				}
				return nextPaths;
			});
		},
		[],
	);

	const handleSelectAllInGroup = useCallback(() => {
		if (!selectedGroup) {
			return;
		}

		setSelectedPaths(new Set(selectedGroup.files.map((file) => file.path)));
	}, [selectedGroup]);

	const handleClearSelection = useCallback(() => {
		setSelectedPaths(new Set());
	}, []);

	const selectFilesByRule = useCallback(
		(files: SimilarGroupFile[], emptyMessage: string) => {
			if (files.length === 0) {
				alert(emptyMessage);
				return;
			}

			setSelectedPaths(new Set(files.map((file) => file.path)));
		},
		[],
	);

	const handleSelectSmallerFiles = useCallback(() => {
		if (!selectedGroup) {
			return;
		}

		const largestSize = Math.max(
			...selectedGroup.files.map((file) => file.size),
		);
		selectFilesByRule(
			selectedGroup.files.filter((file) => file.size < largestSize),
			"더 작은 파일을 찾지 못했습니다.",
		);
	}, [selectFilesByRule, selectedGroup]);

	const handleSelectOlderFiles = useCallback(() => {
		if (!selectedGroup) {
			return;
		}

		const filesWithDate = selectedGroup.files.filter(
			(file): file is SimilarGroupFile & { modifiedTimeMs: number } =>
				typeof file.modifiedTimeMs === "number",
		);
		const newestTime = Math.max(
			...filesWithDate.map((file) => file.modifiedTimeMs),
		);

		selectFilesByRule(
			filesWithDate.filter((file) => file.modifiedTimeMs < newestTime),
			"더 오래된 파일을 찾지 못했습니다.",
		);
	}, [selectFilesByRule, selectedGroup]);

	const handleOpenFile = useCallback(async (file: SimilarGroupFile) => {
		try {
			await window.electron.ipcRenderer.invoke(
				"open-with-bandiview",
				file.path,
			);
		} catch (error) {
			alert(
				`BandiView로 파일을 열 수 없습니다:\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		}
	}, []);

	const trashPaths = useCallback(
		async (paths: string[], label: string): Promise<void> => {
			if (paths.length === 0) {
				alert("처리할 파일을 선택해주세요.");
				return;
			}

			const confirmed = confirm(
				`${label} 휴지통으로 이동하시겠습니까?\n파일 ${paths.length}개`,
			);
			if (!confirmed) {
				return;
			}

			const result = await window.api.fileOrganizer.trashFiles(paths);
			const successPaths = result.results
				.filter((item) => item.success)
				.map((item) => item.path);
			removeProcessedPaths(successPaths);
			alert(getOperationMessage(result, "휴지통 이동 완료"));
		},
		[removeProcessedPaths],
	);

	const handleTrashSelected = useCallback(async (): Promise<void> => {
		await trashPaths(Array.from(selectedPaths), "선택 파일을");
	}, [selectedPaths, trashPaths]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent): void => {
			if (
				event.key !== "Delete" ||
				event.repeat ||
				event.shiftKey ||
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				isScanning ||
				selectedPaths.size === 0 ||
				isEditableTarget(event.target)
			) {
				return;
			}

			event.preventDefault();
			void trashPaths(Array.from(selectedPaths), "선택 파일을");
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [isScanning, selectedPaths, trashPaths]);

	const handleTrashGroup = useCallback(async (): Promise<void> => {
		if (!selectedGroup) {
			return;
		}

		await trashPaths(
			selectedGroup.files.map((file) => file.path),
			"그룹 전체를",
		);
	}, [selectedGroup, trashPaths]);

	const handleMoveGroup = useCallback(async (): Promise<void> => {
		if (!selectedGroup || !sourcePath) {
			return;
		}

		const confirmed = confirm(
			`그룹 전체를 _grouped 폴더로 묶으시겠습니까?\n파일 ${selectedGroup.files.length}개`,
		);
		if (!confirmed) {
			return;
		}

		const result = await window.api.fileOrganizer.moveGroupToFolder(
			sourcePath,
			selectedGroup.files.map((file) => file.path),
			getGroupFolderName(selectedGroup),
		);
		const successPaths = result.results
			.filter((item) => item.success)
			.map((item) => item.path);
		removeProcessedPaths(successPaths);
		alert(getOperationMessage(result, "_grouped 이동 완료"));
	}, [removeProcessedPaths, selectedGroup, sourcePath]);

	const handleApplyRecommendation = useCallback(async (): Promise<void> => {
		if (!recommendation) {
			return;
		}

		if (recommendation.action === "group") {
			await handleMoveGroup();
			return;
		}

		if (recommendation.selectedFiles.length === 0) {
			alert(recommendation.description);
			return;
		}

		setSelectedPaths(
			new Set(recommendation.selectedFiles.map((file) => file.path)),
		);
	}, [handleMoveGroup, recommendation]);

	const selectedFileCount = selectedPaths.size;
	const recommendationCleanupCount = recommendation?.selectedFiles.length ?? 0;
	const recommendationKeepCount = recommendation?.keepFiles.length ?? 0;
	const canApplyTrashRecommendation =
		recommendation?.action === "trash" &&
		recommendation.selectedFiles.length > 0;
	const renderThumbnail = (file: SimilarGroupFile): React.JSX.Element => {
		const entry = thumbnailMap[file.path];

		if (entry?.thumbnail) {
			const isIcon = entry.thumbnail.source === "file-icon";
			return (
				<div
					className={`flex h-20 w-16 items-center justify-center overflow-hidden rounded border border-base-content/10 bg-base-200 ${
						isIcon ? "p-4" : ""
					}`}
				>
					<img
						src={entry.thumbnail.dataUrl}
						alt={`${file.name} 썸네일`}
						className={`h-full w-full ${isIcon ? "object-contain" : "object-cover"}`}
						loading="lazy"
					/>
				</div>
			);
		}

		if (entry?.loadState === "loading") {
			return (
				<div className="flex h-20 w-16 items-center justify-center rounded border border-base-content/10 bg-base-200">
					<span className="loading loading-spinner loading-sm" />
				</div>
			);
		}

		return (
			<div className="flex h-20 w-16 items-center justify-center rounded border border-dashed border-base-content/20 bg-base-200 text-[11px] text-base-content/45">
				없음
			</div>
		);
	};

	return (
		<div className="flex h-0 flex-auto flex-col gap-3 overflow-hidden">
			<div className="card flex-shrink-0 bg-base-100 shadow-sm">
				<div className="card-body gap-3 p-3">
					<div className="flex flex-col gap-3 xl:flex-row xl:items-end">
						<div className="min-w-0 flex-1">
							<div className="mb-1 flex items-center gap-2 text-[11px] text-base-content/55">
								<span className="badge badge-ghost badge-sm">저장소 경로</span>
								<span>{sourcePath ? "선택됨" : "선택 필요"}</span>
							</div>
							<input
								className="input input-sm input-bordered w-full font-mono text-xs"
								type="text"
								value={sourcePath ?? ""}
								placeholder="설정의 저장소 경로를 불러오거나 폴더를 선택하세요"
								readOnly
							/>
						</div>
						<div className="flex flex-wrap gap-2">
							<button
								type="button"
								className="btn btn-sm btn-outline"
								onClick={handleSelectPath}
								disabled={isScanning}
							>
								폴더 선택
							</button>
							<button
								type="button"
								className="btn btn-sm btn-primary"
								onClick={() => findGroups()}
								disabled={!sourcePath || isScanning}
							>
								{isScanning ? (
									<>
										<span className="loading loading-spinner loading-xs" />
										검색 중
									</>
								) : (
									"그룹 검색"
								)}
							</button>
							<button
								type="button"
								className="btn btn-sm btn-outline"
								onClick={() => findGroups(true)}
								disabled={!sourcePath || isScanning}
							>
								인덱스 새로고침
							</button>
						</div>
					</div>

					<div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								최소 그룹 크기
							</span>
							<input
								className="input input-sm input-bordered"
								type="number"
								min="2"
								value={minGroupSize}
								disabled={isScanning}
								onChange={(event) => setMinGroupSize(event.target.value)}
							/>
						</label>
						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								최소 confidence
							</span>
							<input
								className="input input-sm input-bordered"
								type="number"
								min="0"
								max="100"
								value={minConfidence}
								disabled={isScanning}
								onChange={(event) => setMinConfidence(event.target.value)}
							/>
						</label>
						<label className="form-control xl:col-span-2">
							<span className="label py-1 text-[11px] text-base-content/60">
								포함 키워드
							</span>
							<input
								className="input input-sm input-bordered"
								type="text"
								value={includeKeyword}
								placeholder="파일명/경로/작가"
								disabled={isScanning}
								onChange={(event) => setIncludeKeyword(event.target.value)}
							/>
						</label>
						<label className="form-control xl:col-span-2">
							<span className="label py-1 text-[11px] text-base-content/60">
								제외 키워드
							</span>
							<input
								className="input input-sm input-bordered"
								type="text"
								value={excludeKeyword}
								placeholder="파일명/경로/작가"
								disabled={isScanning}
								onChange={(event) => setExcludeKeyword(event.target.value)}
							/>
						</label>
					</div>

					<div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
						<label className="flex h-8 cursor-pointer items-center gap-2 rounded-btn border border-base-300 bg-base-100 px-3">
							<span className="text-xs font-semibold text-base-content/70">
								하위 폴더
							</span>
							<input
								type="checkbox"
								className="toggle toggle-primary toggle-sm"
								checked={recursive}
								disabled={isScanning}
								aria-label="하위 폴더 포함"
								onChange={(event) => setRecursive(event.target.checked)}
							/>
						</label>
						{scanComplete && (
							<>
								<div
									className={`badge badge-sm ${cacheUsed ? "badge-success" : "badge-info"}`}
								>
									{cacheUsed ? "캐시 사용" : "인덱스 갱신"}
								</div>
								<div className="badge badge-ghost badge-sm">
									그룹 {groups.length}개
								</div>
								<div className="badge badge-ghost badge-sm">
									그룹 파일 {groupedFileCount}개
								</div>
								<div className="badge badge-ghost badge-sm">
									스캔 {scannedCount}개
								</div>
								<div className="badge badge-ghost badge-sm">
									갱신 {formatIndexedAt(indexedAt)}
								</div>
							</>
						)}
					</div>
				</div>
			</div>

			{isScanning && <LoadingState progress={scanProgress} />}

			{!isScanning && !scanComplete && (
				<div className="flex flex-1 items-center justify-center text-sm text-base-content/55">
					저장소를 선택하고 그룹 검색을 실행하세요.
				</div>
			)}

			{!isScanning && scanComplete && groups.length === 0 && (
				<div className="card bg-base-100 shadow-sm">
					<div className="card-body p-4">
						<div className="text-sm font-semibold">유사 그룹 없음</div>
						<div className="text-xs text-base-content/65">
							현재 조건에서 묶을 만한 파일 그룹을 찾지 못했습니다.
						</div>
					</div>
				</div>
			)}

			{!isScanning && scanComplete && groups.length > 0 && (
				<div className="grid h-0 min-h-0 flex-auto gap-3 overflow-hidden lg:grid-cols-[minmax(280px,0.88fr)_minmax(420px,1.5fr)]">
					<div className="card flex h-full min-h-0 flex-col overflow-hidden bg-base-100 shadow-sm">
						<div className="card-body flex min-h-0 flex-col overflow-hidden p-3">
							<div className="mb-2 flex items-center justify-between gap-2">
								<div className="text-sm font-semibold">그룹 목록</div>
								<div className="badge badge-neutral badge-sm">
									{groups.length}개
								</div>
							</div>
							<div className="h-0 min-h-0 flex-auto overflow-hidden">
								<div className="h-full overflow-auto pr-1">
									<div className="flex flex-col gap-1.5">
										{groups.map((group) => {
											const isSelected = group.id === selectedGroupId;

											return (
												<button
													type="button"
													key={group.id}
													className={`rounded-box border px-2.5 py-2 text-left transition-colors ${
														isSelected
															? "border-primary/60 bg-primary/5"
															: "border-base-content/10 hover:border-primary/30"
													}`}
													onClick={() => {
														setSelectedGroupId(group.id);
														setSelectedPaths(new Set());
													}}
												>
													<div className="flex items-start justify-between gap-2">
														<div className="min-w-0">
															<div className="truncate text-sm font-semibold">
																{group.representativeTitle}
															</div>
															<div className="mt-0.5 truncate text-[11px] text-base-content/55">
																{group.artist || "-"} · {group.type || "-"} ·{" "}
																{group.origin || "-"}
															</div>
														</div>
														<div className="badge badge-primary badge-sm">
															{group.confidence}
														</div>
													</div>
													<div className="mt-1.5 flex flex-wrap gap-1">
														<div className="badge badge-ghost badge-sm">
															{group.files.length}개
														</div>
														<div className="badge badge-ghost badge-sm">
															{formatFileSize(group.totalSize)}
														</div>
														{group.reasons.slice(0, 2).map((reason) => (
															<div
																key={`${group.id}-${reason}`}
																className="badge badge-outline badge-sm"
															>
																{reason}
															</div>
														))}
													</div>
												</button>
											);
										})}
									</div>
								</div>
							</div>
						</div>
					</div>

					<div className="card flex h-full min-h-0 flex-col overflow-hidden bg-base-100 shadow-sm">
						<div className="card-body flex min-h-0 flex-col gap-2 overflow-hidden p-3">
							{selectedGroup ? (
								<>
									<div className="rounded-box border border-base-content/10 bg-base-100 px-3 py-2">
										<div className="flex min-w-0 flex-wrap items-center gap-2">
											<div className="min-w-40 flex-1 truncate text-sm font-semibold">
												{selectedGroup.representativeTitle}
											</div>
											<div className="badge badge-primary badge-sm">
												{selectedGroup.confidence}
											</div>
											<div className="badge badge-ghost badge-sm">
												{selectedGroup.files.length}개
											</div>
											<div className="badge badge-ghost badge-sm">
												{formatFileSize(selectedGroup.totalSize)}
											</div>
											<div className="badge badge-ghost badge-sm">
												선택 {selectedFileCount}
											</div>
										</div>
										<div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
											<span className="mr-1 min-w-32 truncate text-[11px] text-base-content/55">
												{selectedGroup.artist || "-"} ·{" "}
												{selectedGroup.type || "-"} ·{" "}
												{selectedGroup.origin || "-"}
											</span>
											{selectedGroup.reasons.slice(0, 4).map((reason) => (
												<span
													key={`${selectedGroup.id}-${reason}`}
													className="badge badge-outline badge-xs"
												>
													{reason}
												</span>
											))}
										</div>
									</div>

									<div className="flex flex-col gap-1.5">
										<div className="rounded-box border border-base-content/10 bg-base-100 px-2.5 py-1.5">
											<div className="flex min-w-0 flex-wrap items-center gap-1.5">
												<div className="badge badge-neutral badge-xs">
													추천 {recommendation?.caseLabel ?? "없음"}
												</div>
												<div className="badge badge-ghost badge-xs">
													신뢰 {recommendation?.confidenceLabel ?? "검토"}
												</div>
												<div className="min-w-48 flex-1 truncate text-[11px] font-medium text-base-content/75">
													{recommendation?.title}
												</div>
												<div className="badge badge-warning badge-xs">
													정리 {recommendationCleanupCount}개
												</div>
												<div className="badge badge-success badge-xs">
													유지 {recommendationKeepCount}개
												</div>
												{recommendation?.reasons.slice(0, 3).map((reason) => (
													<span
														key={`${selectedGroup.id}-recommend-${reason}`}
														className="badge badge-outline badge-xs"
													>
														{reason}
													</span>
												))}
											</div>
										</div>

										<div className="rounded-box border border-base-content/10 bg-base-100 px-2.5 py-1.5">
											<div className="flex flex-wrap items-center gap-1.5">
												<div className="flex items-center gap-1">
													<span className="px-1 text-[11px] font-semibold text-base-content/55">
														자동 선택
													</span>
													{canApplyTrashRecommendation && (
														<button
															type="button"
															className="btn btn-xs btn-primary"
															onClick={handleApplyRecommendation}
														>
															추천 선택
														</button>
													)}
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={handleSelectSmallerFiles}
													>
														더 작은 파일
													</button>
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={handleSelectOlderFiles}
													>
														더 오래된 파일
													</button>
												</div>

												<div className="h-5 w-px bg-base-content/15" />

												<div className="flex items-center gap-1">
													<span className="px-1 text-[11px] font-semibold text-base-content/55">
														보기
													</span>
													<label className="flex h-6 cursor-pointer items-center gap-1.5 rounded-btn border border-base-300 bg-base-100 px-2">
														<span className="text-[11px] font-semibold text-base-content/70">
															썸네일
														</span>
														<input
															type="checkbox"
															className="toggle toggle-primary toggle-xs"
															checked={thumbnailEnabled}
															aria-label="유사 그룹 썸네일 표시"
															onChange={(event) =>
																setThumbnailEnabled(event.target.checked)
															}
														/>
													</label>
												</div>

												<div className="h-5 w-px bg-base-content/15" />

												<div className="flex items-center gap-1">
													<span className="px-1 text-[11px] font-semibold text-base-content/55">
														선택
													</span>
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={handleSelectAllInGroup}
													>
														전체
													</button>
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={handleClearSelection}
														disabled={selectedFileCount === 0}
													>
														해제
													</button>
												</div>

												<div className="h-5 w-px bg-base-content/15" />

												<div className="flex items-center gap-1">
													<span className="px-1 text-[11px] font-semibold text-base-content/55">
														작업
													</span>
													<button
														type="button"
														className="btn btn-xs btn-outline text-error"
														title="Delete 키로도 선택 파일을 휴지통으로 이동할 수 있습니다."
														onClick={handleTrashSelected}
														disabled={selectedFileCount === 0}
													>
														<TrashIcon className="h-3.5 w-3.5" />
														선택 휴지통
													</button>
													<button
														type="button"
														className="btn btn-xs btn-outline text-error"
														onClick={handleTrashGroup}
													>
														<TrashIcon className="h-3.5 w-3.5" />
														그룹 휴지통
													</button>
													<button
														type="button"
														className="btn btn-xs btn-primary"
														onClick={handleMoveGroup}
													>
														<FolderIcon className="h-3.5 w-3.5" />
														_grouped로 묶기
													</button>
												</div>
											</div>
										</div>
									</div>

									<div className="h-0 min-h-0 flex-auto overflow-hidden rounded-box border border-base-content/10">
										<div className="h-full overflow-auto">
											<table className="table table-pin-rows table-xs table-fixed w-full">
												<thead>
													<tr>
														<th className="w-10" />
														{thumbnailEnabled && (
															<th className="w-20">썸네일</th>
														)}
														<th
															className={
																thumbnailEnabled ? "w-[24%]" : "w-[28%]"
															}
														>
															파일명
														</th>
														<th className="hidden w-[24%] lg:table-cell">
															경로
														</th>
														<th className="hidden w-[10%] md:table-cell">
															코드
														</th>
														<th className="hidden w-[14%] xl:table-cell">
															토큰
														</th>
														<th className="w-[10%]">크기</th>
														<th className="hidden w-[10%] md:table-cell">
															수정일
														</th>
														<th className="w-12">열기</th>
													</tr>
												</thead>
												<tbody>
													{selectedGroup.files.map((file) => {
														const isRecommendedSelect =
															recommendedSelectPathSet.has(file.path);
														const isRecommendedKeep =
															recommendedKeepPathSet.has(file.path);

														return (
															<tr
																key={file.path}
																className={`hover ${
																	isRecommendedSelect
																		? "bg-warning/10"
																		: isRecommendedKeep
																			? "bg-success/10"
																			: ""
																}`}
															>
																<td>
																	<input
																		type="checkbox"
																		className="checkbox checkbox-sm"
																		checked={selectedPaths.has(file.path)}
																		aria-label={`${file.name} 선택`}
																		onChange={(event) =>
																			handleFileChecked(
																				file.path,
																				event.target.checked,
																			)
																		}
																	/>
																</td>
																{thumbnailEnabled && (
																	<td>{renderThumbnail(file)}</td>
																)}
																<td>
																	<div
																		className="truncate font-medium"
																		title={file.name}
																	>
																		{file.name}
																	</div>
																	<div className="mt-1 flex min-w-0 items-center gap-1">
																		{isRecommendedSelect && (
																			<span className="badge badge-warning badge-xs">
																				추천 정리
																			</span>
																		)}
																		{isRecommendedKeep && (
																			<span className="badge badge-success badge-xs">
																				유지 후보
																			</span>
																		)}
																		<span className="truncate text-[11px] text-base-content/50">
																			{file.title}
																		</span>
																	</div>
																</td>
																<td className="hidden lg:table-cell">
																	<div
																		className="truncate font-mono text-[11px] text-base-content/60"
																		title={file.relativePath}
																	>
																		{file.relativePath}
																	</div>
																</td>
																<td className="hidden md:table-cell">
																	<div className="truncate font-mono text-xs">
																		{file.code || "-"}
																	</div>
																</td>
																<td className="hidden xl:table-cell">
																	<div className="flex flex-wrap gap-1">
																		{[
																			...file.seriesTokens,
																			...file.editionTokens,
																		]
																			.slice(0, 3)
																			.map((token) => (
																				<span
																					key={`${file.path}-${token}`}
																					className="badge badge-ghost badge-xs"
																				>
																					{token}
																				</span>
																			))}
																	</div>
																</td>
																<td>
																	<div className="badge badge-ghost badge-xs">
																		{formatFileSize(file.size)}
																	</div>
																</td>
																<td className="hidden md:table-cell">
																	<div className="text-xs text-base-content/70">
																		{formatDate(file.modifiedTimeMs)}
																	</div>
																</td>
																<td>
																	<button
																		type="button"
																		className="btn btn-xs btn-ghost btn-square"
																		title="BandiView로 열기"
																		onClick={() => handleOpenFile(file)}
																	>
																		<ExternalLinkIcon className="h-4 w-4" />
																	</button>
																</td>
															</tr>
														);
													})}
												</tbody>
											</table>
										</div>
									</div>
								</>
							) : (
								<div className="flex flex-1 items-center justify-center text-sm text-base-content/55">
									그룹을 선택하세요.
								</div>
							)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
};
