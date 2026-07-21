import type { DatabaseSync } from "node:sqlite";

const METADATA_COUNTER_COLUMNS = [
	"metadata_requested",
	"metadata_updated",
	"metadata_failed",
] as const;

export const getMetadataBackfillFailedGalleryIds = (
	db: DatabaseSync,
	jobId: number,
): string[] =>
	(
		db
			.prepare(
				`SELECT gallery_id
				 FROM crawl_metadata_backfill_items
				 WHERE job_id = ? AND status = 'failed'
				 ORDER BY CAST(gallery_id AS INTEGER) ASC`,
			)
			.all(jobId) as unknown as Array<{ gallery_id: string }>
	).map((row) => row.gallery_id);

export const initializeCrawlerDatabase = (db: DatabaseSync): void => {
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS crawl_runs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			target_url TEXT NOT NULL,
			status TEXT NOT NULL,
			phase TEXT NOT NULL,
			max_pages INTEGER NOT NULL,
			pages_visited INTEGER NOT NULL DEFAULT 0,
			items_seen INTEGER NOT NULL DEFAULT 0,
			new_items INTEGER NOT NULL DEFAULT 0,
			duplicate_items INTEGER NOT NULL DEFAULT 0,
			skipped_items INTEGER NOT NULL DEFAULT 0,
			metadata_requested INTEGER NOT NULL DEFAULT 0,
			metadata_updated INTEGER NOT NULL DEFAULT 0,
			metadata_failed INTEGER NOT NULL DEFAULT 0,
			resume_cursor_before TEXT,
			resume_cursor_after TEXT,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			last_error TEXT
		);

		CREATE TABLE IF NOT EXISTS crawl_items (
			code TEXT PRIMARY KEY,
			target_url TEXT NOT NULL,
			type TEXT NOT NULL,
			name TEXT NOT NULL,
			link TEXT NOT NULL,
			source_cursor TEXT,
			created_run_id INTEGER NOT NULL,
			discovered_at TEXT NOT NULL,
			FOREIGN KEY (created_run_id) REFERENCES crawl_runs(id)
		);

		CREATE TABLE IF NOT EXISTS crawl_state (
			target_url TEXT PRIMARY KEY,
			resume_cursor TEXT,
			default_max_pages INTEGER NOT NULL DEFAULT 10,
			last_run_id INTEGER,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS crawl_item_metadata (
			gallery_id TEXT PRIMARY KEY,
			token TEXT NOT NULL,
			title TEXT NOT NULL,
			title_japanese TEXT,
			category TEXT NOT NULL,
			uploader TEXT,
			posted_at TEXT,
			file_count INTEGER,
			file_size INTEGER,
			rating REAL,
			expunged INTEGER NOT NULL DEFAULT 0,
			parent_gallery_id TEXT,
			parent_token TEXT,
			current_gallery_id TEXT,
			current_token TEXT,
			first_gallery_id TEXT,
			first_token TEXT,
			fetched_at TEXT NOT NULL,
			FOREIGN KEY (gallery_id) REFERENCES crawl_items(code)
				ON UPDATE CASCADE ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS crawl_item_tags (
			gallery_id TEXT NOT NULL,
			namespace TEXT NOT NULL,
			value TEXT NOT NULL,
			position INTEGER NOT NULL,
			PRIMARY KEY (gallery_id, namespace, value),
			FOREIGN KEY (gallery_id) REFERENCES crawl_item_metadata(gallery_id)
				ON UPDATE CASCADE ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS crawl_metadata_backfill_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			status TEXT NOT NULL,
			total_count INTEGER NOT NULL DEFAULT 0,
			processed_count INTEGER NOT NULL DEFAULT 0,
			updated_count INTEGER NOT NULL DEFAULT 0,
			failed_count INTEGER NOT NULL DEFAULT 0,
			retry_count INTEGER NOT NULL DEFAULT 0,
			remaining_count INTEGER NOT NULL DEFAULT 0,
			already_present_count INTEGER NOT NULL DEFAULT 0,
			invalid_link_count INTEGER NOT NULL DEFAULT 0,
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			finished_at TEXT,
			last_error TEXT
		);

		CREATE TABLE IF NOT EXISTS crawl_metadata_backfill_items (
			job_id INTEGER NOT NULL,
			gallery_id TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (job_id, gallery_id),
			FOREIGN KEY (job_id) REFERENCES crawl_metadata_backfill_jobs(id)
				ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS archive_gallery_metadata (
			gallery_id TEXT PRIMARY KEY,
			canonical_gallery_id TEXT,
			token TEXT,
			source_kind TEXT NOT NULL,
			title TEXT NOT NULL,
			title_japanese TEXT,
			category TEXT NOT NULL,
			uploader TEXT,
			posted_at TEXT,
			file_count INTEGER,
			file_size INTEGER,
			rating REAL,
			expunged INTEGER,
			parent_gallery_id TEXT,
			parent_token TEXT,
			current_gallery_id TEXT,
			current_token TEXT,
			first_gallery_id TEXT,
			first_token TEXT,
			fetched_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS archive_gallery_tags (
			gallery_id TEXT NOT NULL,
			namespace TEXT NOT NULL,
			value TEXT NOT NULL,
			position INTEGER NOT NULL,
			PRIMARY KEY (gallery_id, namespace, value),
			FOREIGN KEY (gallery_id) REFERENCES archive_gallery_metadata(gallery_id)
				ON UPDATE CASCADE ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS archive_gallery_recovery_state (
			gallery_id TEXT PRIMARY KEY,
			canonical_gallery_id TEXT,
			token TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			reason_code TEXT,
			last_error TEXT,
			search_attempt_count INTEGER NOT NULL DEFAULT 0,
			metadata_attempt_count INTEGER NOT NULL DEFAULT 0,
			last_attempted_at TEXT,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS archive_metadata_recovery_jobs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			status TEXT NOT NULL,
			phase TEXT NOT NULL,
			scope_kind TEXT NOT NULL DEFAULT 'legacy-full',
			scope_path TEXT,
			total_count INTEGER NOT NULL DEFAULT 0,
			processed_count INTEGER NOT NULL DEFAULT 0,
			official_count INTEGER NOT NULL DEFAULT 0,
			catalog_count INTEGER NOT NULL DEFAULT 0,
			unresolved_count INTEGER NOT NULL DEFAULT 0,
			failed_count INTEGER NOT NULL DEFAULT 0,
			expunged_count INTEGER NOT NULL DEFAULT 0,
			access_denied_count INTEGER NOT NULL DEFAULT 0,
			token_not_found_count INTEGER NOT NULL DEFAULT 0,
			retry_count INTEGER NOT NULL DEFAULT 0,
			remaining_count INTEGER NOT NULL DEFAULT 0,
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			finished_at TEXT,
			last_error TEXT
		);

		CREATE TABLE IF NOT EXISTS archive_metadata_recovery_items (
			job_id INTEGER NOT NULL,
			gallery_id TEXT NOT NULL,
			canonical_gallery_id TEXT,
			token TEXT,
			representative_path TEXT,
			priority INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending',
			catalog_found INTEGER NOT NULL DEFAULT 0,
			search_completed INTEGER NOT NULL DEFAULT 0,
			search_attempt_count INTEGER NOT NULL DEFAULT 0,
			metadata_attempt_count INTEGER NOT NULL DEFAULT 0,
			last_phase TEXT NOT NULL DEFAULT 'catalog',
			reason_code TEXT,
			last_error TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (job_id, gallery_id),
			FOREIGN KEY (job_id) REFERENCES archive_metadata_recovery_jobs(id)
				ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_crawl_items_run_id
		ON crawl_items(created_run_id);

		CREATE INDEX IF NOT EXISTS idx_crawl_item_tags_gallery_id
		ON crawl_item_tags(gallery_id, position);

		CREATE INDEX IF NOT EXISTS idx_crawl_metadata_backfill_items_status
		ON crawl_metadata_backfill_items(job_id, status, gallery_id);

		CREATE INDEX IF NOT EXISTS idx_archive_gallery_metadata_source
		ON archive_gallery_metadata(source_kind, gallery_id);

		CREATE INDEX IF NOT EXISTS idx_archive_gallery_tags_gallery_id
		ON archive_gallery_tags(gallery_id, position);

		CREATE INDEX IF NOT EXISTS idx_archive_metadata_recovery_items_status
		ON archive_metadata_recovery_items(job_id, status, gallery_id);
	`);

	const runColumns = db
		.prepare("PRAGMA table_info(crawl_runs)")
		.all() as Array<{
		name: string;
	}>;
	const runColumnNames = new Set(runColumns.map((column) => column.name));
	for (const column of METADATA_COUNTER_COLUMNS) {
		if (!runColumnNames.has(column)) {
			db.exec(
				`ALTER TABLE crawl_runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
			);
		}
	}

	const backfillJobColumns = db
		.prepare("PRAGMA table_info(crawl_metadata_backfill_jobs)")
		.all() as Array<{ name: string }>;
	if (!backfillJobColumns.some((column) => column.name === "retry_count")) {
		db.exec(
			"ALTER TABLE crawl_metadata_backfill_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
		);
	}

	const archiveItemColumns = db
		.prepare("PRAGMA table_info(archive_metadata_recovery_items)")
		.all() as Array<{ name: string }>;
	if (
		!archiveItemColumns.some((column) => column.name === "search_completed")
	) {
		db.exec(
			"ALTER TABLE archive_metadata_recovery_items ADD COLUMN search_completed INTEGER NOT NULL DEFAULT 0",
		);
		db.exec(`
			UPDATE archive_metadata_recovery_items
			SET search_completed = 1
			WHERE status IN ('token', 'official', 'catalog', 'unresolved', 'failed');

			UPDATE archive_metadata_recovery_items
			SET status = 'catalog'
			WHERE status = 'pending' AND catalog_found = 1;
		`);
	}

	const archiveJobColumns = db
		.prepare("PRAGMA table_info(archive_metadata_recovery_jobs)")
		.all() as Array<{ name: string }>;
	const archiveJobColumnDefinitions = [
		["scope_kind", "TEXT NOT NULL DEFAULT 'legacy-full'"],
		["scope_path", "TEXT"],
		["expunged_count", "INTEGER NOT NULL DEFAULT 0"],
		["access_denied_count", "INTEGER NOT NULL DEFAULT 0"],
		["token_not_found_count", "INTEGER NOT NULL DEFAULT 0"],
		["retry_count", "INTEGER NOT NULL DEFAULT 0"],
	] as const;
	for (const [name, definition] of archiveJobColumnDefinitions) {
		if (!archiveJobColumns.some((column) => column.name === name)) {
			db.exec(
				`ALTER TABLE archive_metadata_recovery_jobs ADD COLUMN ${name} ${definition}`,
			);
		}
	}

	const currentArchiveItemColumns = db
		.prepare("PRAGMA table_info(archive_metadata_recovery_items)")
		.all() as Array<{ name: string }>;
	const archiveItemColumnDefinitions = [
		["representative_path", "TEXT"],
		["priority", "INTEGER NOT NULL DEFAULT 0"],
		["reason_code", "TEXT"],
	] as const;
	for (const [name, definition] of archiveItemColumnDefinitions) {
		if (!currentArchiveItemColumns.some((column) => column.name === name)) {
			db.exec(
				`ALTER TABLE archive_metadata_recovery_items ADD COLUMN ${name} ${definition}`,
			);
		}
	}
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_archive_metadata_recovery_items_priority
		ON archive_metadata_recovery_items(job_id, status, priority DESC, gallery_id);
	`);

	const migratedAt = new Date().toISOString();
	db.prepare(
		`INSERT INTO archive_gallery_recovery_state (
			gallery_id, canonical_gallery_id, token, status,
			reason_code, last_error, search_attempt_count,
			metadata_attempt_count, last_attempted_at, updated_at
		)
		SELECT metadata.gallery_id, metadata.canonical_gallery_id, metadata.token,
		       CASE WHEN metadata.expunged = 1 THEN 'expunged' ELSE 'official' END,
		       CASE WHEN metadata.expunged = 1 THEN 'expunged' ELSE NULL END,
		       NULL, 0, 0, metadata.fetched_at, ?
		FROM archive_gallery_metadata AS metadata
		WHERE metadata.source_kind = 'ehentai-api'
		ON CONFLICT(gallery_id) DO UPDATE SET
			canonical_gallery_id = excluded.canonical_gallery_id,
			token = COALESCE(excluded.token, archive_gallery_recovery_state.token),
			status = excluded.status,
			reason_code = excluded.reason_code,
			updated_at = excluded.updated_at`,
	).run(migratedAt);
	db.prepare(
		`INSERT INTO archive_gallery_recovery_state (
			gallery_id, canonical_gallery_id, token, status,
			reason_code, last_error, search_attempt_count,
			metadata_attempt_count, last_attempted_at, updated_at
		)
		SELECT metadata.gallery_id,
		       COALESCE(metadata.current_gallery_id, metadata.gallery_id),
		       metadata.token,
		       CASE WHEN metadata.expunged = 1 THEN 'expunged' ELSE 'official' END,
		       CASE WHEN metadata.expunged = 1 THEN 'expunged' ELSE NULL END,
		       NULL, 0, 0, metadata.fetched_at, ?
		FROM crawl_item_metadata AS metadata
		WHERE 1 = 1
		ON CONFLICT(gallery_id) DO UPDATE SET
			canonical_gallery_id = excluded.canonical_gallery_id,
			token = excluded.token,
			status = excluded.status,
			reason_code = excluded.reason_code,
			last_error = NULL,
			updated_at = excluded.updated_at`,
	).run(migratedAt);
	db.prepare(
		`INSERT INTO archive_gallery_recovery_state (
			gallery_id, canonical_gallery_id, token, status,
			reason_code, last_error, search_attempt_count,
			metadata_attempt_count, last_attempted_at, updated_at
		)
		SELECT item.gallery_id, item.canonical_gallery_id, item.token,
		       CASE
		         WHEN item.status = 'official' THEN 'official'
		         WHEN item.status = 'expunged' THEN 'expunged'
		         WHEN item.status = 'catalog' THEN 'catalog-only'
		         WHEN item.status IN ('unresolved', 'token-not-found') THEN 'token-not-found'
		         WHEN item.status = 'access-denied' THEN 'access-denied'
		         WHEN item.status = 'failed' THEN 'failed'
		         ELSE 'pending'
		       END,
		       item.reason_code, item.last_error,
		       item.search_attempt_count, item.metadata_attempt_count,
		       item.updated_at, item.updated_at
		FROM archive_metadata_recovery_items AS item
		WHERE item.token IS NOT NULL
		   OR item.status IN (
		       'official', 'expunged', 'catalog', 'unresolved',
		       'token-not-found', 'access-denied', 'failed'
		   )
		ORDER BY item.updated_at ASC
		ON CONFLICT(gallery_id) DO UPDATE SET
			canonical_gallery_id = CASE
				WHEN archive_gallery_recovery_state.status IN ('official', 'expunged')
				THEN archive_gallery_recovery_state.canonical_gallery_id
				ELSE COALESCE(excluded.canonical_gallery_id, archive_gallery_recovery_state.canonical_gallery_id)
			END,
			token = CASE
				WHEN archive_gallery_recovery_state.status IN ('official', 'expunged')
				THEN archive_gallery_recovery_state.token
				ELSE COALESCE(excluded.token, archive_gallery_recovery_state.token)
			END,
			status = CASE
				WHEN archive_gallery_recovery_state.status IN ('official', 'expunged')
				THEN archive_gallery_recovery_state.status
				ELSE excluded.status
			END,
			reason_code = CASE
				WHEN archive_gallery_recovery_state.status IN ('official', 'expunged')
				THEN archive_gallery_recovery_state.reason_code
				ELSE excluded.reason_code
			END,
			last_error = CASE
				WHEN archive_gallery_recovery_state.status IN ('official', 'expunged')
				THEN archive_gallery_recovery_state.last_error
				ELSE excluded.last_error
			END,
			search_attempt_count = MAX(
				archive_gallery_recovery_state.search_attempt_count,
				excluded.search_attempt_count
			),
			metadata_attempt_count = MAX(
				archive_gallery_recovery_state.metadata_attempt_count,
				excluded.metadata_attempt_count
			),
			last_attempted_at = CASE
				WHEN archive_gallery_recovery_state.last_attempted_at IS NULL
				THEN excluded.last_attempted_at
				ELSE MAX(
					archive_gallery_recovery_state.last_attempted_at,
					excluded.last_attempted_at
				)
			END,
			updated_at = CASE
				WHEN archive_gallery_recovery_state.status IN ('official', 'expunged')
				THEN archive_gallery_recovery_state.updated_at
				ELSE excluded.updated_at
			END`,
	).run();

	const recoveredAt = new Date().toISOString();
	db.prepare(
		`UPDATE crawl_metadata_backfill_jobs
		 SET status = 'paused', updated_at = ?, last_error = ?
		 WHERE status = 'running'`,
	).run(
		recoveredAt,
		"앱이 종료되어 실행 중이던 백필 작업을 일시 중단 상태로 복구했습니다.",
	);

	db.prepare(
		`UPDATE archive_metadata_recovery_jobs
		 SET status = 'paused', updated_at = ?, last_error = ?
		 WHERE status = 'running'`,
	).run(
		recoveredAt,
		"앱이 종료되어 실행 중이던 보관분 복구 작업을 일시 중단 상태로 복구했습니다.",
	);

	db.exec(`
		UPDATE archive_metadata_recovery_jobs
		SET official_count = (
				SELECT COUNT(*) FROM archive_metadata_recovery_items AS item
				WHERE item.job_id = archive_metadata_recovery_jobs.id
				  AND item.status = 'official'
			),
			catalog_count = (
				SELECT COUNT(*) FROM archive_metadata_recovery_items AS item
				WHERE item.job_id = archive_metadata_recovery_jobs.id
				  AND item.status = 'catalog'
			),
			unresolved_count = (
				SELECT COUNT(*) FROM archive_metadata_recovery_items AS item
				WHERE item.job_id = archive_metadata_recovery_jobs.id
				  AND item.status = 'unresolved'
			),
			failed_count = (
				SELECT COUNT(*) FROM archive_metadata_recovery_items AS item
				WHERE item.job_id = archive_metadata_recovery_jobs.id
				  AND item.status = 'failed'
			),
			remaining_count = (
				SELECT COUNT(*) FROM archive_metadata_recovery_items AS item
				WHERE item.job_id = archive_metadata_recovery_jobs.id
				  AND (item.search_completed = 0 OR item.status = 'token')
			),
			processed_count = MAX(
				total_count - (
					SELECT COUNT(*) FROM archive_metadata_recovery_items AS item
					WHERE item.job_id = archive_metadata_recovery_jobs.id
					  AND (item.search_completed = 0 OR item.status = 'token')
				),
				0
			)
	`);
};
