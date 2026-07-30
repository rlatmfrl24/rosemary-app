import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import electronPath from "electron";

const projectRoot = path.resolve(import.meta.dirname, "..");
const profilePath = await mkdtemp(path.join(tmpdir(), "rosemary-smoke-"));
const output = [];
let timedOut = false;

const child = spawn(electronPath, [projectRoot], {
	cwd: projectRoot,
	env: {
		...process.env,
		ROSEMARY_SMOKE_TEST: "1",
		ROSEMARY_VALIDATION_USER_DATA_PATH: profilePath,
	},
	stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => output.push(chunk.toString()));
child.stderr.on("data", (chunk) => output.push(chunk.toString()));

const timeout = setTimeout(() => {
	timedOut = true;
	child.kill();
}, 15_000);

const exitCode = await new Promise((resolve, reject) => {
	child.once("error", reject);
	child.once("exit", (code) => resolve(code));
});
clearTimeout(timeout);

const logs = output.join("");
const cacheFailurePattern =
	/Unable to (?:move|create) the cache|Gpu Cache Creation failed|GPU state invalid/i;
const ready = logs.includes("[Rosemary 시작] 준비 완료");

try {
	if (timedOut)
		throw new Error("Electron 시작이 15초 안에 완료되지 않았습니다.");
	if (exitCode !== 0) {
		throw new Error(`Electron이 종료 코드 ${exitCode}로 종료되었습니다.`);
	}
	if (!ready) throw new Error("앱 준비 완료 로그를 확인하지 못했습니다.");
	if (cacheFailurePattern.test(logs)) {
		throw new Error("Chromium 캐시 생성 또는 이동 오류가 다시 발생했습니다.");
	}

	console.log(`Electron 시작 스모크 테스트 통과: ${profilePath}`);
	if (logs.includes("ExperimentalWarning: SQLite is an experimental feature")) {
		console.log(
			"참고: SQLite ExperimentalWarning은 Electron 내장 Node.js의 기능 상태 안내이며 앱 시작 실패가 아닙니다.",
		);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error("--- Electron 로그 ---");
	console.error(logs.trim());
	process.exitCode = 1;
} finally {
	await rm(profilePath, { recursive: true, force: true, maxRetries: 3 });
}
