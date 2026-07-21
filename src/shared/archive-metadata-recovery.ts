import {
	type GallerySourceMetadata,
	type GallerySourceTag,
	parseGallerySourceTag,
} from "./gallery-metadata.ts";

export interface HitomiCatalogRecord {
	id?: unknown;
	n?: unknown;
	type?: unknown;
	a?: unknown;
	g?: unknown;
	p?: unknown;
	l?: unknown;
	c?: unknown;
	t?: unknown;
	pg?: unknown;
	d?: unknown;
	[key: string]: unknown;
}

export interface GallerySearchLink {
	galleryId: string;
	token: string;
}

export interface GallerySearchPartition {
	directLinks: Map<string, GallerySearchLink>;
	missingGalleryIds: string[];
	hasUpdatedChainResult: boolean;
}

const CATEGORY_NAMES: Record<string, string> = {
	doujinshi: "Doujinshi",
	manga: "Manga",
	artistcg: "Artist CG",
	gamecg: "Game CG",
	western: "Western",
	imageset: "Image Set",
	"non-h": "Non-H",
	nonh: "Non-H",
	cosplay: "Cosplay",
	asianporn: "Asian Porn",
	misc: "Misc",
};

const toText = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		return value.trim() || undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
};

const toStringArray = (value: unknown): string[] =>
	Array.isArray(value)
		? value.map(toText).filter((item): item is string => item !== undefined)
		: [];

const normalizeCategory = (value: unknown): string => {
	const category = toText(value) ?? "";
	return CATEGORY_NAMES[category.toLowerCase()] ?? category;
};

const toFiniteNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toPostedAt = (value: unknown): string | undefined => {
	const seconds = toFiniteNumber(value);
	if (seconds === undefined) {
		return undefined;
	}
	const date = new Date(seconds * 1000);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const mapHitomiCatalogRecord = (
	record: HitomiCatalogRecord,
	fetchedAt: string,
): GallerySourceMetadata | null => {
	const galleryId = toText(record.id);
	const title = toText(record.n);
	if (!galleryId || !/^\d+$/.test(galleryId) || !title) {
		return null;
	}

	const tags: GallerySourceTag[] = [];
	const seenTags = new Set<string>();
	const addTag = (namespace: string, value: string): void => {
		const normalizedNamespace = namespace.trim().toLowerCase();
		const normalizedValue = value.trim();
		if (!normalizedNamespace || !normalizedValue) {
			return;
		}
		const key = `${normalizedNamespace}\u0000${normalizedValue.toLowerCase()}`;
		if (seenTags.has(key)) {
			return;
		}
		seenTags.add(key);
		tags.push({
			namespace: normalizedNamespace,
			value: normalizedValue,
			position: tags.length,
		});
	};

	for (const [namespace, value] of [
		["artist", record.a],
		["group", record.g],
		["parody", record.p],
		["language", record.l ? [record.l] : []],
		["character", record.c],
	] as const) {
		for (const item of toStringArray(value)) {
			addTag(namespace, item);
		}
	}

	for (const rawTag of toStringArray(record.t)) {
		const parsedTag = parseGallerySourceTag(rawTag, tags.length);
		if (parsedTag) {
			addTag(
				parsedTag.namespace === "unknown" ? "other" : parsedTag.namespace,
				parsedTag.value,
			);
		}
	}

	return {
		galleryId,
		canonicalGalleryId: galleryId,
		sourceKind: "hitomi-catalog",
		title,
		category: normalizeCategory(record.type),
		postedAt: toPostedAt(record.d),
		fileCount: toFiniteNumber(record.pg),
		fetchedAt,
		tags,
	};
};

export const buildGalleryIdSearchBatches = (
	galleryIds: string[],
	maxLength = 200,
): string[][] => {
	const batches: string[][] = [];
	let currentBatch: string[] = [];
	let currentLength = 0;

	for (const galleryId of [
		...new Set(galleryIds.filter((value) => /^\d+$/.test(value))),
	]) {
		const termLength = `~gid:${galleryId}`.length;
		const nextLength =
			currentLength + (currentBatch.length > 0 ? 1 : 0) + termLength;
		if (currentBatch.length > 0 && nextLength > maxLength) {
			batches.push(currentBatch);
			currentBatch = [];
			currentLength = 0;
		}
		currentBatch.push(galleryId);
		currentLength += (currentBatch.length > 1 ? 1 : 0) + termLength;
	}

	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}
	return batches;
};

export const createGallerySearchQuery = (galleryIds: string[]): string =>
	galleryIds.map((galleryId) => `~gid:${galleryId}`).join(" ");

export const extractGallerySearchLinks = (
	html: string,
): GallerySearchLink[] => {
	const links = new Map<string, GallerySearchLink>();
	const pattern =
		/https?:\/\/(?:e-hentai|exhentai)\.org\/g\/(\d+)\/([a-f0-9]+)\/?/gi;
	for (const match of html.matchAll(pattern)) {
		const galleryId = match[1];
		const token = match[2];
		if (galleryId && token) {
			links.set(galleryId, { galleryId, token });
		}
	}
	return [...links.values()];
};

export const partitionGallerySearchResults = (
	requestedGalleryIds: string[],
	links: GallerySearchLink[],
): GallerySearchPartition => {
	const requestedIds = new Set(requestedGalleryIds);
	const directLinks = new Map(
		links
			.filter((link) => requestedIds.has(link.galleryId))
			.map((link) => [link.galleryId, link]),
	);
	return {
		directLinks,
		missingGalleryIds: requestedGalleryIds.filter(
			(galleryId) => !directLinks.has(galleryId),
		),
		hasUpdatedChainResult: links.some(
			(link) => !requestedIds.has(link.galleryId),
		),
	};
};

export const withArchiveGalleryIdentity = (
	archiveGalleryId: string,
	metadata: GallerySourceMetadata,
): GallerySourceMetadata => ({
	...metadata,
	galleryId: archiveGalleryId,
	canonicalGalleryId: metadata.canonicalGalleryId ?? metadata.galleryId,
});
