import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type HitomiCatalogRecord,
	mapHitomiCatalogRecord,
} from "../shared/archive-metadata-recovery.ts";
import type { HitomiCatalogIndexStatus } from "../shared/crawler.ts";
import type { GallerySourceMetadata } from "../shared/gallery-metadata.ts";
import {
	decodeMessagePackArray,
	decodeMessagePackValue,
} from "./hitomi-catalog.ts";

interface CatalogMarker {
	time?: number;
	min?: number;
	max?: number;
	count?: number;
}

interface CatalogSourceSnapshot {
	fingerprint: string;
	marker: CatalogMarker;
	markerFileName: string;
	packFileNames: string[];
}

interface CatalogIndexEntryRow {
	gallery_id: string;
	pack_name: string;
	byte_offset: number;
	byte_length: number;
}

const EMPTY_STATUS: HitomiCatalogIndexStatus = {
	status: "idle",
	recordCount: 0,
	packCount: 0,
	processedPackCount: 0,
};

const readCatalogSnapshot = async (
	catalogPath: string,
): Promise<CatalogSourceSnapshot> => {
	const fileNames = await fs.promises.readdir(catalogPath);
	const markerFileName = fileNames
		.filter((name) => /^completed_v/i.test(name))
		.sort()
		.at(-1);
	if (!markerFileName) {
		throw new Error("Hitomi 전체 데이터베이스 완료 마커를 찾지 못했습니다.");
	}
	const packFileNames = fileNames
		.filter((name) => /^galleries\d+_pack\.json$/i.test(name))
		.sort(
			(left, right) =>
				Number(left.match(/\d+/)?.[0] ?? 0) -
				Number(right.match(/\d+/)?.[0] ?? 0),
		);
	if (packFileNames.length === 0) {
		throw new Error("Hitomi 로컬 카탈로그 pack 파일을 찾지 못했습니다.");
	}

	const markerText = await fs.promises.readFile(
		path.join(catalogPath, markerFileName),
		"utf8",
	);
	let marker: CatalogMarker;
	try {
		marker = JSON.parse(markerText) as CatalogMarker;
	} catch {
		throw new Error("Hitomi 전체 데이터베이스 완료 마커가 올바르지 않습니다.");
	}
	if (!Number.isSafeInteger(marker.count) || Number(marker.count) <= 0) {
		throw new Error("Hitomi 완료 마커의 레코드 수가 올바르지 않습니다.");
	}

	const hash = createHash("sha256");
	hash.update(markerFileName);
	hash.update(markerText);
	for (const fileName of packFileNames) {
		const stat = await fs.promises.stat(path.join(catalogPath, fileName));
		hash.update(`${fileName}\0${stat.size}\0${stat.mtimeMs}\n`);
	}
	return {
		fingerprint: hash.digest("hex"),
		marker,
		markerFileName,
		packFileNames,
	};
};

const readIndexMetadata = (database: DatabaseSync): Record<string, string> =>
	Object.fromEntries(
		(
			database
				.prepare("SELECT key, value FROM catalog_meta")
				.all() as unknown as Array<{
				key: string;
				value: string;
			}>
		).map((row) => [row.key, row.value]),
	);

export class HitomiCatalogIndex {
	private readonly indexPath: string;

	private buildPromise: Promise<HitomiCatalogIndexStatus> | null = null;

	private status: HitomiCatalogIndexStatus = { ...EMPTY_STATUS };

	constructor(userDataPath: string) {
		this.indexPath = path.join(userDataPath, "hitomi-catalog-index.sqlite");
	}

	public getStatus(): HitomiCatalogIndexStatus {
		return { ...this.status };
	}

