import { ElectronAPI } from "@electron-toolkit/preload";
import type { CrawlerApi, CrawlerDatabaseApi } from "../shared/crawler";
import type { AppSettingsApi } from "../shared/settings";

declare global {
	interface Window {
		electron: ElectronAPI;
		api: {
			crawler: CrawlerApi;
			crawlerDb: CrawlerDatabaseApi;
			settings: AppSettingsApi;
		};
	}
}
