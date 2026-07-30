import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { BrowserWindow, shell } from "electron";
import icon from "../../resources/icon.png?asset";

export const createMainWindow = (options?: {
	showOnReady?: boolean;
}): BrowserWindow => {
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
			sandbox: false,
			webSecurity: false,
			allowRunningInsecureContent: true,
		},
	});

	mainWindow.on("ready-to-show", () => {
		if (options?.showOnReady !== false) {
			mainWindow.show();
		}
	});

	mainWindow.webContents.setWindowOpenHandler((details) => {
		shell.openExternal(details.url);
		return { action: "deny" };
	});

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}

	return mainWindow;
};
