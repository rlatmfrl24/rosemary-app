import type { DatabaseSync } from "node:sqlite";
import {
	type DownloadReceipt,
	type DownloadSource,
	type DownloadTransferStatus,
	getDownloadSourceKey,
	parseDownloadSource,
} from "../shared/hitomi-download.ts";
import { ensureDownloadRequest } from "./hitomi-download-store.ts";

export type DownloadDispatchStatus = DownloadTransferStatus | "excluded";

export interface DownloadDispatchRow {
	galleryId: string;
	status: DownloadDispatchStatus;
	source: DownloadSource | null;
	sourceBound: boolean;
	lastError: string | null;
}

export interface DownloadDispatchSummary {
	requested: number;
	sent: number;
	invalid: number;
	failed: number;
	excluded: number;
	unknown: number;
	lastError: string | null;
}

export interface ExcludedDownloadDispatchRow {
	galleryId: string;
	tagKey: string;
}

const DISPATCH_SELECT = `SELECT d.run_id, d.gallery_id, d.source_key,
	CASE WHEN d.status = 'excluded' THEN d.status ELSE COALESCE(r.status, d.status) END AS status,
	COALESCE(r.source_url, d.source_url, i.link) AS source_url,
	CASE WHEN d.status = 'excluded' OR r.source_key IS NULL THEN d.last_error ELSE r.last_error END AS last_error,
	CASE WHEN d.status = 'excluded' THEN d.updated_at ELSE COALESCE(r.updated_at, d.updated_at) END AS updated_at
	FROM crawl_download_dispatch_items d
	JOIN crawl_items i ON i.code = d.gallery_id
	LEFT JOIN hitomi_download_requests r ON r.source_key = d.source_key`;

export const selectDownloadDispatchRows = (
	database: DatabaseSync,
	runId: number,
	statuses: DownloadDispatchStatus[],
): DownloadDispatchRow[] => {
	if (statuses.length === 0) return [];
	const placeholders = statuses.map(() => "?").join(", ");
	const rows = database
		.prepare(
			`SELECT * FROM (${DISPATCH_SELECT})
			 WHERE run_id = ? AND status IN (${placeholders})
			 ORDER BY CAST(gallery_id AS INTEGER) ASC`,
		)
		.all(runId, ...statuses) as unknown as Array<{
		gallery_id: string;
		status: DownloadDispatchStatus;
		source_url: string;
		last_error: string | null;
		source_key: string | null;
	}>;
	return rows.map((row) => {
		let source: DownloadSource | null = null;
		try {
			source = parseDownloadSource(row.source_url);
		} catch {
			/* Invalid legacy origins remain visible. */
		}
		return {
			galleryId: row.gallery_id,
			status: row.status,
			source,
			sourceBound: row.source_key !== null,
			lastError: row.last_error,
		};
	});
};

export const bindDownloadDispatchSource = (
	db: DatabaseSync,
	runId: number,
	row: DownloadDispatchRow,
): void => {
	if (!row.source) throw new Error("원본 URL을 확인할 수 없습니다.");
	const bound = db
		.prepare(
			"SELECT source_key FROM crawl_download_dispatch_items WHERE run_id = ? AND gallery_id = ?",
		)
		.get(runId, row.galleryId) as { source_key: string | null } | undefined;
	if (!bound) throw new Error("전송할 크롤링 항목이 없습니다.");
	if (bound.source_key) return;
	if (row.source.galleryId !== row.galleryId)
		throw new Error("원본 URL의 작품 ID가 수집 항목과 일치하지 않습니다.");
	ensureDownloadRequest(db, row.source);
	db.prepare(
		"UPDATE crawl_download_dispatch_items SET source_key = ?, source_url = ? WHERE run_id = ? AND gallery_id = ? AND source_key IS NULL",
	).run(
		getDownloadSourceKey(row.source),
		row.source.sourceUrl,
		runId,
		row.galleryId,
	);
};

export const getDownloadDispatchReceipts = (
	db: DatabaseSync,
	runId: number,
): Map<string, DownloadReceipt> => {
	const rows = selectDownloadDispatchRows(db, runId, [
		"pending",
		"submitting",
		"sent",
		"unknown",
		"invalid",
		"failed",
		"excluded",
	]);
	return new Map(
		rows.flatMap((row) =>
			row.source
				? [
						[
							row.galleryId,
							{
								...row.source,
								status: row.status,
								lastError: row.lastError,
								downloadCompletion: "unverified" as const,
							},
						] as const,
					]
				: [],
		),
	);
};

export const markDownloadDispatchRowsFailed = (
	database: DatabaseSync,
	runId: number,
	statuses: DownloadDispatchStatus[],
	errorMessage: string,
	updatedAt = new Date().toISOString(),
): void => {
	if (statuses.length === 0) return;
	const placeholders = statuses.map(() => "?").join(", ");
	database
		.prepare(
			`UPDATE hitomi_download_requests SET status = 'failed', last_error = ?, updated_at = ?
		 WHERE status = 'pending' AND source_key IN (
		 SELECT source_key FROM crawl_download_dispatch_items
		 WHERE run_id = ? AND status IN (${placeholders}))`,
		)
		.run(errorMessage, updatedAt, runId, ...statuses);
	database
		.prepare(
			`UPDATE crawl_download_dispatch_items
			 SET status = 'failed', attempt_count = attempt_count + 1,
			     last_error = ?, updated_at = ?, sent_at = NULL,
			     excluded_tag_key = NULL
			 WHERE run_id = ? AND status IN (${placeholders})`,
		)
		.run(errorMessage, updatedAt, runId, ...statuses);
};

export const markDownloadDispatchRowsExcluded = (
	database: DatabaseSync,
	runId: number,
	rows: ExcludedDownloadDispatchRow[],
	updatedAt = new Date().toISOString(),
): void => {
	if (rows.length === 0) return;
	const updateItem = database.prepare(
		`UPDATE crawl_download_dispatch_items
		 SET status = 'excluded', last_error = NULL, updated_at = ?,
		     sent_at = NULL, excluded_tag_key = ?
		 WHERE run_id = ? AND gallery_id = ?`,
	);

	database.exec("BEGIN IMMEDIATE TRANSACTION");
	try {
		for (const row of rows) {
			updateItem.run(updatedAt, row.tagKey, runId, row.galleryId);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
};

export const getDownloadDispatchSummary = (
	database: DatabaseSync,
	runId: number,
): DownloadDispatchSummary => {
	const counts = database
		.prepare(
			`SELECT
				SUM(CASE WHEN status <> 'excluded' THEN 1 ELSE 0 END) AS requested,
				SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
				SUM(CASE WHEN status = 'invalid' THEN 1 ELSE 0 END) AS invalid,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
				SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded
				, SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown
			 FROM (${DISPATCH_SELECT})
			 WHERE run_id = ?`,
		)
		.get(runId) as {
		requested: number;
		sent: number | null;
		invalid: number | null;
		failed: number | null;
		excluded: number | null;
		unknown: number | null;
	};
	const lastFailure = database
		.prepare(
			`SELECT last_error
			 FROM (${DISPATCH_SELECT})
			 WHERE run_id = ? AND status IN ('failed', 'unknown')
			 ORDER BY updated_at DESC LIMIT 1`,
		)
		.get(runId) as { last_error: string | null } | undefined;
	return {
		requested: counts.requested ?? 0,
		sent: counts.sent ?? 0,
		invalid: counts.invalid ?? 0,
		failed: counts.failed ?? 0,
		excluded: counts.excluded ?? 0,
		unknown: counts.unknown ?? 0,
		lastError: lastFailure?.last_error ?? null,
	};
};
