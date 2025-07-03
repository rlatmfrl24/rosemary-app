import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import icon from "../../resources/icon.png?asset";

// 설정 저장 경로
const settingsPath = path.join(app.getPath("userData"), "settings.json");

// 기본 설정값
const defaultSettings = {
	bandiViewPath: "C:/Program Files/BandiView/BandiView.exe",
	storePath: "",
};

// 설정 불러오기 함수
const _loadSettings = async () => {
	try {
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

// 설정 저장 함수
const _saveSettings = async (settings: typeof defaultSettings) => {
	try {
		await fs.promises.writeFile(
			settingsPath,
			JSON.stringify(settings, null, 2),
		);
		return true;
	} catch (error) {
		console.error("설정 저장 실패:", error);
		return false;
	}
};

function createWindow(): void {
	// Create the browser window.
	const mainWindow = new BrowserWindow({
		width: 900,
		height: 670,
		show: false,
		autoHideMenuBar: true,
		...(process.platform === "linux" ? { icon } : {}),
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			sandbox: false,
			webSecurity: false,
			allowRunningInsecureContent: true,
		},
	});

	mainWindow.on("ready-to-show", () => {
		mainWindow.show();
	});

	mainWindow.webContents.setWindowOpenHandler((details) => {
		shell.openExternal(details.url);
		return { action: "deny" };
	});

	// HMR for renderer base on electron-vite cli.
	// Load the remote URL for development or the local html file for production.
	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
	// Set app user model id for windows
	electronApp.setAppUserModelId("com.electron");

	// Default open or close DevTools by F12 in development
	// and ignore CommandOrControl + R in production.
	// see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
	app.on("browser-window-created", (_, window) => {
		optimizer.watchWindowShortcuts(window);
	});

	// IPC test
	ipcMain.on("ping", () => console.log("pong"));
	ipcMain.handle("get-target-path", async () => {
		const result = await dialog.showOpenDialog({
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled) {
			return null;
		}
		return result.filePaths[0];
	});

	// 설정 관련 IPC 핸들러들
	ipcMain.handle("get-settings", async () => {
		return await _loadSettings();
	});

	ipcMain.handle("save-settings", async (_, settings) => {
		return await _saveSettings(settings);
	});

	ipcMain.handle(
		"select-file-path",
		async (
			_,
			title: string,
			filters?: { name: string; extensions: string[] }[],
		) => {
			const result = await dialog.showOpenDialog({
				title,
				properties: ["openFile"],
				filters: filters || [
					{ name: "실행 파일", extensions: ["exe"] },
					{ name: "모든 파일", extensions: ["*"] },
				],
			});
			if (result.canceled) {
				return null;
			}
			return result.filePaths[0];
		},
	);

	// 파일 탐색 IPC 핸들러
	ipcMain.handle("scan-files", async (_, targetPath: string) => {
		if (!targetPath) {
			throw new Error("경로가 지정되지 않았습니다.");
		}

		// 압축파일 확장자
		const archiveExtensions = [
			".zip",
			".rar",
			".7z",
			".tar",
			".gz",
			".bz2",
			".xz",
			".tar.gz",
			".tar.bz2",
			".tar.xz",
			".cab",
			".iso",
			".dmg",
			".pkg",
			".deb",
			".rpm",
		];

		// 명시적으로 제외할 확장자 (이미지, 동영상 등)
		const excludedExtensions = [
			// 이미지 파일
			".jpg",
			".jpeg",
			".png",
			".gif",
			".bmp",
			".tiff",
			".tif",
			".webp",
			".svg",
			".ico",
			".raw",
			".cr2",
			".nef",
			".arw",
			".dng",
			".psd",
			".ai",
			".eps",
			// 동영상 파일
			".mp4",
			".avi",
			".mkv",
			".mov",
			".wmv",
			".flv",
			".webm",
			".m4v",
			".3gp",
			".mpg",
			".mpeg",
			".ts",
			".vob",
			".asf",
			".rm",
			".rmvb",
			".m2ts",
			".mts",
			// 음성 파일
			".mp3",
			".wav",
			".flac",
			".aac",
			".ogg",
			".wma",
			".m4a",
			// 문서 파일
			".txt",
			".doc",
			".docx",
			".pdf",
			".xls",
			".xlsx",
			".ppt",
			".pptx",
			".rtf",
			".odt",
			".ods",
			".odp",
		];

		const scanDirectory = (
			dirPath: string,
		): Promise<Array<{ path: string; name: string; size: number }>> => {
			return new Promise((resolve, reject) => {
				const results: Array<{
					path: string;
					name: string;
					size: number;
				}> = [];

				const processDirectory = async (currentPath: string): Promise<void> => {
					try {
						const items = await fs.promises.readdir(currentPath, {
							withFileTypes: true,
						});

						for (const item of items) {
							const fullPath = path.join(currentPath, item.name);

							if (item.isDirectory()) {
								// 재귀적으로 하위 디렉토리 탐색
								await processDirectory(fullPath);
							} else if (item.isFile()) {
								const ext = path.extname(item.name).toLowerCase();

								// 먼저 제외할 확장자인지 확인
								if (excludedExtensions.includes(ext)) {
									continue; // 제외 대상이면 건너뛰기
								}

								// 압축파일 확장자인지 확인
								if (archiveExtensions.includes(ext)) {
									try {
										const stats = await fs.promises.stat(fullPath);
										results.push({
											path: fullPath,
											name: item.name,
											size: stats.size,
										});
									} catch (statError) {
										console.warn(`파일 정보 읽기 실패: ${fullPath}`, statError);
									}
								}
							}
						}
					} catch (error) {
						console.warn(`디렉토리 읽기 실패: ${currentPath}`, error);
					}
				};

				processDirectory(dirPath)
					.then(() => resolve(results))
					.catch(reject);
			});
		};

		try {
			const files = await scanDirectory(targetPath);
			return files;
		} catch (error) {
			console.error("파일 스캔 중 오류 발생:", error);
			throw error;
		}
	});

	// 파일 삭제 IPC 핸들러
	ipcMain.handle("delete-file", async (_, filePath: string) => {
		try {
			// 파일 존재 여부 확인
			const exists = await fs.promises
				.access(filePath)
				.then(() => true)
				.catch(() => false);
			if (!exists) {
				throw new Error("파일이 존재하지 않습니다.");
			}

			// 파일 삭제 실행
			await fs.promises.unlink(filePath);
			return { success: true, message: "파일이 성공적으로 삭제되었습니다." };
		} catch (error) {
			console.error("파일 삭제 중 오류 발생:", error);
			throw error;
		}
	});

	// BandiView로 파일 열기 IPC 핸들러 (설정값 사용하도록 수정)
	ipcMain.handle("open-with-bandiview", async (_, filePath: string) => {
		const settings = await _loadSettings();
		const bandiViewPath = settings.bandiViewPath;

		try {
			// 파일 존재 여부 확인
			const fileExists = await fs.promises
				.access(filePath)
				.then(() => true)
				.catch(() => false);
			if (!fileExists) {
				throw new Error("파일이 존재하지 않습니다.");
			}

			// BandiView 실행 파일 존재 여부 확인
			const bandiViewExists = await fs.promises
				.access(bandiViewPath)
				.then(() => true)
				.catch(() => false);
			if (!bandiViewExists) {
				throw new Error(
					"BandiView가 설치되어 있지 않거나 경로를 찾을 수 없습니다.",
				);
			}

			// BandiView로 파일 열기
			const child = spawn(bandiViewPath, [filePath], {
				detached: true,
				stdio: "ignore",
			});

			child.unref(); // 부모 프로세스와 분리하여 독립 실행

			return { success: true, message: "BandiView로 파일을 열었습니다." };
		} catch (error) {
			console.error("BandiView로 파일 열기 실패:", error);
			throw error;
		}
	});

	// 중복 파일 체크 IPC 핸들러
	ipcMain.handle(
		"check-duplicate-files",
		async (
			_,
			fileList: Array<{ path: string; name: string; size: number }>,
			scanPath: string,
		) => {
			const settings = await _loadSettings();
			const storePath = settings.storePath;

			if (!storePath) {
				throw new Error(
					"저장소 경로가 설정되지 않았습니다. 설정에서 저장소 경로를 먼저 설정해주세요.",
				);
			}

			const duplicates: Array<{
				sourceFile: string;
				sourcePath: string;
				sourceSize: number;
				targetPath: string;
				targetSize: number;
				relativePath: string;
			}> = [];

			for (const file of fileList) {
				// 스캔 경로를 기준으로 상대 경로 계산
				const relativePath = path.relative(scanPath, file.path);
				const targetPath = path.join(storePath, relativePath);

				// 대상 경로에 파일이 이미 존재하는지 확인
				const targetExists = await fs.promises
					.access(targetPath)
					.then(() => true)
					.catch(() => false);

				if (targetExists) {
					try {
						// 기존 파일의 크기 정보 가져오기
						const targetStats = await fs.promises.stat(targetPath);
						duplicates.push({
							sourceFile: file.name,
							sourcePath: file.path,
							sourceSize: file.size,
							targetPath: targetPath,
							targetSize: targetStats.size,
							relativePath: relativePath,
						});
					} catch (error) {
						console.warn(`기존 파일 정보 읽기 실패: ${targetPath}`, error);
						// 파일 정보를 읽을 수 없어도 중복으로 처리
						duplicates.push({
							sourceFile: file.name,
							sourcePath: file.path,
							sourceSize: file.size,
							targetPath: targetPath,
							targetSize: -1, // 읽기 실패 표시
							relativePath: relativePath,
						});
					}
				}
			}

			return {
				hasDuplicates: duplicates.length > 0,
				duplicates,
				totalFiles: fileList.length,
			};
		},
	);

	// 파일 이동 IPC 핸들러
	ipcMain.handle(
		"move-all-files-to-store",
		async (
			_,
			fileList: Array<{ path: string; name: string; size: number }>,
			scanPath: string,
			_duplicateActions: Record<string, "overwrite" | "skip"> = {},
		) => {
			const settings = await _loadSettings();
			const storePath = settings.storePath;

			if (!storePath) {
				throw new Error(
					"저장소 경로가 설정되지 않았습니다. 설정에서 저장소 경로를 먼저 설정해주세요.",
				);
			}

			// 저장소 경로 존재 여부 확인
			const storeExists = await fs.promises
				.access(storePath)
				.then(() => true)
				.catch(() => false);
			if (!storeExists) {
				throw new Error("저장소 경로가 존재하지 않거나 접근할 수 없습니다.");
			}

			const results: Array<{
				file: string;
				success: boolean;
				error?: string;
				action?: string;
				targetPath?: string;
			}> = [];

			for (const file of fileList) {
				try {
					// 원본 파일 존재 여부 확인
					const sourceExists = await fs.promises
						.access(file.path)
						.then(() => true)
						.catch(() => false);
					if (!sourceExists) {
						results.push({
							file: file.name,
							success: false,
							error: "파일이 존재하지 않습니다.",
						});
						continue;
					}

					// 스캔 경로를 기준으로 상대 경로 계산하여 폴더 구조 유지
					const relativePath = path.relative(scanPath, file.path);
					const targetPath = path.join(storePath, relativePath);

					// 대상 폴더가 없으면 생성
					const targetDir = path.dirname(targetPath);
					await fs.promises.mkdir(targetDir, { recursive: true });

					// 이미 같은 파일이 있는지 확인
					const targetExists = await fs.promises
						.access(targetPath)
						.then(() => true)
						.catch(() => false);

					if (targetExists) {
						// 개별 파일별 처리 방식 확인
						const action =
							_duplicateActions[relativePath] || _duplicateActions[file.name];

						if (action === "skip") {
							// 건너뛰기
							results.push({
								file: file.name,
								success: true,
								action: "건너뜀",
								targetPath: relativePath,
							});
						} else if (action === "overwrite") {
							await fs.promises.rename(file.path, targetPath);
							results.push({
								file: file.name,
								success: true,
								action: "덮어쓰기",
								targetPath: relativePath,
							});
						} else {
							// 기본값: 자동으로 번호를 붙여서 새 파일명 생성
							const fileExt = path.extname(targetPath);
							const baseName = path.basename(targetPath, fileExt);
							const baseDir = path.dirname(targetPath);
							let counter = 1;
							let finalTargetPath: string;

							do {
								finalTargetPath = path.join(
									baseDir,
									`${baseName}_${counter}${fileExt}`,
								);
								counter++;
							} while (
								await fs.promises
									.access(finalTargetPath)
									.then(() => true)
									.catch(() => false)
							);

							await fs.promises.rename(file.path, finalTargetPath);
							results.push({
								file: file.name,
								success: true,
								action: "이름 변경",
								targetPath: path.relative(storePath, finalTargetPath),
							});
						}
					} else {
						// 중복되지 않은 파일은 일반 이동
						await fs.promises.rename(file.path, targetPath);
						results.push({
							file: file.name,
							success: true,
							action: "이동",
							targetPath: relativePath,
						});
					}
				} catch (error) {
					console.error(`파일 이동 실패: ${file.name}`, error);
					results.push({
						file: file.name,
						success: false,
						error: error instanceof Error ? error.message : "알 수 없는 오류",
					});
				}
			}

			// 결과 요약
			const successCount = results.filter((r) => r.success).length;
			const failCount = results.filter((r) => !r.success).length;

			return {
				success: failCount === 0,
				results,
				summary: {
					total: fileList.length,
					success: successCount,
					failed: failCount,
				},
			};
		},
	);

	createWindow();

	app.on("activate", () => {
		// On macOS it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
