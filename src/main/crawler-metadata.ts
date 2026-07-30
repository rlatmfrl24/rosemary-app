import type { DatabaseSync } from "node:sqlite";
import {
	createGalleryMetadataBatches,
	type GalleryIdentity,
	type GalleryMetadataBatchResult,
	type GallerySourceMetadata,
	parseGalleryIdentity,
} from "../shared/gallery-metadata.ts";

export interface CrawlerMetadataSourceItem {
	code: string;
	link: string;
}

export interface GalleryMetadataPageStats {
	requested: number;
	updated: number;
	failed: number;
}

interface CollectCrawlerGalleryMetadataOptions {
	database: DatabaseSync;
	items: CrawlerMetadataSourceItem[];
	fetchBatch: (
		identities: GalleryIdentity[],
		signal?: AbortSignal,
	) => Promise<GalleryMetadataBatchResult>;
	signal?: AbortSignal;
	isAbortError: (error: unknown) => boolean;
	onBatchError?: (error: unknown) => void;
}

export const persistCrawlerGalleryMetadataItems = (
	database: DatabaseSync,
	metadataItems: GallerySourceMetadata[],
): Set<string> => {
	const savedGalleryIds = new Set<string>();
	const findItem = database.prepare(
		"SELECT code FROM crawl_items WHERE code = ? LIMIT 1",
	);
	const upsertMetadata = database.prepare(`
		INSERT INTO crawl_item_metadata (
			gallery_id, token, source_kind, title, title_japanese, category, uploader,
			posted_at, file_count, file_size, rating, expunged,
			parent_gallery_id, parent_token, current_gallery_id, current_token,
			first_gallery_id, first_token, fetched_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(gallery_id) DO UPDATE SET
			token = excluded.token,
			source_kind = excluded.source_kind,
			title = excluded.title,
			title_japanese = excluded.title_japanese,
			category = excluded.category,
			uploader = excluded.uploader,
			posted_at = excluded.posted_at,
			file_count = excluded.file_count,
			file_size = excluded.file_size,
			rating = excluded.rating,
			expunged = excluded.expunged,
			parent_gallery_id = excluded.parent_gallery_id,
			parent_token = excluded.parent_token,
			current_gallery_id = excluded.current_gallery_id,
			current_token = excluded.current_token,
			first_gallery_id = excluded.first_gallery_id,
			first_token = excluded.first_token,
			fetched_at = excluded.fetched_at
	`);
	const deleteTags = database.prepare(
		"DELETE FROM crawl_item_tags WHERE gallery_id = ?",
	);
	const insertTag = database.prepare(`
		INSERT OR REPLACE INTO crawl_item_tags (
			gallery_id, namespace, value, position
		) VALUES (?, ?, ?, ?)
	`);

	for (const metadata of metadataItems) {
		if (!findItem.get(metadata.galleryId) || !metadata.token) continue;
		upsertMetadata.run(
			metadata.galleryId,
			metadata.token,
			metadata.sourceKind,
			metadata.title,
			metadata.titleJapanese ?? null,
			metadata.category,
			metadata.uploader ?? null,
			metadata.postedAt ?? null,
			metadata.fileCount ?? null,
			metadata.fileSize ?? null,
			metadata.rating ?? null,
			metadata.expunged ? 1 : 0,
			metadata.parentGalleryId ?? null,
			metadata.parentToken ?? null,
			metadata.currentGalleryId ?? null,
			metadata.currentToken ?? null,
			metadata.firstGalleryId ?? null,
			metadata.firstToken ?? null,
			metadata.fetchedAt,
		);
		deleteTags.run(metadata.galleryId);
		for (const tag of metadata.tags) {
			insertTag.run(metadata.galleryId, tag.namespace, tag.value, tag.position);
		}
		savedGalleryIds.add(metadata.galleryId);
	}
	return savedGalleryIds;
};

