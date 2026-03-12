import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import type { AppSettings } from "../shared/settings";

export const defaultSettings: AppSettings = {
	bandiViewPath: "C:/Program Files/BandiView/BandiView.exe",
	hitomiDownloaderPath: "",
	storePath: "",
	keepPath: "",
};

const getSettingsPath = (): string => {
	return path.join(app.getPath("userData"), "settings.json");
};

export const loadSettings = async (): Promise<AppSettings> => {
	try {
		const settingsPath = getSettingsPath();
		const exists = await fs.promises
			.access(settingsPath)
			.then(() => true)
			.catch(() => false);

		if (!exists) {
			return defaultSettings;
		}

		const data = await fs.promises.readFile(settingsPath, "utf8");
		return { ...defaultSettings, ...JSON.parse(data) };
	} catch (error) {
		console.error("설정 불러오기 실패:", error);
		return defaultSettings;
	}
};

export const saveSettings = async (settings: AppSettings): Promise<boolean> => {
	try {
		await fs.promises.writeFile(
			getSettingsPath(),
			JSON.stringify(settings, null, 2),
		);
		return true;
	} catch (error) {
		console.error("설정 저장 실패:", error);
		return false;
	}
};
