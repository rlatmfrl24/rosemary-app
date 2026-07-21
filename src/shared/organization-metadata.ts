import type { ParsedArchiveName } from "./archive-name";
import type { GallerySourceMetadata } from "./gallery-metadata";

const normalizeArchiveText = (value: string): string =>
	value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\u200b\u200c\u200d]/g, "")
		.replace(/[_\-./\\:;,'"!?~`]+/g, " ")
		.replace(/[[\]{}()]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

export type OrganizationMetadataSource = "source" | "filename-fallback";

export type OrganizationConflictField = "artist" | "category" | "parody";

export type OrganizationReviewIssueKind =
	| "metadata-conflict"
	| "favorite-target-ambiguous"
	| "duplicate-target-ambiguous";

export interface OrganizationReviewIssue {
	filePath: string;
	kind: OrganizationReviewIssueKind;
	message: string;
	field?: OrganizationConflictField;
	sourceValues?: string[];
	filenameValues?: string[];
	candidatePaths?: string[];
	blockedGroupPath?: string;
}

export interface OrganizationFileFallback {
	galleryId?: string;
	artist?: string;
	type?: string;
	origin?: string;
}

export interface OrganizationMetadataEvidence {
	galleryId?: string;
	canonicalGalleryId?: string;
	lineageGalleryIds: string[];
	artists: string[];
	groups: string[];
	parodies: string[];
	category?: string;
	effectiveArtists: string[];
	effectiveParodies: string[];
	effectiveCategory?: string;
	artistSource: OrganizationMetadataSource;
	hasSourceMetadata: boolean;
}

export interface OrganizationMetadataCompatibilityInput {
	leftGroups: string[];
	rightGroups: string[];
	leftParodies: string[];
	rightParodies: string[];
	leftCategory?: string;
	rightCategories: string[];
}

export interface OrganizationMetadataCompatibility {
	boost: number;
	reasons: string[];
	hasMismatch: boolean;
}

export interface FavoriteArtistTargetResolution<TTarget> {
	status: "none" | "matched" | "ambiguous";
	matches: Array<{ target: TTarget; matchedArtists: string[] }>;
}

export interface DuplicateTargetResolution {
	status: "none" | "matched" | "ambiguous";
	targetPath?: string;
	matchKind?: "gallery-id" | "gallery-id-and-path" | "relative-path";
	message?: string;
	candidatePaths?: string[];
}

const CATEGORY_ALIASES = new Map<string, string>([
	["artistcg", "artist cg"],
	["artist cg", "artist cg"],
	["gamecg", "game cg"],
	["game cg", "game cg"],
	["imageset", "image set"],
	["image set", "image set"],
	["nonh", "non h"],
	["non h", "non h"],
	["asianporn", "asian porn"],
	["asian porn", "asian porn"],
]);

const ORIGIN_ALIASES = new Map<string, string>([
	["페이트 그랜드 오더", "fate grand order"],
	["fate grand order", "fate grand order"],
	["fate go", "fate grand order"],
	["동방 프로젝트", "touhou project"],
	["touhou project", "touhou project"],
	["아이돌마스터", "the idolmaster"],
	["the idolmaster", "the idolmaster"],
]);

const UNKNOWN_VALUES = new Set([
	"n a",
	"na",
	"unknown",
	"정보 없음",
	"미분류",
	"none",
]);

const isMeaningfulValue = (value: string | undefined): value is string => {
	const normalized = normalizeArchiveText(value ?? "");
	return Boolean(
		normalized &&
			!UNKNOWN_VALUES.has(normalized) &&
			!normalized.startsWith("unknown "),
	);
};

export const normalizeOrganizationCategory = (value: string): string => {
	const normalized = normalizeArchiveText(value);
	const compact = normalized.replace(/\s+/g, "");
	return (
		CATEGORY_ALIASES.get(normalized) ??
		CATEGORY_ALIASES.get(compact) ??
		normalized
	);
};

export const normalizeOrganizationOrigin = (value: string): string => {
	const normalized = normalizeArchiveText(value);
	return ORIGIN_ALIASES.get(normalized) ?? normalized;
};

const getUniqueValues = (values: string[]): string[] => {
	const valuesByNormalizedValue = new Map<string, string>();
	for (const value of values) {
		const trimmed = value.trim();
		const normalized = normalizeArchiveText(trimmed);
		if (trimmed && normalized && !valuesByNormalizedValue.has(normalized)) {
			valuesByNormalizedValue.set(normalized, trimmed);
		}
	}
	return [...valuesByNormalizedValue.values()];
};

export const getSourceMetadataTagValues = (
	metadata: GallerySourceMetadata | undefined,
	namespace: string,
): string[] =>
	metadata
		? getUniqueValues(
				metadata.tags
					.filter((tag) => tag.namespace === namespace)
					.sort((left, right) => left.position - right.position)
					.map((tag) => tag.value),
			)
		: [];

const getLineageGalleryIds = (
	metadata: GallerySourceMetadata | undefined,
): string[] =>
	getUniqueValues(
		[
			metadata?.canonicalGalleryId,
			metadata?.currentGalleryId,
			metadata?.parentGalleryId,
			metadata?.firstGalleryId,
		].filter((value): value is string => Boolean(value)),
	);

export const buildOrganizationMetadataEvidence = (
	fallback: OrganizationFileFallback,
	metadata?: GallerySourceMetadata,
): OrganizationMetadataEvidence => {
	const artists = getSourceMetadataTagValues(metadata, "artist");
	const groups = getSourceMetadataTagValues(metadata, "group");
	const parodies = getSourceMetadataTagValues(metadata, "parody");
	const fallbackArtist = isMeaningfulValue(fallback.artist)
		? [fallback.artist]
		: [];
	const fallbackOrigin = isMeaningfulValue(fallback.origin)
		? [fallback.origin]
		: [];
	const sourceCategory = isMeaningfulValue(metadata?.category)
		? metadata.category
		: undefined;
	const fallbackCategory = isMeaningfulValue(fallback.type)
		? fallback.type
		: undefined;

	return {
		galleryId: fallback.galleryId ?? metadata?.galleryId,
		canonicalGalleryId: metadata?.canonicalGalleryId,
		lineageGalleryIds: getLineageGalleryIds(metadata),
		artists,
		groups,
		parodies,
		category: sourceCategory,
		effectiveArtists: artists.length > 0 ? artists : fallbackArtist,
		effectiveParodies: parodies.length > 0 ? parodies : fallbackOrigin,
		effectiveCategory: sourceCategory ?? fallbackCategory,
		artistSource: artists.length > 0 ? "source" : "filename-fallback",
		hasSourceMetadata: Boolean(metadata),
	};
};

const hasNormalizedOverlap = (
	leftValues: string[],
	rightValues: string[],
	normalize: (value: string) => string = normalizeArchiveText,
): boolean => {
	const left = new Set(leftValues.map(normalize).filter(Boolean));
	return rightValues.some((value) => left.has(normalize(value)));
};

export const findOrganizationMetadataConflicts = (
	filePath: string,
	fallback: OrganizationFileFallback,
	metadata?: GallerySourceMetadata,
): OrganizationReviewIssue[] => {
	if (!metadata) return [];

	const issues: OrganizationReviewIssue[] = [];
	const artists = getSourceMetadataTagValues(metadata, "artist");
	if (
		artists.length > 0 &&
		isMeaningfulValue(fallback.artist) &&
		!hasNormalizedOverlap(artists, [fallback.artist])
	) {
		issues.push({
			filePath,
			kind: "metadata-conflict",
			field: "artist",
			message: "원천 작가와 파일명 작가가 일치하지 않습니다.",
			sourceValues: artists,
			filenameValues: [fallback.artist],
		});
	}

	if (
		isMeaningfulValue(metadata.category) &&
		isMeaningfulValue(fallback.type) &&
		normalizeOrganizationCategory(metadata.category) !==
			normalizeOrganizationCategory(fallback.type)
	) {
		issues.push({
			filePath,
			kind: "metadata-conflict",
			field: "category",
			message: "원천 유형과 경로 유형이 일치하지 않습니다.",
			sourceValues: [metadata.category],
			filenameValues: [fallback.type],
		});
	}

	const parodies = getSourceMetadataTagValues(metadata, "parody");
	if (
		parodies.length > 0 &&
		isMeaningfulValue(fallback.origin) &&
		!hasNormalizedOverlap(
			parodies,
			[fallback.origin],
			normalizeOrganizationOrigin,
		)
	) {
		issues.push({
			filePath,
			kind: "metadata-conflict",
			field: "parody",
			message: "원천 오리진과 경로 오리진이 일치하지 않습니다.",
			sourceValues: parodies,
			filenameValues: [fallback.origin],
		});
	}

	return issues;
};

export const createOrganizationFileFallback = (
	parsedName: ParsedArchiveName,
	type?: string,
	origin?: string,
): OrganizationFileFallback => ({
	galleryId: parsedName.code,
	artist: parsedName.artist,
	type,
	origin,
});

export const organizationValuesOverlap = (
	leftValues: string[],
	rightValues: string[],
	field: "artist" | "group" | "parody",
): boolean =>
	hasNormalizedOverlap(
		leftValues,
		rightValues,
		field === "parody" ? normalizeOrganizationOrigin : normalizeArchiveText,
	);

export const organizationCategoriesMatch = (
	left: string | undefined,
	right: string | undefined,
): boolean =>
	Boolean(
		left &&
			right &&
			normalizeOrganizationCategory(left) ===
				normalizeOrganizationCategory(right),
	);

export const evaluateOrganizationMetadataCompatibility = (
	input: OrganizationMetadataCompatibilityInput,
): OrganizationMetadataCompatibility => {
	const groupMatches = organizationValuesOverlap(
		input.leftGroups,
		input.rightGroups,
		"group",
	);
	const parodyMatches = organizationValuesOverlap(
		input.leftParodies,
		input.rightParodies,
		"parody",
	);
	const categoryMatches = input.rightCategories.some((category) =>
		organizationCategoriesMatch(input.leftCategory, category),
	);
	const hasMismatch =
		(input.leftGroups.length > 0 &&
			input.rightGroups.length > 0 &&
			!groupMatches) ||
		(input.leftParodies.length > 0 &&
			input.rightParodies.length > 0 &&
			!parodyMatches) ||
		(Boolean(input.leftCategory) &&
			input.rightCategories.length > 0 &&
			!categoryMatches);

	return {
		boost:
			(groupMatches ? 3 : 0) +
			(parodyMatches ? 2 : 0) +
			(categoryMatches ? 1 : 0),
		reasons: [
			...(groupMatches ? ["원천 그룹 일치"] : []),
			...(parodyMatches ? ["원천 오리진 일치"] : []),
			...(categoryMatches ? ["원천 유형 일치"] : []),
		],
		hasMismatch,
	};
};

export const getOrganizationGalleryRelation = (
	left: OrganizationMetadataEvidence,
	rightGalleryIds: Set<string>,
	rightLineageGalleryIds: Set<string>,
): "exact" | "lineage" | "none" => {
	if (left.galleryId && rightGalleryIds.has(left.galleryId)) return "exact";
	if (
		left.lineageGalleryIds.some((galleryId) =>
			rightLineageGalleryIds.has(galleryId),
		)
	) {
		return "lineage";
	}
	return "none";
};

export const resolveFavoriteArtistTargets = <TTarget>(
	artists: string[],
	folderIndex: Map<string, TTarget | null>,
): FavoriteArtistTargetResolution<TTarget> => {
	const matches = new Map<
		TTarget,
		{ target: TTarget; matchedArtists: string[] }
	>();
	let ambiguous = false;
	for (const artist of artists) {
		const normalizedArtist = normalizeArchiveText(artist);
		if (!normalizedArtist || !folderIndex.has(normalizedArtist)) continue;
		const target = folderIndex.get(normalizedArtist);
		if (!target) {
			ambiguous = true;
			continue;
		}
		const match = matches.get(target);
		if (match) {
			match.matchedArtists.push(artist);
		} else {
			matches.set(target, { target, matchedArtists: [artist] });
		}
	}
	const resolvedMatches = [...matches.values()];
	return {
		status:
			ambiguous || resolvedMatches.length > 1
				? "ambiguous"
				: resolvedMatches.length === 1
					? "matched"
					: "none",
		matches: resolvedMatches,
	};
};

export const resolveDuplicateTarget = (input: {
	galleryId?: string;
	galleryTargetPaths: string[];
	exactTargetPath: string;
	exactTargetExists: boolean;
	isSamePath: (left: string, right: string) => boolean;
}): DuplicateTargetResolution => {
	if (input.galleryTargetPaths.length > 1) {
		return {
			status: "ambiguous",
			message: `같은 gallery id ${input.galleryId}가 저장소의 여러 위치에 있습니다.`,
			candidatePaths: input.galleryTargetPaths,
		};
	}
	const galleryTargetPath = input.galleryTargetPaths[0];
	if (
		galleryTargetPath &&
		input.exactTargetExists &&
		!input.isSamePath(galleryTargetPath, input.exactTargetPath)
	) {
		return {
			status: "ambiguous",
			message: "gallery id 중복 대상과 상대 경로 중복 대상이 서로 다릅니다.",
			candidatePaths: [galleryTargetPath, input.exactTargetPath],
		};
	}
	if (galleryTargetPath) {
		return {
			status: "matched",
			targetPath: galleryTargetPath,
			matchKind:
				input.exactTargetExists &&
				input.isSamePath(galleryTargetPath, input.exactTargetPath)
					? "gallery-id-and-path"
					: "gallery-id",
		};
	}
	if (!input.galleryId && input.exactTargetExists) {
		return {
			status: "matched",
			targetPath: input.exactTargetPath,
			matchKind: "relative-path",
		};
	}
	if (input.galleryId && input.exactTargetExists) {
		return {
			status: "ambiguous",
			message: "상대 경로는 같지만 gallery id가 다른 파일이 있습니다.",
			candidatePaths: [input.exactTargetPath],
		};
	}
	return { status: "none" };
};
