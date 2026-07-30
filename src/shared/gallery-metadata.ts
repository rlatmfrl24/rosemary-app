export type MetadataProvenance = "source" | "filename-fallback" | "unknown";

export type GalleryMetadataSourceKind = "ehentai-api" | "hitomi-catalog";

export interface GallerySourceTag {
	namespace: string;
	value: string;
	position: number;
}

export interface GallerySourceMetadata {
	galleryId: string;
	canonicalGalleryId?: string;
	sourceKind: GalleryMetadataSourceKind;
	token?: string;
	title: string;
	titleJapanese?: string;
	category: string;
	uploader?: string;
	postedAt?: string;
	fileCount?: number;
	fileSize?: number;
	rating?: number;
	expunged?: boolean;
	parentGalleryId?: string;
	parentToken?: string;
	currentGalleryId?: string;
	currentToken?: string;
	firstGalleryId?: string;
	firstToken?: string;
	fetchedAt: string;
	tags: GallerySourceTag[];
}

export interface GalleryIdentity {
	galleryId: string;
	token: string;
}

export interface GalleryMetadataMappingResult {
	metadata?: GallerySourceMetadata;
	galleryId?: string;
	error?: string;
}

export interface GalleryMetadataBatchResult {
	metadata: GallerySourceMetadata[];
	failures: Map<string, string>;
}

export interface GalleryMetadataRequestPayload extends Record<string, unknown> {
	method: "gdata";
	gidlist: Array<[number, string]>;
	namespace: 1;
}

export const GALLERY_METADATA_BATCH_SIZE = 25;

export const createGalleryMetadataBatches = (
	identities: GalleryIdentity[],
): GalleryIdentity[][] => {
	const batches: GalleryIdentity[][] = [];
	for (
		let offset = 0;
		offset < identities.length;
		offset += GALLERY_METADATA_BATCH_SIZE
	) {
		batches.push(
			identities.slice(offset, offset + GALLERY_METADATA_BATCH_SIZE),
		);
	}
	return batches;
};

export const createGalleryMetadataRequestPayload = (
	identities: GalleryIdentity[],
): GalleryMetadataRequestPayload => ({
	method: "gdata",
	gidlist: identities.map((identity) => [
		Number(identity.galleryId),
		identity.token,
	]),
	namespace: 1,
});

const toRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;

const toTrimmedString = (value: unknown): string | undefined => {
	if (typeof value === "string") return value.trim() || undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
};

const toFiniteNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsedValue = Number(value);
		return Number.isFinite(parsedValue) ? parsedValue : undefined;
	}
	return undefined;
};

const toPostedAt = (value: unknown): string | undefined => {
	const unixSeconds = toFiniteNumber(value);
	if (unixSeconds === undefined) return undefined;
	const date = new Date(unixSeconds * 1000);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

export const parseGalleryIdentity = (link: string): GalleryIdentity | null => {
	const match = link.match(/\/g\/(\d+)\/([a-f0-9]{10})(?:\/|$)/i);
	if (!match?.[1] || !match[2]) return null;
	return { galleryId: match[1], token: match[2] };
};

export const parseGallerySourceTag = (
	rawTag: string,
	position: number,
): GallerySourceTag | null => {
	const normalizedTag = rawTag.trim();
	if (!normalizedTag) {
		return null;
	}

	const separatorIndex = normalizedTag.indexOf(":");
	if (separatorIndex < 1) {
		return {
			namespace: "unknown",
			value: normalizedTag,
			position,
		};
	}

	const namespace = normalizedTag.slice(0, separatorIndex).trim();
	const value = normalizedTag.slice(separatorIndex + 1).trim();
	if (!namespace || !value) {
		return null;
	}

	return {
		namespace,
		value,
		position,
	};
};

export const mapGalleryMetadataResponse = (
	value: unknown,
	fetchedAt: string,
): GalleryMetadataMappingResult => {
	const record = toRecord(value);
	if (!record) return { error: "메타데이터 응답 형식이 올바르지 않습니다." };

	const galleryId = toTrimmedString(record.gid);
	const error = toTrimmedString(record.error);
	if (error) return { galleryId, error };

	const token = toTrimmedString(record.token);
	if (!galleryId || !token) {
		return {
			galleryId,
			error: "메타데이터 응답에 gallery id 또는 token이 없습니다.",
		};
	}

	const rawTags = Array.isArray(record.tags) ? record.tags : [];
	const tags = rawTags
		.map((tag, position) =>
			typeof tag === "string" ? parseGallerySourceTag(tag, position) : null,
		)
		.filter((tag): tag is GallerySourceTag => tag !== null);

	return {
		galleryId,
		metadata: {
			galleryId,
			canonicalGalleryId: galleryId,
			sourceKind: "ehentai-api",
			token,
			title: toTrimmedString(record.title) ?? "",
			titleJapanese: toTrimmedString(record.title_jpn),
			category: toTrimmedString(record.category) ?? "",
			uploader: toTrimmedString(record.uploader),
			postedAt: toPostedAt(record.posted),
			fileCount: toFiniteNumber(record.filecount),
			fileSize: toFiniteNumber(record.filesize),
			rating: toFiniteNumber(record.rating),
			expunged: record.expunged === true,
			parentGalleryId: toTrimmedString(record.parent_gid),
			parentToken: toTrimmedString(record.parent_key),
			currentGalleryId: toTrimmedString(record.current_gid),
			currentToken: toTrimmedString(record.current_key),
			firstGalleryId: toTrimmedString(record.first_gid),
			firstToken: toTrimmedString(record.first_key),
			fetchedAt,
			tags,
		},
	};
};

export const mapGalleryMetadataBatchResponse = (
	values: unknown[],
	identities: GalleryIdentity[],
	fetchedAt: string,
): GalleryMetadataBatchResult => {
	const requestedGalleryIds = new Set(
		identities.map((identity) => identity.galleryId),
	);
	const metadata: GallerySourceMetadata[] = [];
	const failures = new Map<string, string>();

	for (const value of values) {
		const result = mapGalleryMetadataResponse(value, fetchedAt);
		if (result.metadata && requestedGalleryIds.has(result.metadata.galleryId)) {
			metadata.push(result.metadata);
			continue;
		}
		if (result.galleryId && requestedGalleryIds.has(result.galleryId)) {
			failures.set(
				result.galleryId,
				result.error ?? "메타데이터 응답을 변환하지 못했습니다.",
			);
		}
	}

	const returnedGalleryIds = new Set([
		...metadata.map((item) => item.galleryId),
		...failures.keys(),
	]);
	for (const identity of identities) {
		if (!returnedGalleryIds.has(identity.galleryId)) {
			failures.set(
				identity.galleryId,
				"API 응답에 해당 gallery id가 없습니다.",
			);
		}
	}
	return { metadata, failures };
};
