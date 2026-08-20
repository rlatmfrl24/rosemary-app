export const HITOMI_API_HOST = "127.0.0.1";
export const HITOMI_API_PORT = 16009;
export const HITOMI_API_BASE_URL = `http://${HITOMI_API_HOST}:${HITOMI_API_PORT}`;

const UPSTREAM_BINDING = `http.server.ThreadingHTTPServer(("${HITOMI_API_HOST}", 6009), RequestHandler)`;
const CONFIGURED_BINDING = `http.server.ThreadingHTTPServer(("${HITOMI_API_HOST}", ${HITOMI_API_PORT}), RequestHandler)`;

export const configureHitomiApiScript = (scriptBuffer: Buffer): Buffer => {
	const scriptText = scriptBuffer.toString("utf8");
	if (scriptText.includes(CONFIGURED_BINDING)) {
		return scriptBuffer;
	}

	const bindingCount = scriptText.split(UPSTREAM_BINDING).length - 1;
	if (bindingCount !== 1) {
		throw new Error(
			"Hitomi API 확장 파일의 서버 설정 형식이 예상과 달라 안전하게 설치할 수 없습니다.",
		);
	}

	return Buffer.from(
		scriptText.replace(UPSTREAM_BINDING, CONFIGURED_BINDING),
		"utf8",
	);
};
