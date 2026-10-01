import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { FileThumbnail } from "../../../shared/file-organizer";
import type { FileInfo } from "../types";
import { createThumbnailBatch } from "../utils/thumbnail-batch";

export interface ThumbnailProgress {
	loaded: number;
	total: number;
	currentFileName?: string;
}

interface UseFileThumbnailsProps<TFile extends FileInfo = FileInfo> {
	enabled: boolean;
	fileList: TFile[];
	scanComplete: boolean;
	setFileList: Dispatch<SetStateAction<TFile[]>>;
}

export const useFileThumbnails = <TFile extends FileInfo = FileInfo>({
	enabled,
	fileList,
	scanComplete,
	setFileList,
}: UseFileThumbnailsProps<TFile>): ThumbnailProgress | null => {
	const [thumbnailProgress, setThumbnailProgress] =
		useState<ThumbnailProgress | null>(null);
	const fileListRef = useRef<TFile[]>([]);
	const thumbnailRequestIdRef = useRef(0);

	const fileListIdentity = useMemo(
		() =>
			JSON.stringify(
				fileList.map((file) => [file.path, file.size, file.modifiedTimeMs]),
			),
		[fileList],
	);
	const fileListIdentityRef = useRef(fileListIdentity);
	fileListIdentityRef.current = fileListIdentity;

	useEffect(() => {
		fileListRef.current = fileList;
	}, [fileList]);

	useEffect(() => {
		const currentFileList = fileListRef.current;
		const fileCount = currentFileList.length;

		if (!enabled || !scanComplete || fileCount === 0) {
			thumbnailRequestIdRef.current += 1;
			setThumbnailProgress(null);
			return;
		}

		const requestId = thumbnailRequestIdRef.current + 1;
		thumbnailRequestIdRef.current = requestId;
		const isCurrent = () =>
			thumbnailRequestIdRef.current === requestId &&
			fileListIdentityRef.current === fileListIdentity;
		const targets = currentFileList.filter(
			(file) => !file.thumbnail && file.thumbnailLoadState !== "failed",
		);
		const loadingPaths = new Set(targets.map((file) => file.path));
		let loadedCount = fileCount - targets.length;
		let nextIndex = 0;

		setThumbnailProgress({
			loaded: loadedCount,
			total: fileCount,
		});

		if (targets.length === 0) {
			return;
		}

		setFileList((prevList) =>
			prevList.map((file) =>
				loadingPaths.has(file.path)
					? {
							...file,
							thumbnailLoadState: "loading",
						}
					: file,
			),
		);

		let currentFileName: string | undefined;
		const originals = new Map(targets.map((file) => [file.path, file]));
		const batch = createThumbnailBatch((results) => {
			if (!isCurrent()) return;
			setFileList((currentFiles) => {
				if (!isCurrent()) return currentFiles;
				return currentFiles.map((file) => {
					const original = originals.get(file.path);
					if (
						!results.has(file.path) ||
						!original ||
						original.size !== file.size ||
						original.modifiedTimeMs !== file.modifiedTimeMs
					)
						return file;
					const thumbnail = results.get(file.path);
					return thumbnail
						? { ...file, thumbnail, thumbnailLoadState: undefined }
						: { ...file, thumbnailLoadState: "failed" };
				});
			});
			setThumbnailProgress({
				loaded: loadedCount,
				total: fileCount,
				currentFileName: loadedCount < fileCount ? currentFileName : undefined,
			});
		});
		const loadThumbnail = async (file: TFile): Promise<void> => {
			let thumbnail: FileThumbnail | null = null;
			try {
				thumbnail = await window.api.fileOrganizer.getThumbnail(file.path);
			} catch (error) {
				console.warn("썸네일 로딩 실패:", file.path, error);
			}
			if (!isCurrent()) return;
			loadedCount++;
			currentFileName = file.name;
			batch.add(file.path, thumbnail);
		};

		const workerCount = Math.min(8, targets.length);
		const workers = Array.from({ length: workerCount }, async () => {
			while (isCurrent() && nextIndex < targets.length) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				const file = targets[currentIndex];

				if (file) {
					await loadThumbnail(file);
				}
			}
		});

		void Promise.all(workers).then(() => {
			if (isCurrent()) {
				batch.flush();
				setThumbnailProgress({ loaded: fileCount, total: fileCount });
			}
		});
		return () => {
			thumbnailRequestIdRef.current++;
			batch.cancel();
		};
	}, [enabled, fileListIdentity, scanComplete, setFileList]);

	return thumbnailProgress;
};