	public async ensureIndex(
		catalogPath: string,
		signal?: AbortSignal,
	): Promise<HitomiCatalogIndexStatus> {
		if (this.buildPromise) return await this.buildPromise;
		const snapshot = await readCatalogSnapshot(catalogPath);
		const existing = this.readExistingStatus(snapshot.fingerprint);
		if (existing) {
			this.status = existing;
			return this.getStatus();
		}
		this.buildPromise = this.buildIndex(catalogPath, snapshot, signal).finally(
			() => {
				this.buildPromise = null;
			},
		);
		return await this.buildPromise;
	}

	public async lookup(
		catalogPath: string,
		galleryIds: Iterable<string>,
		fetchedAt: string,
		signal?: AbortSignal,
	): Promise<Map<string, GallerySourceMetadata>> {
		await this.ensureIndex(catalogPath, signal);
		if (this.status.status !== "ready") {
			throw new Error(
				this.status.error ?? "Hitomi 카탈로그 인덱스가 준비되지 않았습니다.",
			);
		}
		const normalizedIds = [
			...new Set(
				[...galleryIds].filter((galleryId) => /^\d+$/.test(galleryId)),
			),
		];
		const entries: CatalogIndexEntryRow[] = [];
		const database = new DatabaseSync(this.indexPath, { readOnly: true });
		try {
			for (let offset = 0; offset < normalizedIds.length; offset += 500) {
				const batch = normalizedIds.slice(offset, offset + 500);
				if (batch.length === 0) continue;
				const placeholders = batch.map(() => "?").join(", ");
				entries.push(
					...(database
						.prepare(
							`SELECT gallery_id, pack_name, byte_offset, byte_length
							 FROM catalog_entries WHERE gallery_id IN (${placeholders})`,
						)
						.all(...batch) as unknown as CatalogIndexEntryRow[]),
				);
			}
		} finally {
			database.close();
		}

		const byPack = new Map<string, CatalogIndexEntryRow[]>();
		for (const entry of entries) {
			const rows = byPack.get(entry.pack_name) ?? [];
			rows.push(entry);
			byPack.set(entry.pack_name, rows);
		}
		const result = new Map<string, GallerySourceMetadata>();
		for (const [packName, rows] of byPack) {
			if (signal?.aborted) throw signal.reason;
			const handle = await fs.promises.open(
				path.join(catalogPath, packName),
				"r",
			);
			try {
				for (const row of rows) {
					if (signal?.aborted) throw signal.reason;
					const buffer = Buffer.allocUnsafe(row.byte_length);
					const { bytesRead } = await handle.read(
						buffer,
						0,
						row.byte_length,
						row.byte_offset,
					);
					if (bytesRead !== row.byte_length) {
						throw new Error(`${packName}의 인덱스 범위를 읽지 못했습니다.`);
					}
					const metadata = mapHitomiCatalogRecord(
						decodeMessagePackValue(buffer) as HitomiCatalogRecord,
						fetchedAt,
					);
					if (metadata?.galleryId === row.gallery_id) {
						result.set(row.gallery_id, metadata);
					}
				}
			} finally {
				await handle.close();
			}
		}
		return result;
	}

	private readExistingStatus(
		fingerprint: string,
	): HitomiCatalogIndexStatus | null {
		if (!fs.existsSync(this.indexPath)) return null;
		let database: DatabaseSync | null = null;
		try {
			database = new DatabaseSync(this.indexPath, { readOnly: true });
			const metadata = readIndexMetadata(database);
			if (metadata.fingerprint !== fingerprint) return null;
			return {
				status: "ready",
				fingerprint,
				catalogUpdatedAt: metadata.catalogUpdatedAt,
				recordCount: Number(metadata.recordCount ?? 0),
				minGalleryId: metadata.minGalleryId,
				maxGalleryId: metadata.maxGalleryId,
				packCount: Number(metadata.packCount ?? 0),
				processedPackCount: Number(metadata.packCount ?? 0),
				builtAt: metadata.builtAt,
			};
		} catch {
			return null;
		} finally {
			database?.close();
		}
	}

