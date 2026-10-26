import type { DatabaseSync } from "node:sqlite";
import {
	type DownloadReceipt,
	type DownloadSource,
	type DownloadTransferStatus,
	getDownloadSourceKey,
} from "../shared/hitomi-download.ts";

export const getDownloadRequest = (
	db: DatabaseSync,
	source: DownloadSource,
): DownloadReceipt => {
	const row = db
		.prepare(
			`SELECT provider, gallery_id, source_url, status, last_error
		 FROM hitomi_download_requests WHERE source_key = ?`,
		)
		.get(getDownloadSourceKey(source)) as
		| {
				provider: DownloadSource["provider"];
				gallery_id: string;
				source_url: string;
				status: DownloadTransferStatus;
				last_error: string | null;
		  }
		| undefined;
	if (!row) throw new Error("다운로드 전송 기록을 찾을 수 없습니다.");
	return {
		provider: row.provider,
		galleryId: row.gallery_id,
		sourceUrl: row.source_url,
		status: row.status,
		lastError: row.last_error,
		downloadCompletion: "unverified",
	};
};

export const ensureDownloadRequest = (
	db: DatabaseSync,
	source: DownloadSource,
): void => {
	db.prepare(
		`INSERT OR IGNORE INTO hitomi_download_requests
		 (source_key, provider, gallery_id, source_url, status, updated_at)
		 VALUES (?, ?, ?, ?, 'pending', ?)`,
	).run(
		getDownloadSourceKey(source),
		source.provider,
		source.galleryId,
		source.sourceUrl,
		new Date().toISOString(),
	);
};

export const claimDownloadRequest = (
	db: DatabaseSync,
	source: DownloadSource,
): boolean =>
	Number(
		db
			.prepare(
				`UPDATE hitomi_download_requests SET status = 'submitting',
		 attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
		 WHERE source_key = ? AND status IN ('pending', 'failed')`,
			)
			.run(new Date().toISOString(), getDownloadSourceKey(source)).changes,
	) === 1;

export const finishDownloadRequest = (
	db: DatabaseSync,
	source: DownloadSource,
	status: "sent" | "unknown" | "failed" | "invalid",
	message: string | null,
	submitted: boolean,
): void => {
	const allowed = submitted ? "'submitting', 'unknown'" : "'pending', 'failed'";
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE hitomi_download_requests SET status = ?, last_error = ?, updated_at = ?,
		 accepted_at = CASE WHEN ? = 'sent' THEN ? ELSE accepted_at END
		 WHERE source_key = ? AND status IN (${allowed})`,
	).run(status, message, now, status, now, getDownloadSourceKey(source));
};
