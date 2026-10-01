import type { SimilarGroup, SimilarGroupFile } from "./file-organizer";
import { formatFileSize } from "./file-size";

export const getSimilarGroupBatchExclusion = (
	group: SimilarGroup,
	minConfidence: number,
): string | undefined => {
	const recommendation = buildGroupRecommendation(group);
	if (group.reviewStatus) return "보류 또는 처리 완료된 후보입니다.";
	if (group.queue === "suspicious" || recommendation.action === "review")
		return "자동 처리할 추천 근거가 부족합니다.";
	if (group.confidence < minConfidence) return "최소 신뢰도 미만입니다.";
	if (
		recommendation.action === "trash" &&
		(!recommendation.selectedFiles.length || !recommendation.keepFiles.length)
	)
		return "처리·유지 파일이 확정되지 않았습니다.";
	if (recommendation.action === "merge" && !group.targetGroupPath)
		return "편입 대상 폴더가 확정되지 않았습니다.";
	return undefined;
};

type RecommendationAction = "trash" | "group" | "merge" | "review";

export interface GroupRecommendation {
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

export const buildGroupRecommendation = (
	group: SimilarGroup,
): GroupRecommendation => {
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
