import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
	type DownloadSource,
	getDownloadSourceKey,
	parseDownloadSource,
	validateDownloadSource,
} from "../shared/hitomi-download.ts";
import type {
	AppSettings,
	HitomiApiInstallResult,
	HitomiApiPrepareResult,
	HitomiApiSendFailure,
	HitomiApiSendResult,
	HitomiApiStatusResult,
} from "../shared/settings";
import {
	configureHitomiApiScript,
	HITOMI_API_BASE_URL,
} from "./hitomi-api-script.ts";
import {
	claimDownloadRequest,
	ensureDownloadRequest,
	finishDownloadRequest,
	getDownloadRequest,
} from "./hitomi-download-store.ts";
import {
	ensurePathExists,
	ensureProcessRunning,
	launchDetachedProcess,
	pathExists,
} from "./process-utils.ts";

const HITOMI_API_SCRIPT_DOWNLOAD_URL =
	"https://github.com/Hitomi-Downloader-extension/api/releases/download/0.1.0/api.hds";
const HITOMI_API_REQUEST_TIMEOUT_MS = 5000;
const HITOMI_API_INSTALL_DOWNLOAD_TIMEOUT_MS = 15000;
const HITOMI_API_PING_TIMEOUT_MS = 1000;
const HITOMI_API_INSTALL_PING_WAIT_MS = 10000;
const HITOMI_API_SEND_LAUNCH_WAIT_MS = 15000;
const HITOMI_API_INSTALL_PING_INTERVAL_MS = 500;

interface HitomiApiRequestResult {
	ok: boolean;
	statusCode: number | null;
	data: Record<string, unknown> | null;
	message: string;
}

interface HitomiApiReadyResult {
	status: HitomiApiStatusResult;
	launched: boolean;
}

const delay = async (delayMs: number): Promise<void> => {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, delayMs);
	});
};

const formatTimestamp = (date: Date): string => {
	const pad = (value: number): string => value.toString().padStart(2, "0");

	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
};

const getConfiguredHitomiPath = (settings: AppSettings): string => {
	const executablePath = settings.hitomiDownloaderPath.trim();
	if (!executablePath) {
		throw new Error(
			"Hitomi Downloader 실행 파일 경로가 설정되지 않았습니다. 설정에서 먼저 지정해주세요.",
		);
	}

	return executablePath;
};

const buildApiScriptPath = (
	executablePath: string,
): { scriptsDirectory: string; scriptPath: string } => {
	const scriptsDirectory = path.join(path.dirname(executablePath), "scripts");

	return {
		scriptsDirectory,
		scriptPath: path.join(scriptsDirectory, "api.hds"),
	};
};

const parseResponseBody = async (
	response: Response,
): Promise<Record<string, unknown> | null> => {
	const rawBody = await response.text();
	if (!rawBody.trim()) {
		return null;
	}

	try {
		return JSON.parse(rawBody) as Record<string, unknown>;
	} catch {
		return { rawBody };
	}
};

const getErrorMessage = (error: unknown): string => {
	if (error instanceof Error) {
		if (error.name === "AbortError") {
			return "요청 시간이 초과되었습니다.";
		}

		return error.message;
	}

	return "알 수 없는 오류";
};

