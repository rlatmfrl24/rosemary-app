import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { is } from "@electron-toolkit/utils";
import { BrowserWindow, dialog, shell } from "electron";
import icon from "../../resources/icon.png?asset";
import {
	getExternalHttpsUrl,
	isAppEntry,
	registerTrustedContents,
} from "./ipc-security";
import { stopOrganizerMutation } from "./organizer-operation";

export const createMainWindow = (options?: {
	showOnReady?: boolean;
}): BrowserWindow => {
	const entryUrl =
		is.dev && process.env.ELECTRON_RENDERER_URL
			? new URL(process.env.ELECTRON_RENDERER_URL).href
			: pathToFileURL(join(__dirname, "../renderer/index.html")).href;
	const mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		show: false,
		autoHideMenuBar: true,
		...(process.platform !== "darwin" ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			sandbox: true,
			webSecurity: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	mainWindow.on("close", (event) => {
		const pending = stopOrganizerMutation();
		if (!pending) return;
		event.preventDefault();
		void pending
			.catch(() => undefined)
			.then(() => {
				if (!mainWindow.isDestroyed()) mainWindow.close();
			});
	});
	registerTrustedContents(mainWindow.webContents, entryUrl);
	mainWindow.on("ready-to-show", () => {
		if (options?.showOnReady !== false) mainWindow.show();
	});
	mainWindow.webContents.on("will-frame-navigate", (event) => {
		if (!event.isMainFrame || !isAppEntry(event.url, entryUrl))
			event.preventDefault();
	});
	mainWindow.webContents.on("will-redirect", (event) => {
		if (!event.isMainFrame || !isAppEntry(event.url, entryUrl))
			event.preventDefault();
	});
	mainWindow.webContents.setWindowOpenHandler((details) => {
		try {
			const url = getExternalHttpsUrl(details.url);
			void shell.openExternal(url).catch((error) => {
				console.error("외부 링크 열기 실패:", error);
				if (!mainWindow.isDestroyed())
					void dialog.showMessageBox(mainWindow, {
						type: "error",
						title: "외부 링크 열기 실패",
						message: "외부 링크를 열지 못했습니다.",
					});
			});
		} catch (error) {
			console.warn("외부 링크 요청 거부:", error);
		}
		return { action: "deny" };
	});
	void mainWindow.loadURL(entryUrl);
	return mainWindow;
};
