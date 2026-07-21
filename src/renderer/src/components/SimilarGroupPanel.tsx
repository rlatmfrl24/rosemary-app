import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	ArchiveContentScanMode,
	FileThumbnail,
	GroupedFolderMigrationPreview,
	ScanArchiveProgress,
	SimilarGroup,
	SimilarGroupFile,
	SimilarGroupOptions,
	SimilarGroupQueue,
} from "../../../shared/file-organizer";
import { formatFileSize } from "../utils/file";
import { ExternalLinkIcon, FolderIcon, TrashIcon } from "./Icons";
import { LoadingState } from "./LoadingState";

const DEFAULT_MIN_GROUP_SIZE = 2;
const DEFAULT_MIN_CONFIDENCE = 90;
const CONTENT_SCAN_OPTIONS: Array<{
	value: ArchiveContentScanMode;
	label: string;
}> = [
	{ value: "smart", label: "스마트 샘플" },
	{ value: "metadata", label: "메타데이터" },
	{ value: "sample", label: "전체 샘플" },
	{ value: "off", label: "끔" },
];
const QUEUE_OPTIONS: Array<{ value: SimilarGroupQueue; label: string }> = [
	{ value: "cleanup", label: "중복/업데이트" },
	{ value: "series", label: "시리즈/합본" },
	{ value: "merge", label: "편입 후보" },
	{ value: "suspicious", label: "의심 후보" },
];
const QUEUE_LABELS: Record<Exclude<SimilarGroupQueue, "safe">, string> = {
	cleanup: "중복/업데이트",
	series: "시리즈/합본",
	merge: "편입 후보",
	suspicious: "의심 후보",
};
const ACTION_LABELS: Record<SimilarGroup["recommendationAction"], string> = {
	trash: "삭제 검토",
	group: "그룹 묶기",
	merge: "기존 그룹 편입",
	review: "수동 검토",
};
const createEmptyQueueCounts = (): Record<SimilarGroupQueue, number> => ({
	safe: 0,
	cleanup: 0,
	series: 0,
	merge: 0,
	suspicious: 0,
});

interface ThumbnailEntry {
	thumbnail?: FileThumbnail | null;
	loadState?: "loading" | "failed";
	requestId?: number;
}

type RecommendationAction = "trash" | "group" | "merge" | "review";

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
	result: { summary: { total: number; success: number; failed: number } },
	successLabel: string,
): string =>
	result.summary.failed === 0
		? `${successLabel}\n처리: ${result.summary.success}/${result.summary.total}개`
		: `${successLabel} 일부 실패\n성공: ${result.summary.success}개\n실패: ${result.summary.failed}개`;

const getContentScanModeLabel = (mode: ArchiveContentScanMode): string =>
	CONTENT_SCAN_OPTIONS.find((option) => option.value === mode)?.label ?? mode;

const getContentBadges = (
	file: SimilarGroupFile,
	group: SimilarGroup,
): Array<{ label: string; className: string; title?: string }> => {
	const content = file.content;
	if (!content) {
		return [];
	}

	if (content.status === "failed") {
		return [
			{
				label: "내용 실패",
				className: "badge-error",
				title: content.scanError,
			},
		];
	}

	if (content.status === "unsupported") {
		return [];
	}

	const badges: Array<{ label: string; className: string; title?: string }> =
		[];
	if (content.imageCount > 0) {
		badges.push({
			label: `이미지 ${content.imageCount}장`,
			className: "badge-ghost",
			title: `압축 전 ${formatFileSize(content.totalUncompressedSize)}`,
		});
	}

	if (group.reasons.includes("압축 내용 동일")) {
		badges.push({ label: "내용 동일", className: "badge-success" });
	}

	if (group.reasons.includes("샘플 이미지 일치")) {
		badges.push({ label: "샘플 일치", className: "badge-info" });
	}

	if (group.reasons.includes("내용 일부 중복")) {
		badges.push({ label: "일부 중복", className: "badge-warning" });
	}

	return badges;
};

const getGroupFolderName = (group: SimilarGroup): string =>
	`${group.artist ? `${group.artist} - ` : ""}${group.representativeTitle}`;

const getComparableLength = (value: string | undefined): number =>
	(value ?? "")
		.normalize("NFKC")
		.replace(/[^0-9a-zA-Z가-힣ぁ-んァ-ン一-龥]/g, "").length;

const COMPLETE_TEXT_PATTERN =
	/\b(?:complete|final|compilation|compiled|collection|all in one)\b|완전판|합본|총집편|총集編|総集編|合集|まとめ/i;
const SIGNIFICANT_SIZE_RATIO = 1.35;
const SIGNIFICANT_SIZE_DELTA_BYTES = 20 * 1024 * 1024;

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

const getComparableVolume = (file: SimilarGroupFile): number =>
	file.content?.totalUncompressedSize && file.content.totalUncompressedSize > 0
		? file.content.totalUncompressedSize
		: file.size;

const hasContentPageAdvantage = (
	larger: SimilarGroupFile,
	smaller: SimilarGroupFile,
): boolean => {
	const largerImageCount = larger.content?.imageCount ?? 0;
	const smallerImageCount = smaller.content?.imageCount ?? 0;

	return (
		largerImageCount > smallerImageCount &&
		(largerImageCount >= smallerImageCount + 5 ||
			largerImageCount >= smallerImageCount * 1.2)
	);
};

const hasSignificantSizeAdvantage = (
	larger: SimilarGroupFile,
	smaller: SimilarGroupFile,
): boolean =>
	hasContentPageAdvantage(larger, smaller) ||
	(getComparableVolume(larger) > getComparableVolume(smaller) &&
		(getComparableVolume(larger) >=
			getComparableVolume(smaller) * SIGNIFICANT_SIZE_RATIO ||
			getComparableVolume(larger) - getComparableVolume(smaller) >=
				SIGNIFICANT_SIZE_DELTA_BYTES));

