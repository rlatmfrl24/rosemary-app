import { statSync } from "node:fs";
import * as path from "node:path";

export const getPathKey = (
	filePath: string,
	platform = process.platform,
): string => {
	const resolved = path.resolve(filePath);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
};

export const isSamePath = (
	leftPath: string,
	rightPath: string,
	platform = process.platform,
): boolean => {
	const left = getPathKey(leftPath, platform);
	const right = getPathKey(rightPath, platform);
	if (left === right) return true;
	if (platform !== "darwin" || left.toLowerCase() !== right.toLowerCase())
		return false;
	// APFS can be case-sensitive or insensitive: compare the actual file identity.
	try {
		const leftStat = statSync(left, { bigint: true });
		const rightStat = statSync(right, { bigint: true });
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
};
