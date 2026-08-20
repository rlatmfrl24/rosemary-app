import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const executablePath = path.join(
	projectRoot,
	"dist",
	"win-unpacked",
	"rosemary-app.exe",
);
await access(executablePath);

const profilePath = await mkdtemp(
	path.join(tmpdir(), "rosemary-packaged-smoke-"),
);
const output = [];
const child = spawn(executablePath, [], {
	cwd: path.dirname(executablePath),
	env: {
		...process.env,
		ELECTRON_ENABLE_LOGGING: "1",
		ROSEMARY_VALIDATION_USER_DATA_PATH: profilePath,
	},
	stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

const exitPromise = new Promise((resolve, reject) => {
	child.once("error", reject);
	child.once("exit", (code, signal) => {
		resolve({ code, signal });
	});
});

try {
	const result = await Promise.race([
		exitPromise,
		new Promise((resolve) => {
			setTimeout(() => resolve(null), 4_000);
		}),
	]);

	if (result) {
		throw new Error(
			`패키징된 Rosemary가 조기에 종료되었습니다. code=${result.code}, signal=${result.signal}`,
		);
	}

	console.log(`패키징된 Rosemary 시작 유지 테스트 통과: ${executablePath}`);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error("--- Electron 로그 ---");
	console.error(output.join("").trim());
	process.exitCode = 1;
} finally {
	if (child.exitCode === null) {
		child.kill();
		await Promise.race([
			exitPromise,
			new Promise((resolve) => {
				setTimeout(resolve, 2_000);
			}),
		]);
	}
	await rm(profilePath, { recursive: true, force: true, maxRetries: 3 });
}
