import { spawn } from "node:child_process";
import * as fs from "node:fs";

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
): void => {
	const child = spawn(executablePath, args, {
		detached: true,
		stdio: "ignore",
	});

	child.unref();
};
