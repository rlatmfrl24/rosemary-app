export interface AppSettings {
	bandiViewPath: string;
	hitomiDownloaderPath: string;
	hitomiApiEnabled: boolean;
	hitomiApiAutoSendOnCrawlComplete: boolean;
	storePath: string;
	keepPath: string;
	favoriteArtistPath: string;
}

export interface LaunchExternalAppResult {
	success: boolean;
	message: string;
	path: string;
	launched: boolean;
	running: boolean;
}

export interface HitomiApiInstallResult {
	success: boolean;
	message: string;
	installedPath: string;
	backupPath: string | null;
	launched: boolean;
	pingOk: boolean;
}

export interface HitomiApiStatusResult {
	connected: boolean;
	message: string;
}

export interface HitomiApiSendFailure {
	code: string;
	stage: "ping" | "valid_url" | "download";
	message: string;
	statusCode: number | null;
}

export interface HitomiApiSendResult {
	success: boolean;
	total: number;
	sent: number;
	invalid: number;
	failed: number;
	launched: boolean;
	failures: HitomiApiSendFailure[];
	message: string;
}

export interface AppSettingsApi {
	get: () => Promise<AppSettings>;
	save: (settings: AppSettings) => Promise<boolean>;
	selectExecutable: (title: string) => Promise<string | null>;
	selectDirectory: () => Promise<string | null>;
	launchHitomiDownloader: () => Promise<LaunchExternalAppResult>;
	installHitomiApiExtension: () => Promise<HitomiApiInstallResult>;
	getHitomiApiStatus: () => Promise<HitomiApiStatusResult>;
	sendHitomiApiCodes: (codes: string[]) => Promise<HitomiApiSendResult>;
}