const requestHitomiApi = async (
	endpoint: string,
	options: RequestInit = {},
	timeoutMs = HITOMI_API_REQUEST_TIMEOUT_MS,
): Promise<HitomiApiRequestResult> => {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	try {
		const response = await fetch(`${HITOMI_API_BASE_URL}${endpoint}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});
		const data = await parseResponseBody(response);

		return {
			ok: response.ok,
			statusCode: response.status,
			data,
			message: response.ok
				? "요청이 성공했습니다."
				: `Hitomi API 요청이 실패했습니다. (${response.status})`,
		};
	} catch (error) {
		return {
			ok: false,
			statusCode: null,
			data: null,
			message: getErrorMessage(error),
		};
	} finally {
		clearTimeout(timeoutId);
	}
};

const downloadHitomiApiScript = async (): Promise<Buffer> => {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort();
	}, HITOMI_API_INSTALL_DOWNLOAD_TIMEOUT_MS);

	try {
		const response = await fetch(HITOMI_API_SCRIPT_DOWNLOAD_URL, {
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(
				`Hitomi API 확장 파일 다운로드에 실패했습니다. (${response.status})`,
			);
		}

		return Buffer.from(await response.arrayBuffer());
	} catch (error) {
		throw new Error(
			`Hitomi API 확장 파일을 내려받지 못했습니다: ${getErrorMessage(error)}`,
		);
	} finally {
		clearTimeout(timeoutId);
	}
};

const createHitomiApiNotReadyStatus = async (
	settings: AppSettings,
	baseMessage: string,
): Promise<HitomiApiStatusResult> => {
	const executablePath = settings.hitomiDownloaderPath.trim();
	if (!executablePath) {
		return {
			connected: false,
			message:
				"Hitomi Downloader 실행 파일 경로가 설정되지 않았습니다. 설정에서 먼저 지정해주세요.",
		};
	}

	if (!(await pathExists(executablePath))) {
		return {
			connected: false,
			message:
				"Hitomi Downloader 실행 파일을 찾을 수 없습니다. 설정 경로를 확인해주세요.",
		};
	}

	const { scriptPath } = buildApiScriptPath(executablePath);
	if (!(await pathExists(scriptPath))) {
		return {
			connected: false,
			message:
				"Hitomi API 확장 파일이 설치되어 있지 않습니다. 설정에서 API 확장 설치/활성화를 먼저 실행해주세요.",
		};
	}

	return {
		connected: false,
		message: `${baseMessage} API 확장 파일은 설치되어 있습니다. Hitomi Downloader가 이미 실행 중이었다면 트레이까지 완전히 종료한 뒤 다시 전송해주세요.`,
	};
};

const pingHitomiApi = async (): Promise<HitomiApiStatusResult> => {
	const result = await requestHitomiApi(
		"/ping",
		{ method: "GET" },
		HITOMI_API_PING_TIMEOUT_MS,
	);

	if (result.ok && result.data?.status === "ok") {
		return {
			connected: true,
			message: "Hitomi API에 연결되었습니다.",
		};
	}

	return {
		connected: false,
		message: result.ok
			? "Hitomi API 응답 형식을 확인할 수 없습니다. API 확장과 포트를 확인해주세요."
			: `Hitomi API에 연결할 수 없습니다. ${result.message}`,
	};
};

const diagnoseHitomiApiStatus = async (
	settings: AppSettings,
): Promise<HitomiApiStatusResult> => {
	const status = await pingHitomiApi();
	if (status.connected) {
		return status;
	}

	return await createHitomiApiNotReadyStatus(settings, status.message);
};

const waitForHitomiApiPing = async (
	timeoutMs: number,
): Promise<HitomiApiStatusResult> => {
	const startedAt = Date.now();
	let lastStatus: HitomiApiStatusResult = {
		connected: false,
		message: "Hitomi API 응답을 기다리는 중입니다.",
	};

	while (Date.now() - startedAt < timeoutMs) {
		lastStatus = await pingHitomiApi();
		if (lastStatus.connected) {
			return lastStatus;
		}

		await delay(HITOMI_API_INSTALL_PING_INTERVAL_MS);
	}

	return lastStatus;
};

const getFailureMessage = (result: HitomiApiRequestResult): string => {
	const errorValue = result.data?.error;
	if (typeof errorValue === "string") {
		return `${result.message}: ${errorValue}`;
	}

	return result.message;
};

const postHitomiCode = async (
	endpoint: "/valid_url" | "/download",
	code: string,
): Promise<HitomiApiRequestResult> => {
	return await requestHitomiApi(endpoint, {
		method: "POST",
		body: JSON.stringify({ gal_num: code }),
	});
};

const buildSendMessage = (
	total: number,
	sent: number,
	invalid: number,
	failed: number,
	launched: boolean,
): string => {
	if (total === 0) {
		return "전송할 원본이 없습니다.";
	}

	const launchText = launched ? "Hitomi Downloader를 실행한 뒤 " : "";
	return `${launchText}원본 ${total}개 중 접수 확인 ${sent}개(기존 기록 포함), 무효 ${invalid}개, 제출 전 실패 ${failed}개입니다.`;
};

const ensureHitomiApiReadyForSend = async (
	settings: AppSettings,
): Promise<HitomiApiReadyResult> => {
	try {
		const result = await prepareHitomiApiConnection(settings);

		return {
			status: {
				connected: result.apiConnected,
				message: result.message,
			},
			launched: result.launched,
		};
	} catch (error) {
		return {
			status: {
				connected: false,
				message: getErrorMessage(error),
			},
			launched: false,
		};
	}
};

export const installHitomiApiExtension = async (
	settings: AppSettings,
): Promise<HitomiApiInstallResult> => {
	const executablePath = getConfiguredHitomiPath(settings);
	await ensurePathExists(
		executablePath,
		"Hitomi Downloader 실행 파일을 찾을 수 없습니다. 설정 경로를 확인해주세요.",
	);

	const { scriptsDirectory, scriptPath } = buildApiScriptPath(executablePath);
	const scriptBuffer = configureHitomiApiScript(
		await downloadHitomiApiScript(),
	);
	await fs.promises.mkdir(scriptsDirectory, { recursive: true });

	let backupPath: string | null = null;
	if (await pathExists(scriptPath)) {
		backupPath = path.join(
			scriptsDirectory,
			`api.hds.bak-${formatTimestamp(new Date())}`,
		);
		await fs.promises.copyFile(scriptPath, backupPath);
	}

	await fs.promises.writeFile(scriptPath, scriptBuffer);
	await launchDetachedProcess(executablePath);

	const status = await waitForHitomiApiPing(HITOMI_API_INSTALL_PING_WAIT_MS);

	return {
		success: true,
		message: status.connected
			? "Hitomi API 확장을 설치하고 연결을 확인했습니다."
			: `Hitomi API 확장은 설치했습니다. 현재 실행 중인 Hitomi Downloader가 확장을 아직 읽지 못했다면 다음 전송 때 자동 실행 후 다시 연결을 확인합니다. ${status.message}`,
		installedPath: scriptPath,
		backupPath,
		launched: true,
		pingOk: status.connected,
	};
};

export const getHitomiApiStatus = async (): Promise<HitomiApiStatusResult> => {
	return await pingHitomiApi();
};

export const diagnoseHitomiApiConnection = async (
	settings: AppSettings,
): Promise<HitomiApiStatusResult> => {
	return await diagnoseHitomiApiStatus(settings);
};

export const prepareHitomiApiConnection = async (
	settings: AppSettings,
): Promise<HitomiApiPrepareResult> => {
	const executablePath = getConfiguredHitomiPath(settings);
	await ensurePathExists(
		executablePath,
		"Hitomi Downloader 실행 파일을 찾을 수 없습니다. 설정 경로를 확인해주세요.",
	);

	const { scriptPath } = buildApiScriptPath(executablePath);
	if (!(await pathExists(scriptPath))) {
		return {
			success: false,
			message:
				"Hitomi API 확장 파일이 설치되어 있지 않습니다. 설정에서 API 확장 설치/활성화를 먼저 실행해주세요.",
			path: executablePath,
			launched: false,
			running: false,
			apiConnected: false,
		};
	}

	const initialStatus = await pingHitomiApi();
	const launched =
		process.platform !== "win32" && initialStatus.connected
			? false
			: await ensureProcessRunning(executablePath);

	const apiStatus = initialStatus.connected
		? initialStatus
		: await waitForHitomiApiPing(HITOMI_API_SEND_LAUNCH_WAIT_MS);
	const running =
		process.platform === "win32" || apiStatus.connected ? true : null;
	if (!apiStatus.connected) {
		const diagnosticStatus = await createHitomiApiNotReadyStatus(
			settings,
			apiStatus.message,
		);

		return {
			success: false,
			message: diagnosticStatus.message,
			path: executablePath,
			launched,
			running,
			apiConnected: false,
		};
	}

	return {
		success: true,
		message: launched
			? "Hitomi Downloader를 실행하고 API 연결을 확인했습니다."
			: "Hitomi Downloader 실행 상태와 API 연결을 확인했습니다.",
		path: executablePath,
		launched,
		running: true,
		apiConnected: true,
	};
};

export const sendCodesToHitomiApi = async (
	codes: string[],
	settings: AppSettings,
	database: DatabaseSync,
): Promise<HitomiApiSendResult> => {
	return sendSourcesToHitomiApi(
		codes.map((code) =>
			parseDownloadSource(`https://hitomi.la/galleries/${code.trim()}.html`),
		),
		settings,
		database,
	);
};

