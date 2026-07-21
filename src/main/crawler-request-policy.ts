export interface RetryableRequestOptions<T> {
	maxRetryCount: number;
	signal?: AbortSignal;
	request: (attempt: number) => Promise<T>;
	shouldRetry: (error: unknown) => boolean;
	onRetry?: (attempt: number, error: unknown) => void | Promise<void>;
	waitBeforeRetry: (attempt: number, error: unknown) => Promise<void>;
}

const throwIfAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException("aborted", "AbortError");
	}
};

export const isRetryableHttpStatusCode = (statusCode: number): boolean =>
	statusCode === 429 || statusCode >= 500;

export const executeRetryableRequest = async <T>(
	options: RetryableRequestOptions<T>,
): Promise<T> => {
	for (let attempt = 0; attempt <= options.maxRetryCount; attempt += 1) {
		throwIfAborted(options.signal);
		try {
			return await options.request(attempt);
		} catch (error) {
			throwIfAborted(options.signal);
			if (!options.shouldRetry(error) || attempt === options.maxRetryCount) {
				throw error;
			}

			await options.onRetry?.(attempt + 1, error);
			await options.waitBeforeRetry(attempt, error);
			throwIfAborted(options.signal);
		}
	}

	throw new Error("재시도 요청이 결과 없이 종료되었습니다.");
};
