import type {
	GallerySourceMetadata,
	GallerySourceTag,
	MetadataProvenance,
} from "../../../shared/gallery-metadata";

export interface ParsedFileDisplayFallback {
	type?: string;
	origin?: string;
	artist?: string;
	category?: string;
	title?: string;
	code?: string;
}

export interface ResolvedFileDisplayMetadata {
	type?: string;
	origin?: string;
	artist?: string;
	category?: string;
	title?: string;
	titleJapanese?: string;
	code?: string;
	provenance: MetadataProvenance;
	sourceMetadata?: GallerySourceMetadata;
}

const getTagValues = (
	metadata: GallerySourceMetadata,
	namespace: string,
): string[] =>
	metadata.tags
		.filter((tag) => tag.namespace === namespace)
		.sort((left, right) => left.position - right.position)
		.map((tag) => tag.value);

const getParodyDisplayValue = (value: string): string =>
	value.toLowerCase() === "original" ? "Original" : value;

export const resolveFileDisplayMetadata = (
	fallback: ParsedFileDisplayFallback,
	sourceMetadata?: GallerySourceMetadata,
): ResolvedFileDisplayMetadata => {
	if (!sourceMetadata) {
		return {
			...fallback,
			provenance: "filename",
		};
	}

	const artists = getTagValues(sourceMetadata, "artist");
	const parodies = getTagValues(sourceMetadata, "parody").map(
		getParodyDisplayValue,
	);
	const sourceValues = {
		title: sourceMetadata.title || undefined,
		type: sourceMetadata.category || undefined,
		origin: parodies.length > 0 ? parodies.join(" · ") : undefined,
		artist: artists.length > 0 ? artists.join(", ") : undefined,
	};
	const usedFallback =
		(!sourceValues.title && Boolean(fallback.title)) ||
		(!sourceValues.type && Boolean(fallback.type)) ||
		(!sourceValues.origin && Boolean(fallback.origin)) ||
		(!sourceValues.artist && Boolean(fallback.artist));

	return {
		title: sourceValues.title ?? fallback.title,
		titleJapanese: sourceMetadata.titleJapanese,
		type: sourceValues.type ?? fallback.type,
		origin: sourceValues.origin ?? fallback.origin,
		artist: sourceValues.artist ?? fallback.artist,
		category: fallback.category,
		code: sourceMetadata.galleryId || fallback.code,
		provenance: usedFallback ? "mixed" : "source",
		sourceMetadata,
	};
};

export const getMetadataProvenanceLabel = (
	provenance: MetadataProvenance,
): string => {
	if (provenance === "source") {
		return "원천 정보";
	}

	if (provenance === "mixed") {
		return "혼합";
	}

	return "파일명 정보";
};

export const getMetadataProvenanceClassName = (
	provenance: MetadataProvenance,
): string => {
	if (provenance === "source") {
		return "badge-success";
	}

	if (provenance === "mixed") {
		return "badge-warning";
	}

	return "badge-ghost";
};

export const groupSourceTags = (
	tags: GallerySourceTag[],
): Array<{ namespace: string; values: string[] }> => {
	const valuesByNamespace = new Map<string, string[]>();
	for (const tag of [...tags].sort(
		(left, right) => left.position - right.position,
	)) {
		const values = valuesByNamespace.get(tag.namespace) ?? [];
		values.push(tag.value);
		valuesByNamespace.set(tag.namespace, values);
	}

	const namespaceOrder = ["artist", "group", "parody", "language", "character"];
	return [...valuesByNamespace.entries()]
		.sort(([left], [right]) => {
			const leftIndex = namespaceOrder.indexOf(left);
			const rightIndex = namespaceOrder.indexOf(right);
			if (leftIndex >= 0 || rightIndex >= 0) {
				return (
					(leftIndex >= 0 ? leftIndex : namespaceOrder.length) -
					(rightIndex >= 0 ? rightIndex : namespaceOrder.length)
				);
			}

			return left.localeCompare(right);
		})
		.map(([namespace, values]) => ({ namespace, values }));
};
