export interface AppSettings {
	bandiViewPath: string;
	hitomiDownloaderPath: string;
	storePath: string;
	keepPath: string;
}

export interface LaunchExternalAppResult {
	success: boolean;
	message: string;
	path: string;
}

export interface AppSettingsApi {
	get: () => Promise<AppSettings>;
	save: (settings: AppSettings) => Promise<boolean>;
	selectExecutable: (title: string) => Promise<string | null>;
	selectDirectory: () => Promise<string | null>;
	launchHitomiDownloader: () => Promise<LaunchExternalAppResult>;
}
