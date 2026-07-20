import type { DatabaseSync } from "node:sqlite";

const METADATA_COUNTER_COLUMNS = [
	"metadata_requested",
	"metadata_updated",
	"metadata_failed",
] as const;

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

		CREATE INDEX IF NOT EXISTS idx_crawl_items_run_id
		ON crawl_items(created_run_id);

		CREATE INDEX IF NOT EXISTS idx_crawl_item_tags_gallery_id
		ON crawl_item_tags(gallery_id, position);

		CREATE INDEX IF NOT EXISTS idx_crawl_metadata_backfill_items_status
		ON crawl_metadata_backfill_items(job_id, status, gallery_id);
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

	const recoveredAt = new Date().toISOString();
	db.prepare(
		`UPDATE crawl_metadata_backfill_jobs
		 SET status = 'paused', updated_at = ?, last_error = ?
		 WHERE status = 'running'`,
	).run(
		recoveredAt,
		"앱이 종료되어 실행 중이던 백필 작업을 일시 중단 상태로 복구했습니다.",
	);
};
