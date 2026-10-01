let active: { done: Promise<unknown>; cancel?: () => void } | undefined;

export const withOrganizerMutation = async <T>(
	run: () => Promise<T>,
	cancel?: () => void,
): Promise<T> => {
	if (active)
		throw new Error(
			"파일 정리 작업이 실행 중입니다. 완료 후 다시 시도해주세요.",
		);
	// ponytail: one organizer mutation at a time; use per-path locks only if parallel work is needed.
	const operation = { done: Promise.resolve().then(run), cancel };
	active = operation;
	try {
		return await operation.done;
	} finally {
		if (active === operation) active = undefined;
	}
};

export const stopOrganizerMutation = (): Promise<unknown> | undefined => {
	active?.cancel?.();
	return active?.done;
};
