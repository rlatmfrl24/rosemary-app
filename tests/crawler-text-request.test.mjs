import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test, { after } from "node:test";
import { executeRetryableRequest } from "../src/main/crawler-request-policy.ts";
import { loadMainModules } from "./helpers/main-modules.mjs";

const close = loadMainModules("unused");
const { fetchCrawlerText, RetryableFetchError } = await import(
	"../src/main/crawler-text-request.ts"
);
after(close);
const requests = [];
let respond = () => {};
globalThis.rosemaryTestNet = (options) => {
	const request = new EventEmitter();
	const response = new EventEmitter();
	response.statusCode = 200;
	Object.assign(request, {
		options,
		response,
		headers: {},
		aborted: false,
		setHeader(name, value) {
			this.headers[name] = value;
		},
		write(body) {
			this.body = body;
		},
		abort() {
			this.aborted = true;
		},
		end() {
			queueMicrotask(() => respond(request, response));
		},
	});
	requests.push(request);
	return request;
};
const clean = (request, signal) => {
	for (const emitter of [request, request.response])
		assert.deepEqual(emitter.eventNames(), []);
	if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
};
const fetch = (extra = {}) =>
	fetchCrawlerText(new URL("https://example.com"), {
		method: "GET",
		headers: { Accept: "text/html" },
		timeoutMs: 15,
		...extra,
	});

test("HTML·JSON 정상 완료는 응답과 타이머·구독을 정리한다", async () => {
	respond = (request, response) => {
		request.emit("response", response);
		response.emit("data", Buffer.from("ok"));
		response.emit("end");
	};
	const controller = new AbortController();
	assert.deepEqual(
		await fetch({
			method: "POST",
			body: '{"test":1}',
			signal: controller.signal,
		}),
		{ statusCode: 200, body: "ok" },
	);
	const request = requests.at(-1);
	assert.equal(request.body, '{"test":1}');
	clean(request, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(request.aborted, false);
});
test("응답 없이 시간 초과하면 최대 두 번 재시도한다", async () => {
	let attempts = 0;
	respond = () => {};
	await assert.rejects(
		executeRetryableRequest({
			maxRetryCount: 2,
			request: () => {
				attempts++;
				return fetch();
			},
			shouldRetry: (error) => error instanceof RetryableFetchError,
			waitBeforeRetry: async () => {},
		}),
		RetryableFetchError,
	);
	assert.equal(attempts, 3);
	for (const request of requests.slice(-3)) {
		assert.equal(request.aborted, true);
		clean(request);
	}
});
test("크기 초과는 재시도하지 않고 중단은 즉시 요청을 종료한다", async () => {
	respond = (request, response) => {
		request.emit("response", response);
		response.emit("data", Buffer.alloc(5));
	};
	let attempts = 0;
	await assert.rejects(
		executeRetryableRequest({
			maxRetryCount: 2,
			request: () => {
				attempts++;
				return fetch({ maxBytes: 4 });
			},
			shouldRetry: (error) => error instanceof RetryableFetchError,
			waitBeforeRetry: async () => {},
		}),
		/제한/,
	);
	assert.equal(attempts, 1);
	clean(requests.at(-1));
	respond = () => {};
	const controller = new AbortController();
	const pending = fetch({ signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, { name: "AbortError" });
	assert.equal(requests.at(-1).aborted, true);
	clean(requests.at(-1), controller.signal);
});
test("수신 중에도 전체 제한을 지키고 네트워크 오류를 정리한다", async () => {
	respond = (request, response) => {
		request.emit("response", response);
		response.emit("data", Buffer.from("first"));
	};
	await assert.rejects(fetch(), RetryableFetchError);
	clean(requests.at(-1));
	respond = (request) => request.emit("error", new Error("network failed"));
	await assert.rejects(fetch(), RetryableFetchError);
	clean(requests.at(-1));
});
