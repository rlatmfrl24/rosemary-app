import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow } from "electron";
import { CrawlerService } from "./crawler";
import { registerIpcHandlers } from "./ipc";
import { createMainWindow } from "./window";

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
