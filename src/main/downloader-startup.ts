import { type BrowserWindow, dialog } from "electron";
import { selectFilePath } from "./dialogs";
import { ensurePathExists, ensureProcessRunning } from "./process-utils";
import { loadSettings, saveSettings } from "./settings";

export const startDownloader = async (window: BrowserWindow): Promise<void> => {
	while (!window.isDestroyed()) {
		try {
			const settings = await loadSettings();
			const executablePath = settings.hitomiDownloaderPath.trim();
			if (!executablePath)
				throw new Error("설정에 다운로더 실행 파일 경로가 없습니다.");
			await ensurePathExists(
				executablePath,
				"다운로더 실행 파일을 찾을 수 없습니다.",
			);
			await ensureProcessRunning(executablePath);
			console.info("[Rosemary 다운로더] 실행 중인 프로세스를 확인했습니다.");
			return;
		} catch (error) {
			if (window.isDestroyed()) return;
			const { response } = await dialog.showMessageBox(window, {
				type: "warning",
				title: "다운로더 실행 요청",
				message: "Hitomi Downloader를 실행해주세요.",
				detail: `${error instanceof Error ? error.message : String(error)}\n직접 실행한 후 ‘실행 확인 / 재시도’를 누르거나 실행 파일을 지정해주세요. 실행이 확인되기 전에는 자동 실행 완료로 처리하지 않습니다.`,
				buttons: ["실행 확인 / 재시도", "실행 파일 지정", "다운로더 없이 계속"],
				defaultId: 0,
				cancelId: 2,
			});
			if (response === 2 || window.isDestroyed()) return;
			if (response === 1) {
				const executablePath = await selectFilePath(
					"Hitomi Downloader 실행 파일 선택",
				);
				if (executablePath) {
					const settings = await loadSettings();
					if (
						!(await saveSettings({
							...settings,
							hitomiDownloaderPath: executablePath,
						}))
					) {
						await dialog.showMessageBox(window, {
							type: "error",
							message:
								"다운로더 실행 파일 경로를 저장하지 못했습니다. 다시 지정해주세요.",
						});
					}
				}
			}
		}
	}
};
