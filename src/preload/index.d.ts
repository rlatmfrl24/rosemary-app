import type { ClipboardApi } from "../shared/clipboard";
import type { CrawlerApi, CrawlerDatabaseApi } from "../shared/crawler";
import type { FileOrganizerApi } from "../shared/file-organizer";
import type { AppSettingsApi } from "../shared/settings";

declare global {
	interface Window {
		api: {
			clipboard: ClipboardApi;
			crawler: CrawlerApi;
			crawlerDb: CrawlerDatabaseApi;
			fileOrganizer: FileOrganizerApi;
			settings: AppSettingsApi;
		};
	}
}