export const sendSourcesToHitomiApi = async (
	sources: DownloadSource[],
	settings: AppSettings,
	database: DatabaseSync,
): Promise<HitomiApiSendResult> => {
	const unique = new Map(
		sources.map((value) => {
			const source = validateDownloadSource(value);
			return [getDownloadSourceKey(source), source] as const;
		}),
	);
	const failures: HitomiApiSendFailure[] = [];
	let ready: HitomiApiReadyResult | undefined;
	for (const requestedSource of unique.values()) {
		ensureDownloadRequest(database, requestedSource);
		const source = getDownloadRequest(database, requestedSource);
		if (!["pending", "failed"].includes(source.status)) continue;
		ready ??= await ensureHitomiApiReadyForSend(settings);
		if (!ready.status.connected) {
			finishDownloadRequest(
				database,
				source,
				"failed",
				ready.status.message,
				false,
			);
			failures.push({
				code: source.galleryId,
				stage: "ping",
				message: ready.status.message,
				statusCode: null,
			});
			continue;
		}
		const validResult = await postHitomiCode("/valid_url", source.sourceUrl);
		const types = validResult.data?.type;
		if (
			!validResult.ok ||
			!Array.isArray(types) ||
			!types.length ||
			types.some((value) => typeof value !== "string")
		) {
			const isInvalid =
				validResult.statusCode === 400 &&
				validResult.data?.error === "not_valid";
			const message = isInvalid
				? "Hitomi Downloader에서 지원하지 않는 원본 URL입니다."
				: validResult.ok
					? "원본 URL 검증 응답의 형식이 올바르지 않습니다."
					: getFailureMessage(validResult);
			finishDownloadRequest(
				database,
				source,
				isInvalid ? "invalid" : "failed",
				message,
				false,
			);
			failures.push({
				code: source.galleryId,
				stage: "valid_url",
				message,
				statusCode: validResult.statusCode,
			});
			continue;
		}
		// Persist the claim before POST: a lost response must never permit a second submission.
		if (!claimDownloadRequest(database, source)) continue;
		const downloadResult = await postHitomiCode("/download", source.sourceUrl);
		if (!downloadResult.ok || downloadResult.data?.status !== "ok") {
			const message =
				"요청을 시도했으나 접수 여부를 확인할 수 없습니다. 중복 방지를 위해 재전송을 보류합니다.";
			finishDownloadRequest(database, source, "unknown", message, true);
			failures.push({
				code: source.galleryId,
				stage: "download",
				message,
				statusCode: downloadResult.statusCode,
			});
		} else {
			finishDownloadRequest(database, source, "sent", null, true);
		}
	}
	const receipts = [...unique.values()].map((source) =>
		getDownloadRequest(database, source),
	);
	const sent = receipts.filter((item) => item.status === "sent").length;
	const invalid = receipts.filter((item) => item.status === "invalid").length;
	const failed = receipts.filter((item) =>
		["failed", "pending"].includes(item.status),
	).length;
	const unknown = receipts.length - sent - invalid - failed;
	const launched = ready?.launched ?? false;
	return {
		success:
			receipts.length > 0 && failed === 0 && invalid === 0 && unknown === 0,
		total: receipts.length,
		sent,
		invalid,
		failed,
		unknown,
		downloadCompletion: "unverified",
		receipts,
		launched,
		failures,
		message: `${buildSendMessage(receipts.length, sent, invalid, failed, launched)} 접수 미확인 ${unknown}개. 다운로드 완료는 미확인입니다.`,
	};
};
