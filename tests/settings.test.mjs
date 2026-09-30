import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { loadMainModules } from "./helpers/main-modules.mjs";

const root = await fs.promises.mkdtemp(
	path.join(tmpdir(), "rosemary-settings-"),
);
const close = loadMainModules(root);
const { loadSettings, saveSettings, defaultSettings } = await import(
	"../src/main/settings.ts"
);
const settingsPath = path.join(root, "settings.json");
after(async () => {
	close();
	await fs.promises.rm(root, { recursive: true, force: true });
});

test("연속 저장은 순서와 마지막 정상 백업을 유지한다", async () => {
	const values = ["first", "second", "last"].map((storePath) => ({
		...defaultSettings,
		storePath,
	}));
	assert.deepEqual(await Promise.all(values.map(saveSettings)), [
		true,
		true,
		true,
	]);
	assert.equal((await loadSettings()).storePath, "last");
	assert.equal(
		JSON.parse(await fs.promises.readFile(`${settingsPath}.bak`, "utf8"))
			.storePath,
		"second",
	);
	assert.equal(
		await saveSettings({ ...values[2], hitomiApiEnabled: "yes" }),
		false,
	);
	assert.equal((await loadSettings()).storePath, "last");
});

test("손상은 백업으로 복구하고 복구 불가능한 원본은 보존한다", async () => {
	await fs.promises.writeFile(settingsPath, "broken");
	assert.equal((await loadSettings()).storePath, "second");
	const corrupt = (await fs.promises.readdir(root)).find((name) =>
		name.endsWith(".corrupt"),
	);
	assert.equal(
		await fs.promises.readFile(path.join(root, corrupt), "utf8"),
		"broken",
	);
	await fs.promises.writeFile(settingsPath, "unrecoverable");
	await fs.promises.writeFile(`${settingsPath}.bak`, "broken backup");
	await assert.rejects(loadSettings(), /원본을 보존/);
	assert.equal(
		await fs.promises.readFile(settingsPath, "utf8"),
		"unrecoverable",
	);
	assert.equal(
		await saveSettings({ ...defaultSettings, storePath: "repaired" }),
		true,
	);
	assert.equal((await loadSettings()).storePath, "repaired");
	const originals = await Promise.all(
		(await fs.promises.readdir(root))
			.filter((name) => name.endsWith(".corrupt"))
			.map((name) => fs.promises.readFile(path.join(root, name), "utf8")),
	);
	assert.ok(originals.includes("unrecoverable"));
	assert.ok(originals.includes("broken backup"));
	assert.equal(
		JSON.parse(await fs.promises.readFile(`${settingsPath}.bak`, "utf8"))
			.storePath,
		"repaired",
	);
});

test("교체 실패 후 현재 설정이 남고 다음 저장을 수행한다", async (t) => {
	await fs.promises.writeFile(
		settingsPath,
		JSON.stringify({ ...defaultSettings, storePath: "before" }),
	);
	await fs.promises.writeFile(
		`${settingsPath}.bak`,
		JSON.stringify(defaultSettings),
	);
	const rename = fs.promises.rename;
	const replacement = t.mock.method(fs.promises, "rename", async (from, to) => {
		if (to === settingsPath) throw new Error("replace failed");
		return rename(from, to);
	});
	syncBuiltinESMExports();
	assert.equal(
		await saveSettings({ ...defaultSettings, storePath: "failed" }),
		false,
	);
	assert.equal((await loadSettings()).storePath, "before");
	assert.ok(
		!(await fs.promises.readdir(root)).some((name) => name.endsWith(".tmp")),
	);
	replacement.mock.restore();
	syncBuiltinESMExports();
	assert.equal(
		await saveSettings({ ...defaultSettings, storePath: "after" }),
		true,
	);
	assert.equal((await loadSettings()).storePath, "after");
});
