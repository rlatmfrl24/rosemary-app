import * as fs from "node:fs";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, type BrowserWindow } from "electron";
import { CrawlerService } from "./crawler";
import { registerIpcHandlers } from "./ipc";
import { resolveRuntimeProfilePaths } from "./runtime-paths";
import { createMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;

const openMainWindow = (options?: { showOnReady?: boolean }): BrowserWindow => {
	const createdWindow = createMainWindow(options);
	mainWindow = createdWindow;
	createdWindow.once("closed", () => {
		if (mainWindow === createdWindow) {
			mainWindow = null;
		}
	});

	return createdWindow;
};

const runtimeProfile = resolveRuntimeProfilePaths({
	appDataPath: app.getPath("appData"),
	appName: app.getName(),
	isPackaged: app.isPackaged,
	validationUserDataPath: process.env.ROSEMARY_VALIDATION_USER_DATA_PATH,
});
if (runtimeProfile.userDataPath && runtimeProfile.sessionDataPath) {
	fs.mkdirSync(runtimeProfile.userDataPath, { recursive: true });
	fs.mkdirSync(runtimeProfile.sessionDataPath, { recursive: true });
	app.setPath("userData", runtimeProfile.userDataPath);
	app.setPath("sessionData", runtimeProfile.sessionDataPath);
}

app.commandLine.appendSwitch("disable-quic");

void app
	.whenReady()
	.then(() => {
		console.info(
			`[Rosemary 시작] 프로필=${runtimeProfile.mode}, 데이터=${app.getPath("userData")}, 캐시=${app.getPath("sessionData")}`,
		);
		if (!app.isPackaged) {
			console.info(
				"[Rosemary 안내] SQLite ExperimentalWarning은 Electron 내장 Node.js의 기능 상태 안내이며 앱 오류가 아닙니다.",
			);
		}
		const crawlerService = new CrawlerService(app.getPath("userData"));

		electronApp.setAppUserModelId("com.electron");

		app.on("browser-window-created", (_, window) => {
			optimizer.watchWindowShortcuts(window);
		});

		registerIpcHandlers(crawlerService);
		const isSmokeTest = process.env.ROSEMARY_SMOKE_TEST === "1";
		const createdMainWindow = openMainWindow({ showOnReady: !isSmokeTest });
		if (isSmokeTest) {
			createdMainWindow.webContents.once("did-finish-load", () => {
				console.info("[Rosemary 시작] 준비 완료");
				setTimeout(() => app.quit(), 500);
			});
		} else {
			console.info("[Rosemary 시작] 준비 완료");
		}

		app.on("activate", () => {
			if (!mainWindow || mainWindow.isDestroyed()) {
				openMainWindow();
			}
		});
	})
	.catch((error) => {
		console.error(
			"[Rosemary 시작 실패] 앱 데이터 또는 캐시 경로를 준비하지 못했습니다.",
			error,
		);
		app.exit(1);
	});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
