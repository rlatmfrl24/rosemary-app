import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const coverage = process.argv.includes("--coverage");
const directory = coverage
	? await mkdtemp(path.join(tmpdir(), "rosemary-coverage-"))
	: null;
try {
	const files = (await readdir(path.join(root, "tests")))
		.filter((name) => name.endsWith(".test.mjs"))
		.sort()
		.map((name) => path.join("tests", name));
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--test",
			...(coverage
				? ["--experimental-test-coverage", "--test-coverage-include=**/src/**"]
				: []),
			...files,
		],
		{
			cwd: root,
			stdio: "inherit",
			env: directory
				? { ...process.env, NODE_V8_COVERAGE: directory }
				: process.env,
		},
	);
	const code = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (value) => resolve(value ?? 1));
	});
	process.exitCode = code;
	if (directory) {
		const loaded = new Set();
		for (const name of await readdir(directory)) {
			const data = JSON.parse(
				await readFile(path.join(directory, name), "utf8"),
			);
			for (const script of data.result) {
				if (script.url.startsWith("file:"))
					loaded.add(path.normalize(fileURLToPath(script.url)));
			}
		}
		const sources = (
			await readdir(path.join(root, "src"), { recursive: true })
		).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"));
		const unloaded = sources
			.filter((name) => !loaded.has(path.join(root, "src", name)))
			.sort();
		console.log(
			`\n소스 측정 범위: ${sources.length - unloaded.length}/${sources.length}개 로드. 아래 소스는 미측정이며 위 커버리지 비율에 포함되지 않습니다.`,
		);
		for (const name of unloaded)
			console.log(`미측정: src/${name.replaceAll("\\", "/")}`);
	}
} finally {
	if (directory) await rm(directory, { recursive: true, force: true });
}
