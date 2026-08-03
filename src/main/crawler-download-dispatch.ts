import type { DatabaseSync } from "node:sqlite";
import type { HitomiApiSendResult } from "../shared/settings.ts";

export type DownloadDispatchStatus =
	| "pending"
	| "sent"
	| "invalid"
	| "failed"
	| "excluded";

export interface DownloadDispatchRow {
	galleryId: string;
	status: DownloadDispatchStatus;
}

export interface DownloadDispatchSummary {
	requested: number;
	sent: number;
	invalid: number;
	failed: number;
	excluded: number;
	lastError: string | null;
}

export interface ExcludedDownloadDispatchRow {
	galleryId: string;
	tagKey: string;
}

export const selectDownloadDispatchRows = (
	database: DatabaseSync,
	runId: number,
	statuses: DownloadDispatchStatus[],
): DownloadDispatchRow[] => {
	if (statuses.length === 0) return [];
	const placeholders = statuses.map(() => "?").join(", ");
	const rows = database
		.prepare(
			`SELECT gallery_id, status
			 FROM crawl_download_dispatch_items
			 WHERE run_id = ? AND status IN (${placeholders})
			 ORDER BY CAST(gallery_id AS INTEGER) ASC`,
		)
		.all(runId, ...statuses) as unknown as Array<{
		gallery_id: string;
		status: DownloadDispatchStatus;
	}>;
	return rows.map((row) => ({
		galleryId: row.gallery_id,
		status: row.status,
	}));
};

export const applyDownloadDispatchResult = (
	database: DatabaseSync,
	runId: number,
	rows: DownloadDispatchRow[],
	result: HitomiApiSendResult,
	updatedAt = new Date().toISOString(),
): void => {
	const failureByGalleryId = new Map(
		result.failures.map((failure) => [failure.code, failure]),
	);
	const updateItem = database.prepare(
		`UPDATE crawl_download_dispatch_items
		 SET status = ?, attempt_count = attempt_count + 1,
		     last_error = ?, updated_at = ?, sent_at = ?,
		     excluded_tag_key = NULL
		 WHERE run_id = ? AND gallery_id = ?`,
	);

	database.exec("BEGIN IMMEDIATE TRANSACTION");
	try {
		for (const row of rows) {
			const failure = failureByGalleryId.get(row.galleryId);
			if (!failure) {
				updateItem.run(
					"sent",
					null,
					updatedAt,
					updatedAt,
					runId,
					row.galleryId,
				);
				continue;
			}
			const isInvalid =
				failure.stage === "valid_url" &&
				failure.statusCode === 400 &&
				failure.message.includes("유효하지 않은 코드");
			updateItem.run(
				isInvalid ? "invalid" : "failed",
				failure.message,
				updatedAt,
				null,
				runId,
				row.galleryId,
			);
		}
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
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
			 FROM crawl_download_dispatch_items
			 WHERE run_id = ?`,
		)
		.get(runId) as {
		requested: number;
		sent: number | null;
		invalid: number | null;
		failed: number | null;
		excluded: number | null;
	};
	const lastFailure = database
		.prepare(
			`SELECT last_error
			 FROM crawl_download_dispatch_items
			 WHERE run_id = ? AND status = 'failed'
			 ORDER BY updated_at DESC LIMIT 1`,
		)
		.get(runId) as { last_error: string | null } | undefined;
	return {
		requested: counts.requested ?? 0,
		sent: counts.sent ?? 0,
		invalid: counts.invalid ?? 0,
		failed: counts.failed ?? 0,
		excluded: counts.excluded ?? 0,
		lastError: lastFailure?.last_error ?? null,
	};
};
