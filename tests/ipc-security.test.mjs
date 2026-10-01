import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
	assertTrustedSender,
	getExternalHttpsUrl,
	isAppEntry,
	registerTrustedContents,
} from "../src/main/ipc-security.ts";
import { loadMainModules } from "./helpers/main-modules.mjs";

const root = await fs.mkdtemp(path.join(tmpdir(), "rosemary-ipc-"));
const close = loadMainModules(root);
const { validateIpcInputs } = await import("../src/main/ipc-inputs.ts");
after(async () => {
	close();
	await fs.rm(root, { recursive: true, force: true });
});

test("IPC는 등록된 앱 진입점의 최상위 프레임만 허용한다", () => {
	const sender = new EventEmitter();
	sender.mainFrame = { url: "file:///app/index.html", parent: null };
	const event = { sender, senderFrame: sender.mainFrame };
	assert.throws(() => assertTrustedSender(event));
	registerTrustedContents(sender, "file:///app/index.html");
	assert.doesNotThrow(() => assertTrustedSender(event));
	assert.throws(() =>
		assertTrustedSender({
			sender,
			senderFrame: { ...sender.mainFrame, parent: sender.mainFrame },
		}),
	);
	sender.mainFrame.url = "https://example.com/";
	assert.throws(() => assertTrustedSender(event));
	sender.mainFrame.url = "file:///app/index.html#files";
	assert.doesNotThrow(() => assertTrustedSender(event));
	sender.emit("destroyed");
	assert.throws(() => assertTrustedSender(event));
	assert.equal(
		isAppEntry("file:///app/other.html", "file:///app/index.html"),
		false,
	);
	assert.equal(
		isAppEntry("file:///app/index.html?other", "file:///app/index.html"),
		false,
	);
});

test("외부 열기는 자격 정보 없는 HTTPS URL만 허용한다", () => {
	assert.equal(
		getExternalHttpsUrl("https://example.com/g/123/"),
		"https://example.com/g/123/",
	);
	for (const url of [
		"http://example.com",
		"file:///tmp/a",
		"javascript:alert(1)",
		"https://user:pass@example.com",
		"invalid",
	])
		assert.throws(() => getExternalHttpsUrl(url));
});

test("IPC 경계에서 잘못된 경로·설정·배열·옵션을 거부하고 실제 API 선택값을 허용한다", async () => {
	for (const [channel, args] of [
		["copy-file", ["relative.zip", root]],
		["scan-files", ["bad\0path"]],
		["save-settings", [{ hitomiApiEnabled: "true" }]],
		["trash-files", [[root, 1]]],
		["crawl-start", [{ maxPages: Number.NaN }]],
		[
			"check-duplicate-files",
			[[{ path: path.join(root, "a.zip"), name: "other.zip", size: 1 }], root],
		],
		["move-group-to-folder", [root, [], "../escape"]],
		["get-settings", ["unexpected"]],
		["unknown-channel", []],
	])
		assert.throws(() => validateIpcInputs(channel, args), channel);
	for (const queue of ["safe", "cleanup", "series", "merge", "suspicious"])
		for (const contentScanMode of ["off", "metadata", "smart", "sample"])
			assert.doesNotThrow(() =>
				validateIpcInputs("find-similar-groups", [
					{
						sourcePath: root,
						recursive: true,
						minGroupSize: 2,
						minConfidence: 80,
						queue,
						contentScanMode,
					},
				]),
			);
	for (const status of ["ignored", "confirmed"])
		assert.doesNotThrow(() =>
			validateIpcInputs("mark-similar-group-review-state", [
				{ reviewKey: "key", contentSignature: "signature", status },
			]),
		);
	// Every registered channel is guarded; no general-purpose renderer bridge remains.
	const ipc = await fs.readFile(
		new URL("../src/main/ipc.ts", import.meta.url),
		"utf8",
	);
	assert.equal((ipc.match(/ipcMain\.handle\(/g) ?? []).length, 1);
	const preload = await fs.readFile(
		new URL("../src/preload/index.ts", import.meta.url),
		"utf8",
	);
	assert.ok(!preload.includes('exposeInMainWorld("electron"'));
});
