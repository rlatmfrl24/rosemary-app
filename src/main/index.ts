import * as fs from "node:fs";
import * as path from "node:path";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow } from "electron";
import { CrawlerService } from "./crawler";
import { registerIpcHandlers } from "./ipc";
import { createMainWindow } from "./window";

const validationUserDataPath =
	process.env.ROSEMARY_VALIDATION_USER_DATA_PATH?.trim();
if (validationUserDataPath) {
	const resolvedUserDataPath = path.resolve(validationUserDataPath);
	const sessionDataPath = path.join(resolvedUserDataPath, "session-data");
	fs.mkdirSync(sessionDataPath, { recursive: true });
	app.setPath("userData", resolvedUserDataPath);
	app.setPath("sessionData", sessionDataPath);
}

app.commandLine.appendSwitch("disable-quic");

app.whenReady().then(() => {
	const crawlerService = new CrawlerService(app.getPath("userData"));

	electronApp.setAppUserModelId("com.electron");

	app.on("browser-window-created", (_, window) => {
		optimizer.watchWindowShortcuts(window);
	});

	registerIpcHandlers(crawlerService);
	createMainWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createMainWindow();
		}
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});
