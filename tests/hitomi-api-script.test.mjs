import assert from "node:assert/strict";
import test from "node:test";
import {
	configureHitomiApiScript,
	HITOMI_API_BASE_URL,
} from "../src/main/hitomi-api-script.ts";

test("Windows 예약 포트를 피해 Hitomi API 서버 포트를 변경한다", () => {
	const upstreamScript = Buffer.from(
		'prefix\n    server = http.server.ThreadingHTTPServer(("127.0.0.1", 6009), RequestHandler)\nsuffix\n',
		"utf8",
	);

	const configuredScript =
		configureHitomiApiScript(upstreamScript).toString("utf8");

	assert.equal(HITOMI_API_BASE_URL, "http://127.0.0.1:16009");
	assert.match(configuredScript, /"127\.0\.0\.1", 16009/);
	assert.doesNotMatch(configuredScript, /"127\.0\.0\.1", 6009/);
});

test("이미 변경된 Hitomi API 확장 파일은 그대로 유지한다", () => {
	const configuredScript = Buffer.from(
		'http.server.ThreadingHTTPServer(("127.0.0.1", 16009), RequestHandler)',
		"utf8",
	);

	assert.equal(configureHitomiApiScript(configuredScript), configuredScript);
});

test("예상하지 못한 서버 형식은 손상시키지 않고 설치를 중단한다", () => {
	assert.throws(
		() => configureHitomiApiScript(Buffer.from("unexpected upstream script")),
		/서버 설정 형식이 예상과 달라/,
	);
});
