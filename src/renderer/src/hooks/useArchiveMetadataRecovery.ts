import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseArchiveFileName } from "../../../shared/archive-name";
import type { ArchiveGalleryRecoveryEntry } from "../../../shared/crawler";
import type { FileInfo } from "../types";

interface ArchiveMetadataRecoveryHook<TFile extends FileInfo> {
	requestSourceMetadata: (file: TFile) => Promise<void>;
	isRequestingSourceMetadata: (file: TFile) => boolean;
}

const getFileGalleryId = (file: FileInfo): string | undefined =>
	file.code ?? parseArchiveFileName(file.name).code;

export const useArchiveMetadataRecovery = <TFile extends FileInfo>(
	fileList: TFile[],
	setFileList: Dispatch<SetStateAction<TFile[]>>,
): ArchiveMetadataRecoveryHook<TFile> => {
	const [requestingPaths, setRequestingPaths] = useState<Set<string>>(
		() => new Set(),
	);
	const pendingGalleryIds = useMemo(
		() =>
			[
				...new Set(
					fileList
						.filter((file) => file.archiveRecovery?.status === "pending")
						.map(getFileGalleryId)
						.filter((galleryId): galleryId is string => Boolean(galleryId)),
				),
			].sort(),
		[fileList],
	);
	const pendingGalleryIdsKey = pendingGalleryIds.join(",");

	const applyRecoveryEntries = useCallback(
		(entries: Record<string, ArchiveGalleryRecoveryEntry>): void => {
			setFileList((currentFiles) =>
				currentFiles.map((file) => {
					const galleryId = getFileGalleryId(file);
					const entry = galleryId ? entries[galleryId] : undefined;
					if (!entry) return file;
					return {
						...file,
						archiveRecovery: entry,
						sourceMetadata: entry.metadata ?? file.sourceMetadata,
					};
				}),
			);
		},
		[setFileList],
	);

	const refreshRecoveryEntries = useCallback(
		async (galleryIds: string[]): Promise<void> => {
			if (galleryIds.length === 0) return;
			const entries =
				await window.api.crawlerDb.getArchiveMetadataRecoveryEntries(
					galleryIds,
				);
			applyRecoveryEntries(entries);
		},
		[applyRecoveryEntries],
	);

	useEffect(() => {
		if (!pendingGalleryIdsKey) return;
		let cancelled = false;
		let requestRunning = false;
		const galleryIds = pendingGalleryIdsKey.split(",");
		const poll = async (): Promise<void> => {
			if (requestRunning) return;
			requestRunning = true;
			try {
				const entries =
					await window.api.crawlerDb.getArchiveMetadataRecoveryEntries(
						galleryIds,
					);
				if (!cancelled) applyRecoveryEntries(entries);
			} catch (error) {
				console.error("원천 메타데이터 복구 상태 조회 실패:", error);
			} finally {
				requestRunning = false;
			}
		};
		void poll();
		const intervalId = window.setInterval(() => void poll(), 1000);
		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [applyRecoveryEntries, pendingGalleryIdsKey]);

	const requestSourceMetadata = useCallback(
		async (file: TFile): Promise<void> => {
			const galleryId = getFileGalleryId(file);
			if (!galleryId) {
				alert("파일명에서 gallery id를 찾지 못했습니다.");
				return;
			}
			setRequestingPaths((current) => new Set(current).add(file.path));
			try {
				await window.api.crawlerDb.enqueueArchiveMetadataRecoveryFiles([
					file.path,
				]);
				await refreshRecoveryEntries([galleryId]);
			} catch (error) {
				console.error("원천 메타데이터 조회 요청 실패:", error);
				alert(
					error instanceof Error
						? error.message
						: "원천 메타데이터 조회를 시작하지 못했습니다.",
				);
			} finally {
				setRequestingPaths((current) => {
					const next = new Set(current);
					next.delete(file.path);
					return next;
				});
			}
		},
		[refreshRecoveryEntries],
	);

	return {
		requestSourceMetadata,
		isRequestingSourceMetadata: (file) => requestingPaths.has(file.path),
	};
};
