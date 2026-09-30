import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const delay = async (delayMs: number): Promise<void> => {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, delayMs);
	});
};

export const pathExists = async (targetPath: string): Promise<boolean> => {
	return await fs.promises
		.access(targetPath)
		.then(() => true)
		.catch(() => false);
};

export const ensurePathExists = async (
	targetPath: string,
	errorMessage: string,
): Promise<void> => {
	const exists = await pathExists(targetPath);
	if (!exists) {
		throw new Error(errorMessage);
	}
};

export const launchDetachedProcess = (
	executablePath: string,
	args: string[] = [],
): Promise<void> => {
	return new Promise((resolve, reject) => {
		const child = spawn(executablePath, args, {
			detached: true,
			stdio: "ignore",
			cwd: path.dirname(executablePath),
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
};

const pendingLaunches = new Map<string, Promise<boolean>>();

export const ensureProcessRunning = (
	executablePath: string,
): Promise<boolean> => {
	const pending = pendingLaunches.get(executablePath);
	if (pending) return pending;
	const launch = (async () => {
		let launched = false;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (await isProcessRunningByExecutablePath(executablePath))
				return launched;
			try {
				await launchDetachedProcess(executablePath);
				launched = true;
				if (await waitForProcessByExecutablePath(executablePath, 10000))
					return true;
			} catch (error) {
				if (attempt === 1) {
					throw new Error(
						`다운로더 자동 실행을 두 번 시도했지만 실패했습니다: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
		throw new Error(
			"다운로더 자동 실행을 두 번 시도했지만 실행 중인 프로세스를 확인하지 못했습니다.",
		);
	})();
	pendingLaunches.set(executablePath, launch);
	void launch
		.finally(() => pendingLaunches.delete(executablePath))
		.catch(() => {});
	return launch;
};

export const isProcessRunningByExecutablePath = async (
	executablePath: string,
): Promise<boolean> => {
	const imageName = path.basename(executablePath);
	if (!imageName) {
		return false;
	}

	if (process.platform !== "win32") {
		return false;
	}

	try {
		const { stdout } = await execFileAsync(
			"tasklist",
			["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
			{ windowsHide: true },
		);
		const normalizedImageName = imageName.toLowerCase();

		return stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean)
			.some((line) => {
				const firstColumn = line.split(",")[0]?.replace(/^"|"$/g, "");
				return firstColumn?.toLowerCase() === normalizedImageName;
			});
	} catch (error) {
		console.warn("프로세스 실행 여부 확인 실패:", error);
		return false;
	}
};

export const waitForProcessByExecutablePath = async (
	executablePath: string,
	timeoutMs: number,
	intervalMs = 500,
): Promise<boolean> => {
	const startedAt = Date.now();

	while (Date.now() - startedAt < timeoutMs) {
		if (await isProcessRunningByExecutablePath(executablePath)) {
			return true;
		}

		await delay(intervalMs);
	}

	return await isProcessRunningByExecutablePath(executablePath);
};
