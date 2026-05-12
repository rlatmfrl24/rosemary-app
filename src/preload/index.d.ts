import { ElectronAPI } from "@electron-toolkit/preload";
import type { ClipboardApi } from "../shared/clipboard";
import type { CrawlerApi, CrawlerDatabaseApi } from "../shared/crawler";
import type { AppSettingsApi } from "../shared/settings";

declare global {
	interface Window {
		electron: ElectronAPI;
		api: {
			clipboard: ClipboardApi;
			crawler: CrawlerApi;
			crawlerDb: CrawlerDatabaseApi;
			settings: AppSettingsApi;
		};
	}
}