	private async buildIndex(
		catalogPath: string,
		snapshot: CatalogSourceSnapshot,
		signal?: AbortSignal,
	): Promise<HitomiCatalogIndexStatus> {
		const tempPath = `${this.indexPath}.tmp`;
		await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true });
		await fs.promises.rm(tempPath, { force: true });
		this.status = {
			status: "building",
			fingerprint: snapshot.fingerprint,
			catalogUpdatedAt: snapshot.marker.time
				? new Date(snapshot.marker.time * 1000).toISOString()
				: undefined,
			recordCount: 0,
			minGalleryId: snapshot.marker.min?.toString(),
			maxGalleryId: snapshot.marker.max?.toString(),
			packCount: snapshot.packFileNames.length,
			processedPackCount: 0,
		};
		let database: DatabaseSync | null = null;
		try {
			database = new DatabaseSync(tempPath);
			database.exec(`
				PRAGMA journal_mode = OFF;
				PRAGMA synchronous = OFF;
				CREATE TABLE catalog_entries (
					gallery_id TEXT PRIMARY KEY,
					pack_name TEXT NOT NULL,
					byte_offset INTEGER NOT NULL,
					byte_length INTEGER NOT NULL
				) WITHOUT ROWID;
				CREATE TABLE catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			`);
			const insert = database.prepare(
				`INSERT OR REPLACE INTO catalog_entries
				 (gallery_id, pack_name, byte_offset, byte_length) VALUES (?, ?, ?, ?)`,
			);
			let decodedCount = 0;
			for (const [packIndex, packName] of snapshot.packFileNames.entries()) {
				if (signal?.aborted) throw signal.reason;
				const buffer = await fs.promises.readFile(
					path.join(catalogPath, packName),
				);
				database.exec("BEGIN");
				try {
					decodedCount += decodeMessagePackArray(
						buffer,
						(value, _index, span) => {
							const record = value as HitomiCatalogRecord;
							const galleryId =
								typeof record?.id === "number" || typeof record?.id === "string"
									? String(record.id)
									: "";
							if (/^\d+$/.test(galleryId)) {
								insert.run(galleryId, packName, span.offset, span.length);
							}
						},
						signal,
					);
					database.exec("COMMIT");
				} catch (error) {
					database.exec("ROLLBACK");
					throw error;
				}
				this.status = {
					...this.status,
					recordCount: decodedCount,
					processedPackCount: packIndex + 1,
				};
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			if (decodedCount !== snapshot.marker.count) {
				throw new Error(
					`Hitomi 카탈로그 레코드 수가 완료 마커와 다릅니다. (${decodedCount}/${snapshot.marker.count})`,
				);
			}
			const indexedCount = (
				database
					.prepare("SELECT COUNT(*) AS count FROM catalog_entries")
					.get() as {
					count: number;
				}
			).count;
			const builtAt = new Date().toISOString();
			const metadata: Record<string, string> = {
				fingerprint: snapshot.fingerprint,
				catalogUpdatedAt: this.status.catalogUpdatedAt ?? "",
				recordCount: String(indexedCount),
				minGalleryId: this.status.minGalleryId ?? "",
				maxGalleryId: this.status.maxGalleryId ?? "",
				packCount: String(snapshot.packFileNames.length),
				builtAt,
			};
			const insertMeta = database.prepare(
				"INSERT INTO catalog_meta (key, value) VALUES (?, ?)",
			);
			for (const [key, value] of Object.entries(metadata))
				insertMeta.run(key, value);
			database.close();
			database = null;
			await fs.promises.rm(this.indexPath, { force: true });
			await fs.promises.rename(tempPath, this.indexPath);
			this.status = {
				...this.status,
				status: "ready",
				recordCount: indexedCount,
				processedPackCount: snapshot.packFileNames.length,
				builtAt,
				error: undefined,
			};
			return this.getStatus();
		} catch (error) {
			database?.close();
			await fs.promises.rm(tempPath, { force: true });
			this.status = {
				...this.status,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			};
			throw error;
		}
	}
}
