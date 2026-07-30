import * as path from "node:path";

export interface RuntimeProfilePaths {
	mode: "default" | "development" | "validation";
	userDataPath: string | null;
	sessionDataPath: string | null;
}

export const resolveRuntimeProfilePaths = (options: {
	appDataPath: string;
	appName: string;
	isPackaged: boolean;
	validationUserDataPath?: string;
}): RuntimeProfilePaths => {
	const validationPath = options.validationUserDataPath?.trim();
	if (validationPath) {
		const userDataPath = path.resolve(validationPath);
		return {
			mode: "validation",
			userDataPath,
			sessionDataPath: path.join(userDataPath, "session-data"),
		};
	}

	if (!options.isPackaged) {
		const userDataPath = path.join(
			options.appDataPath,
			`${options.appName}-development`,
		);
		return {
			mode: "development",
			userDataPath,
			sessionDataPath: path.join(userDataPath, "session-data"),
		};
	}

	return {
		mode: "default",
		userDataPath: null,
		sessionDataPath: null,
	};
};
