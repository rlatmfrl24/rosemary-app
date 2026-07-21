import assert from "node:assert/strict";
import test from "node:test";
import {
	executeRetryableRequest,
	isRetryableHttpStatusCode,
} from "../src/main/crawler-request-policy.ts";

test("429와 5xx만 재시도 가능한 HTTP 상태로 분류한다", () => {
	assert.equal(isRetryableHttpStatusCode(429), true);
	assert.equal(isRetryableHttpStatusCode(500), true);
	assert.equal(isRetryableHttpStatusCode(503), true);
	assert.equal(isRetryableHttpStatusCode(400), false);
	assert.equal(isRetryableHttpStatusCode(404), false);
});

test("일시 오류는 최대 2회 재시도한 뒤 성공 결과를 반환한다", async () => {
	let attempts = 0;
	let waits = 0;
	const retryAttempts = [];
	const result = await executeRetryableRequest({
		maxRetryCount: 2,
		request: async () => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error("retryable");
			}
			return "success";
		},
		shouldRetry: () => true,
		onRetry: async (attempt) => {
			retryAttempts.push(attempt);
		},
		waitBeforeRetry: async () => {
			waits += 1;
		},
	});

	assert.equal(result, "success");
	assert.equal(attempts, 3);
	assert.equal(waits, 2);
	assert.deepEqual(retryAttempts, [1, 2]);
});

test("취소된 요청은 실행하거나 재시도하지 않는다", async () => {
	const abortController = new AbortController();
	abortController.abort(new DOMException("manual-stop", "AbortError"));
	let attempts = 0;

	await assert.rejects(
		executeRetryableRequest({
			maxRetryCount: 2,
			signal: abortController.signal,
			request: async () => {
				attempts += 1;
				return "unexpected";
			},
			shouldRetry: () => true,
			waitBeforeRetry: async () => undefined,
		}),
		(error) => error instanceof DOMException && error.name === "AbortError",
	);
	assert.equal(attempts, 0);
});

test("재시도 대기 중 취소되면 현재 오류를 실패로 확정하지 않고 중단한다", async () => {
	const abortController = new AbortController();
	let attempts = 0;

	await assert.rejects(
		executeRetryableRequest({
			maxRetryCount: 2,
			signal: abortController.signal,
			request: async () => {
				attempts += 1;
				throw new Error("temporary");
			},
			shouldRetry: () => true,
			waitBeforeRetry: async () => {
				abortController.abort(
					new DOMException("metadata-backfill-pause", "AbortError"),
				);
			},
		}),
		(error) => error instanceof DOMException && error.name === "AbortError",
	);
	assert.equal(attempts, 1);
});

test("최대 재시도 후에도 실패하면 마지막 오류를 반환한다", async () => {
	let attempts = 0;
	let waits = 0;
	await assert.rejects(
		executeRetryableRequest({
			maxRetryCount: 2,
			request: async () => {
				attempts += 1;
				throw new Error(`failure-${attempts}`);
			},
			shouldRetry: () => true,
			waitBeforeRetry: async () => {
				waits += 1;
			},
		}),
		/failure-3/,
	);
	assert.equal(attempts, 3);
	assert.equal(waits, 2);
});