const getDominantLargestFile = (
	files: SimilarGroupFile[],
): SimilarGroupFile | undefined => {
	const sortedFiles = [...files].sort(
		(left, right) => getComparableVolume(right) - getComparableVolume(left),
	);
	const largestFile = sortedFiles[0];
	const secondLargestFile = sortedFiles[1];

	if (
		!largestFile ||
		!secondLargestFile ||
		!hasSignificantSizeAdvantage(largestFile, secondLargestFile)
	) {
		return undefined;
	}

	return largestFile;
};

const sortByPreferredFile = (files: SimilarGroupFile[]): SimilarGroupFile[] =>
	[...files].sort((left, right) => {
		if (hasSignificantSizeAdvantage(right, left)) {
			return 1;
		}

		if (hasSignificantSizeAdvantage(left, right)) {
			return -1;
		}

		const editionDelta = getEditionScore(right) - getEditionScore(left);
		if (editionDelta !== 0) {
			return editionDelta;
		}

		const modifiedDelta =
			(right.modifiedTimeMs ?? 0) - (left.modifiedTimeMs ?? 0);
		if (modifiedDelta !== 0) {
			return modifiedDelta;
		}

		const sizeDelta = getComparableVolume(right) - getComparableVolume(left);
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

		if (file.content?.contentFingerprint) {
			const contentKey = `content:${file.content.contentFingerprint}`;
			buckets.set(contentKey, [...(buckets.get(contentKey) ?? []), file]);
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

	for (const [bucketKey, bucketFiles] of buckets.entries()) {
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
			bucketKey.startsWith("content:")
				? "압축 내용 동일"
				: bucketFiles.some((file) => file.code)
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
	const duplicateRecommendation = getDuplicateRecommendation(files);
	const hasDifferentSeries = new Set(seriesFiles.map(getSeriesKey)).size > 1;
	const dominantLargestFile =
		group.recommendationAction === "trash" && !hasDifferentSeries
			? getDominantLargestFile(files)
			: undefined;
	const hasCompilationSignal =
		files.some(isCompleteLikeFile) ||
		(seriesFiles.length >= 2 && files.some((file) => !hasSeriesToken(file)));

	if (group.recommendationAction === "merge") {
		return {
			caseLabel: "기존 그룹 편입",
			title: "이미 정리된 기존 그룹에 추가될 가능성이 있습니다.",
			description:
				"기존 _grouped 폴더의 작가/제목/코드 정보와 매칭되어 편입 후보로 분류했습니다.",
			action: "merge",
			actionLabel: "기존 그룹 편입",
			selectedFiles: [],
			keepFiles: [],
			reasons: group.reasons,
			confidenceLabel: group.confidence >= 96 ? "높음" : "중간",
		};
	}

	if (group.recommendationAction === "review") {
		return {
			caseLabel: "의심 후보",
			title: "자동 작업을 추천하기에는 근거가 부족합니다.",
			description:
				"제목 유사도만 높거나 토큰 차이가 약해 의심 후보로 분류했습니다.",
			action: "review",
			actionLabel: "추천 없음",
			selectedFiles: [],
			keepFiles: [],
			reasons: group.reasons,
			confidenceLabel: "검토",
		};
	}

	if (group.recommendationAction === "group") {
		return {
			caseLabel: hasCompilationSignal ? "시리즈/합본" : "시리즈물",
			title: hasCompilationSignal
				? "합본 가능성이 있어도 자동 삭제보다 그룹 묶기를 우선합니다."
				: "서로 다른 회차/권으로 보여 그룹 묶기를 권장합니다.",
			description:
				"후속 회차, 권/part, 합본 가능성이 섞인 후보는 파일 삭제가 아니라 같은 계층의 그룹 폴더로 정리합니다.",
			action: "group",
			actionLabel: "_grouped로 묶기",
			selectedFiles: [],
			keepFiles: [],
			reasons: Array.from(
				new Set([...group.reasons, "삭제보다 그룹 묶기 우선"]),
			),
			confidenceLabel: group.confidence >= 92 ? "중간" : "검토",
		};
	}

	if (dominantLargestFile) {
		const dominantContent = dominantLargestFile.content;
		const preserveLabel =
			dominantContent && dominantContent.imageCount > 0
				? `${dominantContent.imageCount}장 / ${formatFileSize(dominantContent.totalUncompressedSize)} 보존`
				: `${formatFileSize(dominantLargestFile.size)} 보존`;

		return {
			caseLabel: "대용량/확장판",
			title: `${preserveLabel}: 더 큰 파일을 유지 후보로 잡았습니다.`,
			description:
				"같은 제목 후보 안에서 페이지 수나 압축 전 용량 차이가 큰 경우, 작은 파일은 누락/구버전일 가능성이 높아 큰 파일 보존을 우선합니다.",
			action: "trash",
			actionLabel: "추천 선택",
			selectedFiles: createUniqueFiles(
				files.filter((file) => file.path !== dominantLargestFile.path),
			),
			keepFiles: [dominantLargestFile],
			reasons: Array.from(
				new Set(["페이지/용량 우선", "누락/구버전 가능성", ...group.reasons]),
			),
			confidenceLabel: "중간",
		};
	}

	if (duplicateRecommendation.selectedFiles.length > 0) {
		return {
			caseLabel: "중복/업데이트",
			title:
				"같은 코드나 같은 회차 안에서 덜 유리한 파일을 정리하는 추천입니다.",
			description:
				"버전 표식, 수정일, 파일 크기, 메타데이터 완성도를 기준으로 유지 후보를 골랐습니다.",
			action: "trash",
			actionLabel: "추천 선택",
			selectedFiles: duplicateRecommendation.selectedFiles,
			keepFiles: duplicateRecommendation.keepFiles,
			reasons: duplicateRecommendation.reasons,
			confidenceLabel: "높음",
		};
	}

	if (
		group.recommendationAction === "trash" &&
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
				actionLabel: "추천 선택",
				selectedFiles: files.filter((file) => file.path !== keepFile.path),
				keepFiles: [keepFile],
				reasons: ["버전 표식 차이", "최신/큰 파일 우선"],
				confidenceLabel: "중간",
			};
		}
	}

	return {
		caseLabel: "중복/업데이트",
		title: "정리 후보지만 자동 선택 근거가 부족합니다.",
		description:
			"후보 분류는 정리 대상이지만 같은 코드, 같은 회차, 버전 차이를 확정하지 못해 직접 선택이 필요합니다.",
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
	const [contentScanMode, setContentScanMode] =
		useState<ArchiveContentScanMode>("smart");
	const [selectedQueue, setSelectedQueue] =
		useState<SimilarGroupQueue>("cleanup");
	const [includeReviewed, setIncludeReviewed] = useState(false);
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
	const [countsByQueue, setCountsByQueue] = useState<
		Record<SimilarGroupQueue, number>
	>(createEmptyQueueCounts);
	const [hiddenReviewedCount, setHiddenReviewedCount] = useState(0);
	const [hiddenSuspiciousCount, setHiddenSuspiciousCount] = useState(0);
	const [migrationPreview, setMigrationPreview] =
		useState<GroupedFolderMigrationPreview | null>(null);
	const [isMigrationLoading, setIsMigrationLoading] = useState(false);
	const [isMigrationExecuting, setIsMigrationExecuting] = useState(false);
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
		setCountsByQueue(createEmptyQueueCounts());
		setHiddenReviewedCount(0);
		setHiddenSuspiciousCount(0);
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
		(
			forceRefresh = false,
			overrides: Partial<SimilarGroupOptions> = {},
		): SimilarGroupOptions | null => {
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
				queue: selectedQueue,
				includeReviewed,
				includeSuspicious: selectedQueue === "suspicious",
				contentScanMode,
				...overrides,
			};
		},
		[
			contentScanMode,
			includeReviewed,
			minConfidence,
			minGroupSize,
			recursive,
			selectedQueue,
			sourcePath,
		],
	);

	const findGroups = useCallback(
		async (
			forceRefresh = false,
			overrides: Partial<SimilarGroupOptions> = {},
		): Promise<void> => {
			const options = buildOptions(forceRefresh, overrides);
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
				setCountsByQueue(result.countsByQueue);
				setHiddenReviewedCount(result.hiddenReviewedCount);
				setHiddenSuspiciousCount(result.hiddenSuspiciousCount);
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

	const handleQueueChange = useCallback(
		(nextQueue: SimilarGroupQueue): void => {
			setSelectedQueue(nextQueue);
			if (scanComplete) {
				void findGroups(false, {
					queue: nextQueue,
					includeSuspicious: nextQueue === "suspicious",
				});
			}
		},
		[findGroups, scanComplete],
	);

	const handleIncludeReviewedChange = useCallback(
		(nextValue: boolean): void => {
			setIncludeReviewed(nextValue);
			if (scanComplete) {
				void findGroups(false, {
					includeReviewed: nextValue,
				});
			}
		},
		[findGroups, scanComplete],
	);

	const removeProcessedPaths = useCallback((processedPaths: string[]) => {
		const processedPathSet = new Set(processedPaths);
		setGroups((currentGroups) => {
			const nextGroups = currentGroups
				.map((group) => ({
					...group,
					files: group.files.filter((file) => !processedPathSet.has(file.path)),
				}))
				.filter((group) =>
					group.queue === "merge"
						? group.files.length >= 1
						: group.files.length >= 2,
				)
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

	const removeReviewedGroup = useCallback(
		(reviewKey: string, contentSignature: string) => {
			setGroups((currentGroups) => {
				const nextGroups = currentGroups.filter(
					(group) =>
						group.reviewKey !== reviewKey ||
						group.contentSignature !== contentSignature,
				);

				setSelectedGroupId((currentId) => {
					if (nextGroups.some((group) => group.id === currentId)) {
						return currentId;
					}

					return nextGroups[0]?.id ?? null;
				});

				return nextGroups;
			});
			setSelectedPaths(new Set());
		},
		[],
	);

	const markSelectedGroupReviewState = useCallback(
		async (status: "ignored" | "confirmed"): Promise<void> => {
			if (!selectedGroup) {
				return;
			}

			await window.api.fileOrganizer.markSimilarGroupReviewState({
				reviewKey: selectedGroup.reviewKey,
				contentSignature: selectedGroup.contentSignature,
				status,
			});
			removeReviewedGroup(
				selectedGroup.reviewKey,
				selectedGroup.contentSignature,
			);
		},
		[removeReviewedGroup, selectedGroup],
	);

	const handleIgnoreGroup = useCallback(async (): Promise<void> => {
		await markSelectedGroupReviewState("ignored");
	}, [markSelectedGroupReviewState]);

	const handleClearReviewState = useCallback(async (): Promise<void> => {
		if (!selectedGroup) {
			return;
		}

		await window.api.fileOrganizer.clearSimilarGroupReviewState(
			selectedGroup.reviewKey,
			selectedGroup.contentSignature,
		);
		await findGroups(false);
	}, [findGroups, selectedGroup]);

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
			if (successPaths.length > 0 && result.summary.failed === 0) {
				await markSelectedGroupReviewState("confirmed");
			}
			alert(getOperationMessage(result, "휴지통 이동 완료"));
		},
		[markSelectedGroupReviewState, removeProcessedPaths],
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
			selectedGroup.folderSegments,
		);
		const successPaths = result.results
			.filter((item) => item.success)
			.map((item) => item.path);
		removeProcessedPaths(successPaths);
		if (successPaths.length > 0 && result.summary.failed === 0) {
			await markSelectedGroupReviewState("confirmed");
		}
		alert(getOperationMessage(result, "_grouped 이동 완료"));
	}, [
		markSelectedGroupReviewState,
		removeProcessedPaths,
		selectedGroup,
		sourcePath,
	]);

	const handleMergeGroup = useCallback(async (): Promise<void> => {
		if (!selectedGroup || !sourcePath || !selectedGroup.targetGroupPath) {
			return;
		}

		const confirmed = confirm(
			`기존 그룹으로 편입하시겠습니까?\n파일 ${selectedGroup.files.length}개\n대상: ${selectedGroup.targetGroupName ?? selectedGroup.targetGroupPath}`,
		);
		if (!confirmed) {
			return;
		}

		const result = await window.api.fileOrganizer.mergeFilesToGroup(
			sourcePath,
			selectedGroup.files.map((file) => file.path),
			selectedGroup.targetGroupPath,
		);
		const successPaths = result.results
			.filter((item) => item.success)
			.map((item) => item.path);
		removeProcessedPaths(successPaths);
		if (successPaths.length > 0 && result.summary.failed === 0) {
			await markSelectedGroupReviewState("confirmed");
		}
		alert(getOperationMessage(result, "기존 그룹 편입 완료"));
	}, [
		markSelectedGroupReviewState,
		removeProcessedPaths,
		selectedGroup,
		sourcePath,
	]);

	const handleApplyRecommendation = useCallback(async (): Promise<void> => {
		if (!recommendation) {
			return;
		}

		if (recommendation.action === "group") {
			await handleMoveGroup();
			return;
		}

		if (recommendation.action === "merge") {
			await handleMergeGroup();
			return;
		}

		if (recommendation.selectedFiles.length === 0) {
			alert(recommendation.description);
			return;
		}

		const recommendedPaths = recommendation.selectedFiles.map(
			(file) => file.path,
		);
		setSelectedPaths(new Set(recommendedPaths));
		await trashPaths(recommendedPaths, "추천 파일을");
	}, [handleMergeGroup, handleMoveGroup, recommendation, trashPaths]);

	const handlePreviewMigration = useCallback(async (): Promise<void> => {
		if (!sourcePath) {
			alert("먼저 저장소 경로를 선택해주세요.");
			return;
		}

		setIsMigrationLoading(true);
		try {
			const preview =
				await window.api.fileOrganizer.previewGroupedFolderMigration(
					sourcePath,
				);
			setMigrationPreview(preview);
			if (preview.items.length === 0) {
				alert("정리할 기존 flat 그룹이 없습니다.");
			}
		} catch (error) {
			alert(
				`기존 그룹 구조 미리보기 중 오류가 발생했습니다:\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsMigrationLoading(false);
		}
	}, [sourcePath]);

	const handleExecuteMigration = useCallback(async (): Promise<void> => {
		if (
			!sourcePath ||
			!migrationPreview ||
			migrationPreview.items.length === 0
		) {
			return;
		}

		const confirmed = confirm(
			`기존 그룹 ${migrationPreview.items.length}개, 파일 ${migrationPreview.totalFiles}개를 새 폴더 구조로 이동하시겠습니까?`,
		);
		if (!confirmed) {
			return;
		}

		setIsMigrationExecuting(true);
		try {
			const result =
				await window.api.fileOrganizer.executeGroupedFolderMigration(
					sourcePath,
				);
			alert(getOperationMessage(result, "기존 그룹 구조 정리 완료"));
			setMigrationPreview(null);
			await findGroups(true);
		} catch (error) {
			alert(
				`기존 그룹 구조 정리 중 오류가 발생했습니다:\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsMigrationExecuting(false);
		}
	}, [findGroups, migrationPreview, sourcePath]);

	const selectedFileCount = selectedPaths.size;
	const recommendationTargetCount =
		recommendation?.action === "trash"
			? recommendation.selectedFiles.length
			: recommendation?.action === "group" || recommendation?.action === "merge"
				? (selectedGroup?.files.length ?? 0)
				: 0;
	const recommendationTargetLabel =
		recommendation?.action === "trash"
			? "정리"
			: recommendation?.action === "group"
				? "묶기"
				: recommendation?.action === "merge"
					? "편입"
					: "대상";
	const recommendationKeepCount = recommendation?.keepFiles.length ?? 0;
	const canApplyRecommendation =
		recommendation?.action === "group" ||
		recommendation?.action === "merge" ||
		(recommendation?.action === "trash" &&
			recommendation.selectedFiles.length > 0);
	const selectedGroupTargetPath = selectedGroup
		? `_grouped/${selectedGroup.folderSegments.type}/${selectedGroup.folderSegments.origin}/${selectedGroup.folderSegments.artist}/${selectedGroup.folderSegments.title}`
		: "";
	const selectedGroupPrimaryFile = selectedGroup?.files[0];
	const recommendationActionButtonLabel =
		recommendation?.action === "trash"
			? "추천 파일 삭제"
			: (recommendation?.actionLabel ?? "추천 액션");
	const reviewStatusLabel =
		selectedGroup?.reviewStatus === "ignored"
			? "무시됨"
			: selectedGroup?.reviewStatus === "confirmed"
				? "처리 완료"
				: "미처리";

	const handleCopyText = useCallback(async (value: string): Promise<void> => {
		if (!value) {
			return;
		}

		try {
			await navigator.clipboard.writeText(value);
		} catch (error) {
			console.warn("경로 복사 실패:", error);
			alert("경로를 클립보드에 복사하지 못했습니다.");
		}
	}, []);

	const handleOpenRepresentativeFile = useCallback((): void => {
		if (selectedGroupPrimaryFile) {
			void handleOpenFile(selectedGroupPrimaryFile);
		}
	}, [handleOpenFile, selectedGroupPrimaryFile]);

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
		<>
			<div className="flex h-0 flex-auto flex-col gap-3 overflow-hidden">
				<div className="card flex-shrink-0 bg-base-100 shadow-sm">
					<div className="card-body gap-3 p-3">
						<div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-end">
							<label className="form-control min-w-0">
								<span className="label py-1">
									<span className="label-text text-[11px] font-semibold text-base-content/60">
										저장소 경로
									</span>
									<span className="label-text-alt">
										<span
											className={`badge badge-sm ${sourcePath ? "badge-success" : "badge-warning"}`}
										>
											{sourcePath ? "선택됨" : "선택 필요"}
										</span>
									</span>
								</span>
								<input
									className="input input-sm input-bordered w-full font-mono text-xs"
									type="text"
									value={sourcePath ?? ""}
									placeholder="설정의 저장소 경로를 불러오거나 폴더를 선택하세요"
									readOnly
									aria-label="유사 그룹 검색 저장소 경로"
								/>
							</label>

							<div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap xl:justify-end">
								<button
									type="button"
									className="btn btn-sm btn-outline"
									onClick={handleSelectPath}
									disabled={isScanning}
									aria-label="유사 그룹 검색 폴더 선택"
								>
									폴더 선택
								</button>
								<button
									type="button"
									className="btn btn-sm btn-primary"
									onClick={() => findGroups()}
									disabled={!sourcePath || isScanning}
									aria-label="유사 그룹 검색 실행"
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
									aria-label="유사 그룹 인덱스 새로고침"
								>
									인덱스 새로고침
								</button>
								<button
									type="button"
									className="btn btn-sm btn-outline"
									onClick={handlePreviewMigration}
									disabled={!sourcePath || isScanning || isMigrationLoading}
									aria-label="기존 그룹 폴더 구조 정리 미리보기"
								>
									{isMigrationLoading ? (
										<>
											<span className="loading loading-spinner loading-xs" />
											확인 중
										</>
									) : (
										"기존 구조 정리"
									)}
								</button>
							</div>
						</div>

						<fieldset className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
							<legend className="sr-only">유사 그룹 검토 큐</legend>
							{QUEUE_OPTIONS.map((queueOption) => (
								<button
									key={queueOption.value}
									type="button"
									className={`btn btn-sm min-h-10 justify-between px-3 ${
										selectedQueue === queueOption.value
											? "btn-primary"
											: "btn-outline"
									}`}
									aria-pressed={selectedQueue === queueOption.value}
									aria-label={`${queueOption.label} 큐 보기`}
									onClick={() => handleQueueChange(queueOption.value)}
									disabled={isScanning}
								>
									<span className="truncate">{queueOption.label}</span>
									<span className="badge badge-sm">
										{countsByQueue[queueOption.value] ?? 0}
									</span>
								</button>
							))}
						</fieldset>

						<div className="grid gap-2 md:grid-cols-3 xl:grid-cols-[minmax(104px,0.6fr)_minmax(124px,0.7fr)_minmax(148px,0.8fr)_minmax(0,2fr)]">
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
									aria-label="최소 그룹 크기"
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
									aria-label="최소 신뢰도"
									onChange={(event) => setMinConfidence(event.target.value)}
								/>
							</label>
							<label className="form-control">
								<span className="label py-1 text-[11px] text-base-content/60">
									내용 스캔
								</span>
								<select
									className="select select-sm select-bordered"
									value={contentScanMode}
									disabled={isScanning}
									aria-label="내용 스캔 방식"
									onChange={(event) =>
										setContentScanMode(
											event.target.value as ArchiveContentScanMode,
										)
									}
								>
									{CONTENT_SCAN_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</label>
							<div className="hidden xl:block" aria-hidden="true" />
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
							<label className="flex h-8 cursor-pointer items-center gap-2 rounded-btn border border-base-300 bg-base-100 px-3">
								<span className="text-xs font-semibold text-base-content/70">
									무시한 후보
								</span>
								<input
									type="checkbox"
									className="toggle toggle-primary toggle-sm"
									checked={includeReviewed}
									disabled={isScanning}
									aria-label="무시한 후보 보기"
									onChange={(event) =>
										handleIncludeReviewedChange(event.target.checked)
									}
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
										내용 {getContentScanModeLabel(contentScanMode)}
									</div>
									{hiddenReviewedCount > 0 && (
										<div className="badge badge-ghost badge-sm">
											검토 숨김 {hiddenReviewedCount}개
										</div>
									)}
									{hiddenSuspiciousCount > 0 && (
										<div className="badge badge-ghost badge-sm">
											의심 숨김 {hiddenSuspiciousCount}개
										</div>
									)}
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
						</div>
					</div>
				)}

				{!isScanning && scanComplete && groups.length > 0 && (
					<div className="flex min-h-0 flex-auto flex-col gap-3 overflow-auto [@media(min-width:1440px)]:grid [@media(min-width:1440px)]:h-0 [@media(min-width:1440px)]:grid-cols-[minmax(260px,0.58fr)_minmax(0,1.72fr)] [@media(min-width:1440px)]:overflow-hidden">
						<div className="card flex max-h-[42vh] min-h-[18rem] flex-col overflow-hidden bg-base-100 shadow-sm [@media(min-width:1440px)]:h-full [@media(min-width:1440px)]:max-h-none">
							<div className="card-body flex min-h-0 flex-col overflow-hidden p-3">
								<div className="mb-2 flex items-center justify-between gap-2">
									<div className="text-sm font-semibold">검토 큐</div>
									<div className="badge badge-neutral badge-sm">
										{groups.length}개
									</div>
								</div>
								<div className="h-0 min-h-0 flex-auto overflow-hidden">
									<div className="h-full overflow-auto pr-1">
										<div className="flex flex-col gap-1.5">
											{groups.map((group) => {
												const isSelected = group.id === selectedGroupId;
												const groupTargetPath = `_grouped/${group.folderSegments.type}/${group.folderSegments.origin}/${group.folderSegments.artist}/${group.folderSegments.title}`;

												return (
													<button
														type="button"
														key={group.id}
														className={`rounded-box border p-3 text-left transition-colors focus:outline focus:outline-2 focus:outline-primary ${
															isSelected
																? "border-primary/60 bg-primary/5"
																: "border-base-content/10 hover:border-primary/30"
														}`}
														aria-pressed={isSelected}
														aria-label={`${group.representativeTitle} 그룹 선택`}
														onClick={() => {
															setSelectedGroupId(group.id);
															setSelectedPaths(new Set());
														}}
													>
														<div className="flex items-start justify-between gap-2">
															<div className="min-w-0 flex-1">
																<div
																	className="truncate text-sm font-semibold"
																	title={group.representativeTitle}
																>
																	{group.representativeTitle}
																</div>
																<div className="mt-0.5 truncate text-[11px] text-base-content/55">
																	{group.artist || "-"} · {group.type || "-"} ·{" "}
																	{group.origin || "-"}
																</div>
															</div>
															<div className="min-w-14 text-right">
																<div className="font-mono text-sm font-bold">
																	{group.confidence}
																</div>
																<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-base-300">
																	<div
																		className="h-full rounded-full bg-primary"
																		style={{ width: `${group.confidence}%` }}
																	/>
																</div>
															</div>
														</div>

														<div className="mt-3 grid grid-cols-2 gap-2">
															<div className="rounded bg-base-200/70 px-2 py-1">
																<div className="text-[10px] text-base-content/45">
																	파일
																</div>
																<div className="font-mono text-xs font-semibold">
																	{group.files.length}개
																</div>
															</div>
															<div className="rounded bg-base-200/70 px-2 py-1">
																<div className="text-[10px] text-base-content/45">
																	용량
																</div>
																<div className="font-mono text-xs font-semibold">
																	{formatFileSize(group.totalSize)}
																</div>
															</div>
														</div>

														<div
															className="mt-2 line-clamp-2 break-all rounded bg-base-200/60 px-2 py-1 font-mono text-[10px] text-base-content/50"
															title={group.targetGroupPath ?? groupTargetPath}
														>
															{group.targetGroupPath
																? `편입: ${group.targetGroupName ?? group.targetGroupPath}`
																: groupTargetPath}
														</div>
													</button>
												);
											})}
										</div>
									</div>
								</div>
							</div>
						</div>

						<div className="card flex min-h-[36rem] flex-col overflow-hidden bg-base-100 shadow-sm [@media(min-width:1440px)]:h-full [@media(min-width:1440px)]:min-h-0">
							<div className="card-body flex min-h-0 flex-col gap-3 overflow-hidden p-3">
								{selectedGroup ? (
									<>
										<div className="rounded-box border border-base-content/10 bg-base-100 px-3 py-3">
											<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
												<div className="min-w-0 flex-1">
													<h2
														className="truncate text-base font-semibold"
														title={selectedGroup.representativeTitle}
													>
														{selectedGroup.representativeTitle}
													</h2>
													<div className="mt-1 truncate text-xs text-base-content/55">
														{selectedGroup.artist || "-"} ·{" "}
														{selectedGroup.type || "-"} ·{" "}
														{selectedGroup.origin || "-"}
													</div>
													<div className="mt-2 truncate text-xs text-base-content/60">
														{QUEUE_LABELS[selectedGroup.queue]} ·{" "}
														{ACTION_LABELS[selectedGroup.recommendationAction]}
														{selectedGroup.reviewStatus
															? ` · ${reviewStatusLabel}`
															: ""}
													</div>
												</div>
												<div className="flex flex-col gap-2 lg:min-w-72">
													<button
														type="button"
														className="btn btn-sm btn-primary w-full"
														onClick={handleApplyRecommendation}
														disabled={!canApplyRecommendation}
														aria-label={`추천 액션 실행: ${recommendationActionButtonLabel}`}
													>
														추천 액션 · {recommendationActionButtonLabel}
													</button>
													<div className="grid grid-cols-3 gap-2 text-center">
														<div className="rounded bg-base-200/70 px-3 py-2">
															<div className="text-[10px] text-base-content/45">
																신뢰도
															</div>
															<div className="font-mono text-sm font-bold">
																{selectedGroup.confidence}
															</div>
														</div>
														<div className="rounded bg-base-200/70 px-3 py-2">
															<div className="text-[10px] text-base-content/45">
																파일
															</div>
															<div className="font-mono text-sm font-bold">
																{selectedGroup.files.length}개
															</div>
														</div>
														<div className="rounded bg-base-200/70 px-3 py-2">
															<div className="text-[10px] text-base-content/45">
																선택
															</div>
															<div className="font-mono text-sm font-bold">
																{selectedFileCount}개
															</div>
														</div>
													</div>
												</div>
											</div>
										</div>

										<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
											<div className="grid flex-shrink-0 gap-3 xl:grid-cols-2">
												<section className="rounded-box border border-base-content/10 bg-base-100 p-3">
													<div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
														<div className="min-w-0">
															<div className="flex min-w-0 flex-wrap gap-1.5">
																<span className="badge badge-neutral badge-sm max-w-full truncate">
																	추천 {recommendation?.caseLabel ?? "없음"}
																</span>
																<span className="badge badge-ghost badge-sm max-w-full truncate">
																	신뢰{" "}
																	{recommendation?.confidenceLabel ?? "검토"}
																</span>
															</div>
														</div>
														<div className="grid grid-cols-2 gap-2 sm:min-w-36">
															<div className="rounded bg-base-200/70 px-2 py-1 text-center">
																<div className="text-[10px] text-base-content/45">
																	{recommendationTargetLabel}
																</div>
																<div className="font-mono text-xs font-semibold">
																	{recommendationTargetCount}개
																</div>
															</div>
															<div className="rounded bg-base-200/70 px-2 py-1 text-center">
																<div className="text-[10px] text-base-content/45">
																	유지
																</div>
																<div className="font-mono text-xs font-semibold">
																	{recommendationKeepCount}개
																</div>
															</div>
														</div>
													</div>
													<div className="mt-2 text-sm font-semibold">
														{recommendation?.title}
													</div>
													<div className="mt-3 flex flex-wrap gap-2">
														<button
															type="button"
															className="btn btn-sm btn-outline"
															onClick={handleSelectSmallerFiles}
														>
															더 작은 파일 선택
														</button>
														<button
															type="button"
															className="btn btn-sm btn-outline"
															onClick={handleSelectOlderFiles}
														>
															더 오래된 파일 선택
														</button>
													</div>
												</section>

												<section className="rounded-box border border-base-content/10 bg-base-100 p-3">
													<div className="mb-2 text-sm font-semibold">
														대상 경로
													</div>
													<div className="space-y-2">
														<div>
															<div className="text-[11px] font-semibold text-base-content/50">
																_grouped 경로
															</div>
															<div
																className="mt-1 break-all rounded bg-base-200/70 p-2 font-mono text-[11px]"
																title={selectedGroupTargetPath}
															>
																{selectedGroupTargetPath}
															</div>
														</div>
														{selectedGroup.targetGroupPath && (
															<div>
																<div className="text-[11px] font-semibold text-base-content/50">
																	기존 그룹 편입 대상
																</div>
																<div
																	className="mt-1 break-all rounded bg-base-200/70 p-2 font-mono text-[11px]"
																	title={selectedGroup.targetGroupPath}
																>
																	{selectedGroup.targetGroupName ??
																		selectedGroup.targetGroupPath}
																</div>
															</div>
														)}
													</div>
													<div className="mt-3 flex flex-wrap gap-2">
														<button
															type="button"
															className="btn btn-xs btn-outline"
															onClick={() =>
																handleCopyText(selectedGroupTargetPath)
															}
														>
															_grouped 경로 복사
														</button>
														{selectedGroup.targetGroupPath && (
															<button
																type="button"
																className="btn btn-xs btn-outline"
																onClick={() =>
																	handleCopyText(
																		selectedGroup.targetGroupPath ?? "",
																	)
																}
															>
																편입 경로 복사
															</button>
														)}
														<button
															type="button"
															className="btn btn-xs btn-outline"
															onClick={handleOpenRepresentativeFile}
															disabled={!selectedGroupPrimaryFile}
														>
															대표 파일 열기
														</button>
													</div>
												</section>
											</div>

											<section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-box border border-base-content/10 bg-base-100">
												<div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 px-3 py-2">
													<div>
														<div className="text-sm font-semibold">
															포함 파일
														</div>
													</div>
													<label className="flex h-7 cursor-pointer items-center gap-2 rounded-btn border border-base-300 bg-base-100 px-2">
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
												<div className="min-h-0 flex-1 overflow-auto">
													<table
														className={`table table-pin-rows table-xs table-fixed w-full ${thumbnailEnabled ? "min-w-[720px]" : "min-w-[640px]"}`}
													>
														<thead>
															<tr>
																<th className="w-9" />
																{thumbnailEnabled && (
																	<th className="w-[72px]">썸네일</th>
																)}
																<th
																	className={
																		thumbnailEnabled ? "w-[44%]" : "w-[54%]"
																	}
																>
																	파일 / 경로
																</th>
																<th className="hidden w-[9%] md:table-cell">
																	코드
																</th>
																<th className="hidden w-[20%] lg:table-cell">
																	판단
																</th>
																<th className="w-[9%]">크기</th>
																<th className="hidden w-[9%] md:table-cell">
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
																const contentBadges = getContentBadges(
																	file,
																	selectedGroup,
																);
																const tokenBadges = [
																	...file.seriesTokens,
																	...file.editionTokens,
																].slice(0, 3);

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
																		<td className="align-middle">
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
																			<td className="align-middle">
																				{renderThumbnail(file)}
																			</td>
																		)}
																		<td className="align-middle">
																			<div className="min-w-0">
																				<div
																					className="truncate font-medium leading-4"
																					title={file.name}
																				>
																					{file.name}
																				</div>
																				<div
																					className="mt-0.5 truncate font-mono text-[10px] leading-3 text-base-content/50"
																					title={file.relativePath}
																				>
																					{file.relativePath}
																				</div>
																				<div className="mt-1 flex min-w-0 flex-wrap gap-1 lg:hidden">
																					{isRecommendedSelect && (
																						<span className="badge badge-warning badge-xs max-w-full truncate">
																							정리
																						</span>
																					)}
																					{isRecommendedKeep && (
																						<span className="badge badge-success badge-xs max-w-full truncate">
																							유지
																						</span>
																					)}
																					{contentBadges
																						.slice(0, 2)
																						.map((badge) => (
																							<span
																								key={`${file.path}-mobile-${badge.label}`}
																								className={`badge badge-xs max-w-full truncate ${badge.className}`}
																								title={badge.title}
																							>
																								{badge.label}
																							</span>
																						))}
																				</div>
																			</div>
																		</td>
																		<td className="hidden align-middle md:table-cell">
																			<div className="truncate font-mono text-xs">
																				{file.code || "-"}
																			</div>
																		</td>
																		<td className="hidden align-middle lg:table-cell">
																			<div className="flex max-h-10 min-w-0 flex-wrap items-center gap-1 overflow-hidden">
																				{isRecommendedSelect && (
																					<span className="badge badge-warning badge-xs max-w-full truncate">
																						정리
																					</span>
																				)}
																				{isRecommendedKeep && (
																					<span className="badge badge-success badge-xs max-w-full truncate">
																						유지
																					</span>
																				)}
																				{contentBadges.map((badge) => (
																					<span
																						key={`${file.path}-${badge.label}`}
																						className={`badge badge-xs max-w-[7rem] truncate ${badge.className}`}
																						title={badge.title}
																					>
																						{badge.label}
																					</span>
																				))}
																				{tokenBadges.map((token) => (
																					<span
																						key={`${file.path}-${token}`}
																						className="badge badge-ghost badge-xs max-w-[7rem] truncate"
																						title={token}
																					>
																						{token}
																					</span>
																				))}
																			</div>
																		</td>
																		<td className="align-middle">
																			<div className="badge badge-ghost badge-xs">
																				{formatFileSize(file.size)}
																			</div>
																		</td>
																		<td className="hidden align-middle md:table-cell">
																			<div className="text-xs text-base-content/70">
																				{formatDate(file.modifiedTimeMs)}
																			</div>
																		</td>
																		<td className="align-middle">
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
											</section>
										</div>

										<div className="rounded-box border border-base-content/10 bg-base-100 px-3 py-2">
											<div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
												<div className="min-w-0 text-xs text-base-content/60">
													<span className="font-semibold text-base-content">
														선택 {selectedFileCount}개
													</span>
													<span className="mx-2">·</span>
													추천 {recommendationTargetLabel}{" "}
													{recommendationTargetCount}개
													{recommendationKeepCount > 0 &&
														` · 유지 ${recommendationKeepCount}개`}
												</div>
												<div className="flex flex-wrap gap-2">
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={handleSelectAllInGroup}
													>
														전체 선택
													</button>
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={handleClearSelection}
														disabled={selectedFileCount === 0}
													>
														선택 해제
													</button>
													<button
														type="button"
														className="btn btn-xs btn-outline"
														onClick={handleIgnoreGroup}
													>
														후보 보류
													</button>
													{selectedGroup.reviewStatus && (
														<button
															type="button"
															className="btn btn-xs btn-outline"
															onClick={handleClearReviewState}
														>
															상태 해제
														</button>
													)}
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
													{selectedGroup.targetGroupPath && (
														<button
															type="button"
															className="btn btn-xs btn-primary"
															onClick={handleMergeGroup}
														>
															<FolderIcon className="h-3.5 w-3.5" />
															기존 그룹 편입
														</button>
													)}
												</div>
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
			{migrationPreview && migrationPreview.items.length > 0 && (
				<div className="modal modal-open">
					<div className="modal-box flex max-h-[82vh] max-w-5xl flex-col overflow-hidden">
						<div className="mb-3 flex items-start justify-between gap-3">
							<div>
								<div className="text-lg font-semibold">기존 그룹 구조 정리</div>
								<div className="text-xs text-base-content/60">
									그룹 {migrationPreview.items.length}개 · 파일{" "}
									{migrationPreview.totalFiles}개
								</div>
							</div>
							<button
								type="button"
								className="btn btn-sm btn-ghost"
								onClick={() => setMigrationPreview(null)}
								disabled={isMigrationExecuting}
							>
								닫기
							</button>
						</div>

						<div className="min-h-0 flex-1 overflow-auto rounded-box border border-base-content/10">
							<table className="table table-xs table-pin-rows">
								<thead>
									<tr>
										<th>기존 경로</th>
										<th>새 경로</th>
										<th>추론</th>
										<th>파일</th>
									</tr>
								</thead>
								<tbody>
									{migrationPreview.items.slice(0, 80).map((item) => (
										<tr key={item.sourcePath}>
											<td>
												<div
													className="max-w-xs truncate font-mono text-[11px]"
													title={item.relativeSourcePath}
												>
													{item.relativeSourcePath}
												</div>
											</td>
											<td>
												<div
													className="max-w-sm truncate font-mono text-[11px]"
													title={item.relativeTargetPath}
												>
													{item.relativeTargetPath}
												</div>
												{item.targetExists && (
													<div className="badge badge-warning badge-xs">
														충돌 suffix 적용
													</div>
												)}
											</td>
											<td>
												<div className="flex flex-wrap gap-1">
													<span className="badge badge-ghost badge-xs">
														{item.folderSegments.type}
													</span>
													<span className="badge badge-ghost badge-xs">
														{item.folderSegments.origin}
													</span>
													<span className="badge badge-ghost badge-xs">
														{item.folderSegments.artist}
													</span>
													<span className="badge badge-ghost badge-xs">
														{item.folderSegments.title}
													</span>
												</div>
											</td>
											<td>{item.fileCount}개</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						{migrationPreview.items.length > 80 && (
							<div className="mt-2 text-xs text-base-content/55">
								화면에는 80개까지만 표시됩니다. 전체{" "}
								{migrationPreview.items.length}개가 실행 대상입니다.
							</div>
						)}

						<div className="modal-action">
							<button
								type="button"
								className="btn btn-outline"
								onClick={() => setMigrationPreview(null)}
								disabled={isMigrationExecuting}
							>
								취소
							</button>
							<button
								type="button"
								className="btn btn-primary"
								onClick={handleExecuteMigration}
								disabled={isMigrationExecuting}
							>
								{isMigrationExecuting ? (
									<>
										<span className="loading loading-spinner loading-xs" />
										실행 중
									</>
								) : (
									"구조 정리 실행"
								)}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
};