export const persistCrawlerGalleryMetadataBatch = (
	database: DatabaseSync,
	metadataItems: GallerySourceMetadata[],
): Set<string> => {
	database.exec("BEGIN IMMEDIATE TRANSACTION");
	try {
		const savedGalleryIds = persistCrawlerGalleryMetadataItems(
			database,
			metadataItems,
		);
		database.exec("COMMIT");
		return savedGalleryIds;
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
};

export const collectAndPersistCrawlerGalleryMetadata = async (
	options: CollectCrawlerGalleryMetadataOptions,
): Promise<GalleryMetadataPageStats> => {
	const identitiesByGalleryId = new Map<string, GalleryIdentity>();
	for (const item of options.items) {
		const identity = parseGalleryIdentity(item.link);
		if (identity?.galleryId === item.code) {
			identitiesByGalleryId.set(identity.galleryId, identity);
		}
	}
	const identities = [...identitiesByGalleryId.values()];
	const stats: GalleryMetadataPageStats = {
		requested: identities.length,
		updated: 0,
		failed: 0,
	};

	for (const batch of createGalleryMetadataBatches(identities)) {
		try {
			const result = await options.fetchBatch(batch, options.signal);
			const savedGalleryIds = persistCrawlerGalleryMetadataBatch(
				options.database,
				result.metadata,
			);
			stats.updated += savedGalleryIds.size;
			stats.failed += batch.filter(
				(identity) => !savedGalleryIds.has(identity.galleryId),
			).length;
		} catch (error) {
			if (options.isAbortError(error)) throw error;
			stats.failed += batch.length;
			options.onBatchError?.(error);
		}
	}
	return stats;
};

export const persistCatalogMetadataWithOfficialFallback = (
	database: DatabaseSync,
	metadataItems: GallerySourceMetadata[],
): void => {
	const findCrawlerOfficial = database.prepare(
		`SELECT 1 FROM crawl_item_metadata
		 WHERE gallery_id = ? AND source_kind = 'ehentai-api' LIMIT 1`,
	);
	const findArchiveOfficial = database.prepare(
		`SELECT 1 FROM archive_gallery_metadata
		 WHERE gallery_id = ? AND source_kind = 'ehentai-api' LIMIT 1`,
	);
	const updateCrawlerOfficial = database.prepare(`
		UPDATE crawl_item_metadata SET
			title = CASE WHEN title IS NULL OR TRIM(title) = '' THEN ? ELSE title END,
			title_japanese = COALESCE(NULLIF(TRIM(title_japanese), ''), ?),
			category = CASE WHEN category IS NULL OR TRIM(category) = '' THEN ? ELSE category END,
			uploader = COALESCE(NULLIF(TRIM(uploader), ''), ?),
			posted_at = COALESCE(posted_at, ?),
			file_count = COALESCE(file_count, ?),
			file_size = COALESCE(file_size, ?),
			rating = COALESCE(rating, ?),
			parent_gallery_id = COALESCE(parent_gallery_id, ?),
			parent_token = COALESCE(parent_token, ?),
			current_gallery_id = COALESCE(current_gallery_id, ?),
			current_token = COALESCE(current_token, ?),
			first_gallery_id = COALESCE(first_gallery_id, ?),
			first_token = COALESCE(first_token, ?)
		WHERE gallery_id = ? AND source_kind = 'ehentai-api'
	`);
	const updateArchiveOfficial = database.prepare(`
		UPDATE archive_gallery_metadata SET
			canonical_gallery_id = COALESCE(canonical_gallery_id, ?),
			token = COALESCE(token, ?),
			title = CASE WHEN title IS NULL OR TRIM(title) = '' THEN ? ELSE title END,
			title_japanese = COALESCE(NULLIF(TRIM(title_japanese), ''), ?),
			category = CASE WHEN category IS NULL OR TRIM(category) = '' THEN ? ELSE category END,
			uploader = COALESCE(NULLIF(TRIM(uploader), ''), ?),
			posted_at = COALESCE(posted_at, ?),
			file_count = COALESCE(file_count, ?),
			file_size = COALESCE(file_size, ?),
			rating = COALESCE(rating, ?),
			expunged = COALESCE(expunged, ?),
			parent_gallery_id = COALESCE(parent_gallery_id, ?),
			parent_token = COALESCE(parent_token, ?),
			current_gallery_id = COALESCE(current_gallery_id, ?),
			current_token = COALESCE(current_token, ?),
			first_gallery_id = COALESCE(first_gallery_id, ?),
			first_token = COALESCE(first_token, ?)
		WHERE gallery_id = ? AND source_kind = 'ehentai-api'
	`);
	const countCrawlerTags = database.prepare(
		"SELECT COUNT(*) AS count FROM crawl_item_tags WHERE gallery_id = ?",
	);
	const countArchiveTags = database.prepare(
		"SELECT COUNT(*) AS count FROM archive_gallery_tags WHERE gallery_id = ?",
	);
	const insertCrawlerTag = database.prepare(
		`INSERT OR REPLACE INTO crawl_item_tags
		 (gallery_id, namespace, value, position) VALUES (?, ?, ?, ?)`,
	);
	const insertArchiveTag = database.prepare(
		`INSERT OR REPLACE INTO archive_gallery_tags
		 (gallery_id, namespace, value, position) VALUES (?, ?, ?, ?)`,
	);
	const upsertArchiveCatalog = database.prepare(`
		INSERT INTO archive_gallery_metadata (
			gallery_id, canonical_gallery_id, token, source_kind, title,
			title_japanese, category, uploader, posted_at, file_count,
			file_size, rating, expunged, parent_gallery_id, parent_token,
			current_gallery_id, current_token, first_gallery_id, first_token,
			fetched_at
		) VALUES (?, ?, ?, 'hitomi-catalog', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(gallery_id) DO UPDATE SET
			canonical_gallery_id = excluded.canonical_gallery_id,
			token = excluded.token, source_kind = excluded.source_kind,
			title = excluded.title, title_japanese = excluded.title_japanese,
			category = excluded.category, uploader = excluded.uploader,
			posted_at = excluded.posted_at, file_count = excluded.file_count,
			file_size = excluded.file_size, rating = excluded.rating,
			expunged = excluded.expunged,
			parent_gallery_id = excluded.parent_gallery_id,
			parent_token = excluded.parent_token,
			current_gallery_id = excluded.current_gallery_id,
			current_token = excluded.current_token,
			first_gallery_id = excluded.first_gallery_id,
			first_token = excluded.first_token, fetched_at = excluded.fetched_at
		WHERE archive_gallery_metadata.source_kind <> 'ehentai-api'
	`);
	const deleteArchiveTags = database.prepare(
		"DELETE FROM archive_gallery_tags WHERE gallery_id = ?",
	);

	database.exec("BEGIN IMMEDIATE TRANSACTION");
	try {
		for (const item of metadataItems) {
			const commonValues = [
				item.title,
				item.titleJapanese ?? null,
				item.category,
				item.uploader ?? null,
				item.postedAt ?? null,
				item.fileCount ?? null,
				item.fileSize ?? null,
				item.rating ?? null,
			] as const;
			if (findCrawlerOfficial.get(item.galleryId)) {
				updateCrawlerOfficial.run(
					...commonValues,
					item.parentGalleryId ?? null,
					item.parentToken ?? null,
					item.currentGalleryId ?? null,
					item.currentToken ?? null,
					item.firstGalleryId ?? null,
					item.firstToken ?? null,
					item.galleryId,
				);
				const tagCount = countCrawlerTags.get(item.galleryId) as {
					count: number;
				};
				if (tagCount.count === 0) {
					for (const tag of item.tags) {
						insertCrawlerTag.run(
							item.galleryId,
							tag.namespace,
							tag.value,
							tag.position,
						);
					}
				}
				continue;
			}
			if (findArchiveOfficial.get(item.galleryId)) {
				updateArchiveOfficial.run(
					item.canonicalGalleryId ?? item.galleryId,
					item.token ?? null,
					...commonValues,
					item.expunged === undefined ? null : item.expunged ? 1 : 0,
					item.parentGalleryId ?? null,
					item.parentToken ?? null,
					item.currentGalleryId ?? null,
					item.currentToken ?? null,
					item.firstGalleryId ?? null,
					item.firstToken ?? null,
					item.galleryId,
				);
				const tagCount = countArchiveTags.get(item.galleryId) as {
					count: number;
				};
				if (tagCount.count === 0) {
					for (const tag of item.tags) {
						insertArchiveTag.run(
							item.galleryId,
							tag.namespace,
							tag.value,
							tag.position,
						);
					}
				}
				continue;
			}

			upsertArchiveCatalog.run(
				item.galleryId,
				item.canonicalGalleryId ?? item.galleryId,
				item.token ?? null,
				...commonValues,
				item.expunged === undefined ? null : item.expunged ? 1 : 0,
				item.parentGalleryId ?? null,
				item.parentToken ?? null,
				item.currentGalleryId ?? null,
				item.currentToken ?? null,
				item.firstGalleryId ?? null,
				item.firstToken ?? null,
				item.fetchedAt,
			);
			deleteArchiveTags.run(item.galleryId);
			for (const tag of item.tags) {
				insertArchiveTag.run(
					item.galleryId,
					tag.namespace,
					tag.value,
					tag.position,
				);
			}
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
};
