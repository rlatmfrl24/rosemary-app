import type { FileThumbnail } from "../../../shared/file-organizer";

export const createThumbnailBatch = (
	apply: (results: Map<string, FileThumbnail | null>) => void,
) => {
	let pending = new Map<string, FileThumbnail | null>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let cancelled = false;
	const flush = (): void => {
		clearTimeout(timer);
		timer = undefined;
		if (cancelled || pending.size === 0) return;
		const results = pending;
		pending = new Map();
		apply(results);
	};
	return {
		add: (filePath: string, thumbnail: FileThumbnail | null): void => {
			if (cancelled) return;
			pending.set(filePath, thumbnail);
			timer ??= setTimeout(flush, 100);
		},
		flush,
		cancel: (): void => {
			cancelled = true;
			clearTimeout(timer);
			pending.clear();
		},
	};
};
