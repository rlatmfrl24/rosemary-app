import {
	type Dispatch,
	type SetStateAction,
	useEffect,
	useRef,
	useState,
} from "react";
import type { FileThumbnail } from "../../../shared/file-organizer";
import type { FileInfo } from "../types";

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

	useEffect(() => {
		fileListRef.current = fileList;
	}, [fileList]);

	useEffect(() => {
		const currentFileList = fileListRef.current;
		const fileCount = fileList.length;

		if (!enabled || !scanComplete || fileCount === 0) {
			thumbnailRequestIdRef.current += 1;
			setThumbnailProgress(null);
			return;
		}

		const requestId = thumbnailRequestIdRef.current + 1;
		thumbnailRequestIdRef.current = requestId;
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

		const loadThumbnail = async (file: TFile): Promise<void> => {
			setThumbnailProgress({
				loaded: loadedCount,
				total: fileCount,
				currentFileName: file.name,
			});

			let thumbnail: FileThumbnail | null = null;

			try {
				thumbnail = (await window.electron.ipcRenderer.invoke(
					"get-file-thumbnail",
					file.path,
				)) as FileThumbnail | null;
			} catch (error) {
				console.warn("썸네일 로딩 실패:", file.path, error);
			}

			if (thumbnailRequestIdRef.current !== requestId) {
				return;
			}

			loadedCount += 1;
			setFileList((prevList) =>
				prevList.map((currentFile) => {
					if (currentFile.path !== file.path) {
						return currentFile;
					}

					return thumbnail
						? {
								...currentFile,
								thumbnail,
								thumbnailLoadState: undefined,
							}
						: {
								...currentFile,
								thumbnailLoadState: "failed",
							};
				}),
			);
			setThumbnailProgress({
				loaded: loadedCount,
				total: fileCount,
				currentFileName: loadedCount < fileCount ? file.name : undefined,
			});
		};

		const workerCount = Math.min(8, targets.length);
		const workers = Array.from({ length: workerCount }, async () => {
			while (
				thumbnailRequestIdRef.current === requestId &&
				nextIndex < targets.length
			) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				const file = targets[currentIndex];

				if (file) {
					await loadThumbnail(file);
				}
			}
		});

		void Promise.all(workers).then(() => {
			if (thumbnailRequestIdRef.current === requestId) {
				setThumbnailProgress((progress) =>
					progress
						? {
								loaded: progress.total,
								total: progress.total,
							}
						: progress,
				);
			}
		});

		return () => {
			thumbnailRequestIdRef.current += 1;
		};
	}, [enabled, fileList.length, scanComplete, setFileList]);

	return thumbnailProgress;
};
