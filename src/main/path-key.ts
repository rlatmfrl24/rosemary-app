import * as path from "node:path";

export const getPathKey = (
	filePath: string,
	platform = process.platform,
): string => {
	const resolved = path.resolve(filePath);
	return platform === "win32" ? resolved.toLowerCase() : resolved;
};
