import { net } from "electron";

export class RetryableFetchError extends Error {
	public readonly statusCode?: number;
	constructor(
		message: string,
		options?: { statusCode?: number; cause?: unknown },
	) {
		super(message, { cause: options?.cause });
		this.name = "RetryableFetchError";
		this.statusCode = options?.statusCode;
	}
}

export const fetchCrawlerText = (
	url: URL,
	options: {
		method: "GET" | "POST";
		headers: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
	},
): Promise<{ statusCode: number; body: string }> =>
	new Promise((resolve, reject) => {
		const request = net.request({
			method: options.method,
			url: url.toString(),
		});
		let response: Electron.IncomingMessage | undefined;
		let settled = false;
		let size = 0;
		const chunks: Buffer[] = [];
		const timer = setTimeout(
			() =>
				fail(
					new RetryableFetchError(
						"크롤링 요청이 30초 안에 완료되지 않았습니다.",
					),
					true,
				),
			options.timeoutMs ?? 30_000,
		);
		const cleanup = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			request.removeListener("response", receive);
			if (!response) request.removeListener("error", networkError);
			response?.removeListener("data", data);
			response?.removeListener("end", end);
			response?.removeListener("aborted", responseAborted);
			chunks.length = 0;
		};
		const fail = (error: unknown, cancel = false) => {
			if (settled) return;
			settled = true;
			if (cancel) request.abort();
			cleanup();
			reject(error);
		};
		const abort = () =>
			fail(
				options.signal?.reason ?? new DOMException("manual-stop", "AbortError"),
				true,
			);
		const networkError = (error: Error) =>
			fail(
				new RetryableFetchError("크롤링 요청 연결에 실패했습니다.", {
					cause: error,
				}),
			);
		const closeResponse = () => {
			if (!settled)
				networkError(new Error("응답 완료 전에 연결이 닫혔습니다."));
			request.removeListener("error", networkError);
			response?.removeListener("error", networkError);
		};
		const responseAborted = () =>
			networkError(new Error("응답 수신이 중단되었습니다."));
		const data = (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > (options.maxBytes ?? 16 * 1024 * 1024)) {
				fail(new Error("크롤링 응답이 16MiB 제한을 초과했습니다."), true);
				return;
			}
			chunks.push(Buffer.from(chunk));
		};
		const end = () => {
			if (settled || !response) return;
			settled = true;
			const result = {
				statusCode: response.statusCode,
				body: Buffer.concat(chunks).toString("utf8"),
			};
			cleanup();
			resolve(result);
		};
		const receive = (incoming: Electron.IncomingMessage) => {
			response = incoming;
			response.on("data", data);
			response.on("end", end);
			response.on("error", networkError);
			response.on("aborted", responseAborted);
			// A request error can be followed by a response error in the same transaction.
			(response as NodeJS.EventEmitter).once("close", closeResponse);
		};
		request.on("response", receive);
		request.on("error", networkError);
		if (options.signal?.aborted) {
			abort();
			return;
		}
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			for (const [name, value] of Object.entries(options.headers))
				request.setHeader(name, value);
			if (options.body !== undefined) request.write(options.body);
			request.end();
		} catch (error) {
			fail(error, true);
		}
	});
