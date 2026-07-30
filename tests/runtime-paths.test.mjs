import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveRuntimeProfilePaths } from "../src/main/runtime-paths.ts";

test("설치판은 Electron 기본 프로필 경로를 유지한다", () => {
	assert.deepEqual(
		resolveRuntimeProfilePaths({
			appDataPath: "C:\\Users\\fixture\\AppData\\Roaming",
			appName: "rosemary-app",
			isPackaged: true,
		}),
		{
			mode: "default",
			userDataPath: null,
			sessionDataPath: null,
		},
	);
});

test("개발판은 설치판과 분리된 데이터·캐시 프로필을 사용한다", () => {
	const appDataPath = path.resolve("fixture-app-data");
	const userDataPath = path.join(appDataPath, "rosemary-app-development");
	assert.deepEqual(
		resolveRuntimeProfilePaths({
			appDataPath,
			appName: "rosemary-app",
			isPackaged: false,
		}),
		{
			mode: "development",
			userDataPath,
			sessionDataPath: path.join(userDataPath, "session-data"),
		},
	);
});

test("명시한 검증 프로필은 개발·설치 여부보다 우선한다", () => {
	const validationPath = path.resolve("fixture-validation");
	assert.deepEqual(
		resolveRuntimeProfilePaths({
			appDataPath: path.resolve("fixture-app-data"),
			appName: "rosemary-app",
			isPackaged: false,
			validationUserDataPath: `  ${validationPath}  `,
		}),
		{
			mode: "validation",
			userDataPath: validationPath,
			sessionDataPath: path.join(validationPath, "session-data"),
		},
	);
});
