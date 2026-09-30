import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { app } from "electron";
import type { AppSettings } from "../shared/settings";

export const defaultSettings: AppSettings = {
	bandiViewPath: "C:/Program Files/BandiView/BandiView.exe",
	hitomiDownloaderPath: "",
	hitomiApiEnabled: false,
	hitomiApiAutoSendOnCrawlComplete: false,
	storePath: "",
	keepPath: "",
	favoriteArtistPath: "",
};

export const validateSettings = (value: unknown): AppSettings => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("설정은 객체여야 합니다.");
	const result = { ...defaultSettings };
	for (const key of Object.keys(defaultSettings) as Array<keyof AppSettings>) {
		const item = (value as Record<string, unknown>)[key];
		if (item === undefined) continue;
		if (typeof item !== typeof defaultSettings[key])
			throw new Error(`설정 ${key}의 값이 올바르지 않습니다.`);
		Object.assign(result, { [key]: item });
	}
	return result;
};

const getSettingsPath = (): string =>
	path.join(app.getPath("userData"), "settings.json");
const readSettings = async (filePath: string): Promise<AppSettings> =>
	validateSettings(JSON.parse(await fs.readFile(filePath, "utf8")));
const isMissing = (error: unknown): boolean =>
	error instanceof Error && "code" in error && error.code === "ENOENT";

const writeSettings = async (
	filePath: string,
	settings: AppSettings,
): Promise<void> => {
	const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
	try {
		const handle = await fs.open(temporaryPath, "wx");
		try {
			await handle.writeFile(JSON.stringify(settings, null, 2), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.unlink(temporaryPath).catch((error) => {
			if (!isMissing(error)) console.warn("설정 임시 파일 정리 실패:", error);
		});
	}
};

const readOrRecoverSettings = async (): Promise<AppSettings> => {
	const settingsPath = getSettingsPath();
	try {
		return await readSettings(settingsPath);
	} catch (error) {
		let backup: AppSettings;
		try {
			backup = await readSettings(`${settingsPath}.bak`);
		} catch (backupError) {
			if (isMissing(error) && isMissing(backupError))
				return { ...defaultSettings };
			throw Object.assign(
				new Error("설정 파일과 백업을 읽을 수 없습니다. 원본을 보존했습니다.", {
					cause: error,
				}),
				{ code: "SETTINGS_UNRECOVERABLE" },
			);
		}
		if (!isMissing(error))
			await fs.rename(settingsPath, `${settingsPath}.${randomUUID()}.corrupt`);
		await writeSettings(settingsPath, backup);
		console.warn("손상된 설정을 정상 백업으로 복구했습니다.");
		return backup;
	}
};

// Saves are serialized so the last requested settings win, including their backup.
let settingsQueue: Promise<unknown> = Promise.resolve();
export const loadSettings = (): Promise<AppSettings> => {
	const result = settingsQueue.then(readOrRecoverSettings);
	settingsQueue = result.catch(() => undefined);
	return result;
};
export const saveSettings = (settings: AppSettings): Promise<boolean> => {
	let validated: AppSettings;
	try {
		validated = validateSettings(settings);
	} catch (error) {
		console.error("설정 저장 실패:", error);
		return Promise.resolve(false);
	}
	const result = settingsQueue.then(async () => {
		try {
			let previous: AppSettings;
			try {
				previous = await readOrRecoverSettings();
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "SETTINGS_UNRECOVERABLE"
					)
				)
					throw error;
				// Only an explicit, validated save may replace unrecoverable settings.
				for (const filePath of [
					getSettingsPath(),
					`${getSettingsPath()}.bak`,
				]) {
					await fs
						.rename(filePath, `${filePath}.${randomUUID()}.corrupt`)
						.catch((renameError) => {
							if (!isMissing(renameError)) throw renameError;
						});
				}
				previous = validated;
			}
			await writeSettings(`${getSettingsPath()}.bak`, previous);
			await writeSettings(getSettingsPath(), validated);
			return true;
		} catch (error) {
			console.error("설정 저장 실패:", error);
			return false;
		}
	});
	settingsQueue = result;
	return result;
};
