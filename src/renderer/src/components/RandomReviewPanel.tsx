import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	RandomReviewOptions,
	RandomReviewResult,
	ScanArchiveProgress,
} from "../../../shared/file-organizer";
import type { TagPreference } from "../../../shared/tag-preferences";
import { useArchiveMetadataRecovery } from "../hooks/useArchiveMetadataRecovery";
import { useFileActions } from "../hooks/useFileActions";
import { useFileThumbnails } from "../hooks/useFileThumbnails";
import { useKeyboardNavigation } from "../hooks/useKeyboardNavigation";
import { useScrollToRow } from "../hooks/useScrollToRow";
import type { FileInfo } from "../types";
import { getRelativePath, parseFileStructure } from "../utils/file";
import { getSourceTagNamespaceLabel } from "../utils/gallery-metadata";
import { FileTable } from "./FileTable";
import { LoadingState } from "./LoadingState";

type DatePreset = "all" | "6m" | "1y" | "2y" | "3y" | "5y" | "custom";

interface ReviewSummary {
	matchedCount: number;
	scannedCount: number;
	cacheUsed: boolean;
	indexedAt: number;
	indexedCount: number;
	reusedIndexCount: number;
	refreshedIndexCount: number;
	removedIndexCount: number;
}

const DEFAULT_REVIEW_LIMIT = 20;
const MIN_REVIEW_LIMIT = 1;
const MAX_REVIEW_LIMIT = 200;
const BYTES_PER_MB = 1024 * 1024;

const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
	{ value: "all", label: "전체" },
	{ value: "6m", label: "6개월 이전" },
	{ value: "1y", label: "1년 이전" },
	{ value: "2y", label: "2년 이전" },
	{ value: "3y", label: "3년 이전" },
	{ value: "5y", label: "5년 이전" },
	{ value: "custom", label: "직접 날짜" },
];

const PRESET_MONTHS: Partial<Record<DatePreset, number>> = {
	"6m": 6,
	"1y": 12,
	"2y": 24,
	"3y": 36,
	"5y": 60,
};

const clampReviewLimit = (value: string): number => {
	const parsedLimit = Number.parseInt(value, 10);

	if (!Number.isFinite(parsedLimit)) {
		return DEFAULT_REVIEW_LIMIT;
	}

	return Math.min(MAX_REVIEW_LIMIT, Math.max(MIN_REVIEW_LIMIT, parsedLimit));
};

const parseMegabytes = (value: string): number | undefined => {
	const parsedValue = Number.parseFloat(value);

	if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
		return undefined;
	}

	return Math.round(parsedValue * BYTES_PER_MB);
};

const getPresetModifiedBeforeMs = (preset: DatePreset): number | undefined => {
	const months = PRESET_MONTHS[preset];
	if (!months) {
		return undefined;
	}

	const thresholdDate = new Date();
	thresholdDate.setMonth(thresholdDate.getMonth() - months);
	return thresholdDate.getTime();
};

const getCustomModifiedBeforeMs = (dateValue: string): number | undefined => {
	if (!dateValue) {
		return undefined;
	}

	const thresholdDate = new Date(`${dateValue}T00:00:00`);
	if (Number.isNaN(thresholdDate.getTime())) {
		return undefined;
	}

	return thresholdDate.getTime();
};

const formatIndexedAt = (indexedAt: number): string =>
	new Intl.DateTimeFormat("ko-KR", {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(indexedAt));

const buildParsedFiles = (
	result: RandomReviewResult,
	sourcePath: string,
): FileInfo[] =>
	result.files.map((file) => {
		const relativePath = getRelativePath(file.path, sourcePath);
		const parsedData = parseFileStructure(relativePath);

		return {
			...file,
			...parsedData,
		};
	});

export const RandomReviewPanel = (): React.JSX.Element => {
	const [sourcePath, setSourcePath] = useState<string | null>(null);
	const [reviewLimit, setReviewLimit] = useState(String(DEFAULT_REVIEW_LIMIT));
	const [datePreset, setDatePreset] = useState<DatePreset>("1y");
	const [customDate, setCustomDate] = useState("");
	const [includeKeyword, setIncludeKeyword] = useState("");
	const [excludeKeyword, setExcludeKeyword] = useState("");
	const [minSizeMb, setMinSizeMb] = useState("");
	const [maxSizeMb, setMaxSizeMb] = useState("");
	const [recursive, setRecursive] = useState(true);
	const [thumbnailEnabled, setThumbnailEnabled] = useState(true);
	const [preferredTagPreferences, setPreferredTagPreferences] = useState<
		TagPreference[]
	>([]);
	const [selectedPreferredTagKeys, setSelectedPreferredTagKeys] = useState<
		string[]
	>([]);
	const [fileList, setFileList] = useState<FileInfo[]>([]);
	const [selectedRowIndex, setSelectedRowIndex] = useState(-1);
	const [scanComplete, setScanComplete] = useState(false);
	const [isScanning, setIsScanning] = useState(false);
	const [scanProgress, setScanProgress] = useState<ScanArchiveProgress | null>(
		null,
	);
	const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(
		null,
	);
	const tableContainerRef = useRef<HTMLDivElement>(null);
	const thumbnailProgress = useFileThumbnails({
		enabled: thumbnailEnabled,
		fileList,
		scanComplete,
		setFileList,
	});
	const { requestSourceMetadata, isRequestingSourceMetadata } =
		useArchiveMetadataRecovery(fileList, setFileList);
	const { handleCopyFile, handleMoveFile, handleKeepFile } = useFileActions({
		fileList,
		selectedRowIndex,
		setFileList,
		setSelectedRowIndex,
	});

	useKeyboardNavigation({
		enabled: true,
		scanComplete,
		fileList,
		selectedRowIndex,
		setSelectedRowIndex,
		setFileList,
	});

	useScrollToRow({
		selectedRowIndex,
		tableContainerRef,
	});

	useEffect(() => {
		let isCancelled = false;

		window.api.settings
			.get()
			.then((settings) => {
				if (isCancelled) {
					return;
				}

				const configuredStorePath = settings.storePath.trim();
				if (configuredStorePath) {
					setSourcePath((currentPath) => currentPath ?? configuredStorePath);
				}
			})
			.catch((error) => {
				console.error("저장소 경로를 불러오지 못했습니다:", error);
			});

		return () => {
			isCancelled = true;
		};
	}, []);

	useEffect(() => {
		let isCancelled = false;

		window.api.crawlerDb
			.listTagPreferences()
			.then((preferences) => {
				if (isCancelled) return;
				const preferred = preferences.filter(
					(preference) => preference.kind === "preferred",
				);
				setPreferredTagPreferences(preferred);
				setSelectedPreferredTagKeys((current) =>
					current.filter((key) =>
						preferred.some((preference) => preference.key === key),
					),
				);
			})
			.catch((error) => {
				console.error("선호 태그 설정 조회 실패:", error);
			});

		return () => {
			isCancelled = true;
		};
	}, []);

	useEffect(() => {
		const unsubscribe = window.api.fileOrganizer.onRandomReviewProgress(
			(progress) => {
				setScanProgress(progress);
			},
		);

		return unsubscribe;
	}, []);

	useEffect(() => {
		if (fileList.length > 0 && selectedRowIndex === -1) {
			setSelectedRowIndex(0);
		} else if (fileList.length === 0) {
			setSelectedRowIndex(-1);
		}
	}, [fileList, selectedRowIndex]);

	const resetResultState = useCallback(() => {
		setFileList([]);
		setSelectedRowIndex(-1);
		setScanComplete(false);
		setScanProgress(null);
		setReviewSummary(null);
	}, []);
	const selectedPreferredTags = useMemo(
		() =>
			preferredTagPreferences.filter((preference) =>
				selectedPreferredTagKeys.includes(preference.key),
			),
		[preferredTagPreferences, selectedPreferredTagKeys],
	);

	const togglePreferredTag = useCallback(
		(key: string): void => {
			setSelectedPreferredTagKeys((current) =>
				current.includes(key)
					? current.filter((currentKey) => currentKey !== key)
					: [...current, key],
			);
			resetResultState();
		},
		[resetResultState],
	);

	const handleSelectPath = useCallback(async (): Promise<void> => {
		try {
			const selectedDirectory = await window.api.settings.selectDirectory();
			if (!selectedDirectory) {
				return;
			}

			setSourcePath(selectedDirectory);
			resetResultState();
		} catch (error) {
			console.error("재검토 폴더 선택 중 오류 발생:", error);
		}
	}, [resetResultState]);

	const buildReviewOptions = useCallback(
		(forceRefresh = false): RandomReviewOptions | null => {
			if (!sourcePath) {
				alert("먼저 재검토할 폴더를 선택해주세요.");
				return null;
			}

			const limit = clampReviewLimit(reviewLimit);
			const minSizeBytes = parseMegabytes(minSizeMb);
			const maxSizeBytes = parseMegabytes(maxSizeMb);

			if (
				typeof minSizeBytes === "number" &&
				typeof maxSizeBytes === "number" &&
				minSizeBytes > maxSizeBytes
			) {
				alert("최소 크기는 최대 크기보다 작거나 같아야 합니다.");
				return null;
			}

			const modifiedBeforeMs =
				datePreset === "custom"
					? getCustomModifiedBeforeMs(customDate)
					: getPresetModifiedBeforeMs(datePreset);

			if (datePreset === "custom" && typeof modifiedBeforeMs !== "number") {
				alert("직접 날짜를 선택해주세요.");
				return null;
			}

			setReviewLimit(String(limit));

			return {
				sourcePath,
				limit,
				modifiedBeforeMs,
				includeKeyword: includeKeyword.trim() || undefined,
				excludeKeyword: excludeKeyword.trim() || undefined,
				minSizeBytes,
				maxSizeBytes,
				recursive,
				forceRefresh,
				preferredTags:
					selectedPreferredTags.length > 0
						? selectedPreferredTags.map((preference) => ({
								namespace: preference.namespace,
								value: preference.value,
							}))
						: undefined,
			};
		},
		[
			customDate,
			datePreset,
			excludeKeyword,
			includeKeyword,
			maxSizeMb,
			minSizeMb,
			recursive,
			reviewLimit,
			selectedPreferredTags,
			sourcePath,
		],
	);

	const runRandomReview = useCallback(
		async (forceRefresh = false): Promise<void> => {
			const options = buildReviewOptions(forceRefresh);
			if (!options) {
				return;
			}

			setIsScanning(true);
			setScanComplete(false);
			setFileList([]);
			setSelectedRowIndex(-1);
			setReviewSummary(null);
			setScanProgress({
				phase: "searching",
				processed: 0,
				total: 1,
				foundFiles: 0,
				currentPath: options.sourcePath,
			});

			try {
				const result = await window.api.fileOrganizer.randomReview(options);
				const parsedFiles = buildParsedFiles(result, result.sourcePath);

				setFileList(parsedFiles);
				setReviewSummary({
					matchedCount: result.matchedCount,
					scannedCount: result.scannedCount,
					cacheUsed: result.cacheUsed,
					indexedAt: result.indexedAt,
					indexedCount: result.indexedCount,
					reusedIndexCount: result.reusedIndexCount,
					refreshedIndexCount: result.refreshedIndexCount,
					removedIndexCount: result.removedIndexCount,
				});
				setScanComplete(true);
				setScanProgress({
					phase: "complete",
					processed: result.scannedCount,
					total: result.scannedCount,
					foundFiles: result.matchedCount,
				});
			} catch (error) {
				console.error("랜덤 재검토 추출 중 오류 발생:", error);
				alert(
					`랜덤 재검토 추출 중 오류가 발생했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			} finally {
				setIsScanning(false);
			}
		},
		[buildReviewOptions],
	);

	const handleRowClick = useCallback((index: number): void => {
		setSelectedRowIndex(index);
	}, []);

	const showCustomDate = datePreset === "custom";
	const canRunReview = Boolean(sourcePath) && !isScanning;
	const groupedFileCount = fileList.filter((file) => file.isGrouped).length;

	return (
		<div className="flex flex-1 flex-col gap-3 overflow-hidden">
			<div className="card flex-shrink-0 bg-base-100 shadow-sm">
				<div className="card-body gap-3 p-3">
					<div className="flex flex-col gap-3 lg:flex-row lg:items-end">
						<div className="min-w-0 flex-1">
							<div className="mb-1 flex items-center gap-2 text-[11px] text-base-content/55">
								<span className="badge badge-ghost badge-sm">재검토 경로</span>
								<span>{sourcePath ? "선택됨" : "선택 필요"}</span>
							</div>
							<input
								className="input input-sm input-bordered w-full font-mono text-xs"
								type="text"
								value={sourcePath ?? ""}
								placeholder="저장소 경로를 불러오거나 폴더를 선택하세요"
								readOnly
							/>
						</div>
						<div className="flex flex-wrap gap-2 lg:justify-end">
							<button
								type="button"
								className="btn btn-sm btn-outline"
								onClick={handleSelectPath}
								disabled={isScanning}
							>
								폴더 선택
							</button>
							<button
								type="button"
								className="btn btn-sm btn-primary"
								onClick={() => runRandomReview()}
								disabled={!canRunReview}
							>
								{isScanning ? (
									<>
										<span className="loading loading-spinner loading-xs" />
										추출 중
									</>
								) : (
									"랜덤 추출"
								)}
							</button>
							{scanComplete && (
								<button
									type="button"
									className="btn btn-sm btn-outline"
									onClick={() => runRandomReview()}
									disabled={!canRunReview}
								>
									다시 추출
								</button>
							)}
							{scanComplete && (
								<button
									type="button"
									className="btn btn-sm btn-outline"
									onClick={() => runRandomReview(true)}
									disabled={!canRunReview}
								>
									인덱스 새로고침
								</button>
							)}
						</div>
					</div>

					<div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								추출 개수
							</span>
							<input
								className="input input-sm input-bordered"
								type="number"
								min={MIN_REVIEW_LIMIT}
								max={MAX_REVIEW_LIMIT}
								value={reviewLimit}
								disabled={isScanning}
								onChange={(event) => setReviewLimit(event.target.value)}
							/>
						</label>

						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								수정일 기준
							</span>
							<select
								className="select select-sm select-bordered"
								value={datePreset}
								disabled={isScanning}
								onChange={(event) =>
									setDatePreset(event.target.value as DatePreset)
								}
							>
								{DATE_PRESETS.map((preset) => (
									<option key={preset.value} value={preset.value}>
										{preset.label}
									</option>
								))}
							</select>
						</label>

						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								직접 날짜
							</span>
							<input
								className="input input-sm input-bordered"
								type="date"
								value={customDate}
								disabled={isScanning || !showCustomDate}
								onChange={(event) => setCustomDate(event.target.value)}
							/>
						</label>

						<div className="flex flex-wrap items-end gap-2">
							<label className="flex h-8 cursor-pointer items-center gap-2 rounded-btn border border-base-300 bg-base-100 px-3">
								<span className="text-xs font-semibold text-base-content/70">
									하위 폴더
								</span>
								<input
									type="checkbox"
									className="toggle toggle-primary toggle-sm"
									checked={recursive}
									disabled={isScanning}
									aria-label="하위 폴더 포함"
									onChange={(event) => setRecursive(event.target.checked)}
								/>
							</label>
							<label className="flex h-8 cursor-pointer items-center gap-2 rounded-btn border border-base-300 bg-base-100 px-3">
								<span className="text-xs font-semibold text-base-content/70">
									썸네일
								</span>
								<input
									type="checkbox"
									className="toggle toggle-primary toggle-sm"
									checked={thumbnailEnabled}
									disabled={isScanning}
									aria-label="랜덤 재검토 썸네일 사용"
									onChange={(event) =>
										setThumbnailEnabled(event.target.checked)
									}
								/>
							</label>
						</div>
					</div>

					<div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								포함 키워드
							</span>
							<input
								className="input input-sm input-bordered"
								type="text"
								value={includeKeyword}
								placeholder="파일명/경로"
								disabled={isScanning}
								onChange={(event) => setIncludeKeyword(event.target.value)}
							/>
						</label>

						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								제외 키워드
							</span>
							<input
								className="input input-sm input-bordered"
								type="text"
								value={excludeKeyword}
								placeholder="파일명/경로"
								disabled={isScanning}
								onChange={(event) => setExcludeKeyword(event.target.value)}
							/>
						</label>

						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								최소 크기(MB)
							</span>
							<input
								className="input input-sm input-bordered"
								type="number"
								min="0"
								step="1"
								value={minSizeMb}
								placeholder="없음"
								disabled={isScanning}
								onChange={(event) => setMinSizeMb(event.target.value)}
							/>
						</label>

						<label className="form-control">
							<span className="label py-1 text-[11px] text-base-content/60">
								최대 크기(MB)
							</span>
							<input
								className="input input-sm input-bordered"
								type="number"
								min="0"
								step="1"
								value={maxSizeMb}
								placeholder="없음"
								disabled={isScanning}
								onChange={(event) => setMaxSizeMb(event.target.value)}
							/>
						</label>
					</div>

					<fieldset className="rounded-box border border-secondary/20 bg-secondary/5 p-3">
						<legend className="sr-only">선호 태그 필터</legend>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="text-xs font-semibold">선호 태그 필터</div>
							<div className="flex items-center gap-2">
								<span className="badge badge-secondary badge-sm">
									선택 {selectedPreferredTags.length}개
								</span>
								{selectedPreferredTagKeys.length > 0 && (
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										disabled={isScanning}
										onClick={() => {
											setSelectedPreferredTagKeys([]);
											resetResultState();
										}}
									>
										전체 해제
									</button>
								)}
							</div>
						</div>
						{preferredTagPreferences.length === 0 ? (
							<div className="mt-2 text-xs text-base-content/55">
								DB 관리에서 선호 태그를 먼저 등록해주세요.
							</div>
						) : (
							<div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
								{preferredTagPreferences.map((preference) => {
									const isSelected = selectedPreferredTagKeys.includes(
										preference.key,
									);
									return (
										<button
											type="button"
											key={preference.key}
											className={`btn btn-xs ${isSelected ? "btn-secondary" : "btn-ghost"}`}
											disabled={isScanning}
											aria-pressed={isSelected}
											onClick={() => togglePreferredTag(preference.key)}
										>
											<span className="font-mono opacity-60">
												{getSourceTagNamespaceLabel(preference.namespace)}
											</span>
											{preference.value}
										</button>
									);
								})}
							</div>
						)}
						{selectedPreferredTags.length > 0 && (
							<div className="mt-2 text-[11px] text-base-content/55">
								선택한 태그 중 하나라도 포함된 작품만 추출합니다. gallery ID
								또는 원천 메타데이터가 없는 파일은 결과에서 제외됩니다.
							</div>
						)}
					</fieldset>
				</div>
			</div>

			{isScanning && <LoadingState progress={scanProgress} />}

			{!isScanning && !sourcePath && (
				<div className="flex flex-1 items-center justify-center">
					<div className="card w-full max-w-md border border-base-300/70 bg-base-100 shadow-sm">
						<div className="card-body items-center gap-4 px-6 py-8 text-center">
							<div className="text-sm font-semibold">재검토 경로 선택 필요</div>
							<div className="text-xs text-base-content/65">
								설정의 저장소 경로가 비어 있습니다. 폴더를 직접 선택해주세요.
							</div>
							<button
								className="btn btn-primary btn-sm"
								onClick={handleSelectPath}
								type="button"
							>
								폴더 선택
							</button>
						</div>
					</div>
				</div>
			)}

			{!isScanning && sourcePath && !scanComplete && (
				<div className="flex flex-1 items-center justify-center text-center text-sm text-base-content/55">
					조건을 정한 뒤 랜덤 추출을 실행하세요.
				</div>
			)}

			{!isScanning && scanComplete && fileList.length === 0 && (
				<div className="card bg-base-100 shadow-sm">
					<div className="card-body flex-row items-center gap-3 p-4">
						<div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-info/12 text-info">
							<span className="text-sm font-bold">i</span>
						</div>
						<div>
							<h3 className="text-sm font-semibold">결과 없음</h3>
							<div className="text-xs text-base-content/65">
								조건에 맞는 ZIP 파일을 찾지 못했습니다.
							</div>
						</div>
					</div>
				</div>
			)}

			{!isScanning && scanComplete && fileList.length > 0 && (
				<div className="flex flex-1 flex-col gap-3 overflow-hidden">
					<div className="flex flex-wrap items-center gap-2 text-xs text-base-content/60">
						<div className="badge badge-neutral badge-sm">
							추출 {fileList.length}개
						</div>
						{groupedFileCount > 0 && (
							<div className="badge badge-warning badge-sm">
								그룹화 {groupedFileCount}개
							</div>
						)}
						{reviewSummary && (
							<>
								<div
									className={`badge badge-sm ${reviewSummary.cacheUsed ? "badge-success" : "badge-info"}`}
								>
									{reviewSummary.cacheUsed
										? "DB 인덱스 사용"
										: "DB 인덱스 생성"}
								</div>
								<div className="badge badge-ghost badge-sm">
									조건 일치 {reviewSummary.matchedCount}개
								</div>
								<div className="badge badge-ghost badge-sm">
									재사용 {reviewSummary.reusedIndexCount}개
								</div>
								<div className="badge badge-ghost badge-sm">
									신규/갱신 {reviewSummary.refreshedIndexCount}개
								</div>
								{reviewSummary.removedIndexCount > 0 && (
									<div className="badge badge-warning badge-sm">
										정리 {reviewSummary.removedIndexCount}개
									</div>
								)}
								<div className="badge badge-ghost badge-sm">
									인덱스 ZIP {reviewSummary.indexedCount}개
								</div>
								<div className="badge badge-ghost badge-sm">
									갱신 {formatIndexedAt(reviewSummary.indexedAt)}
								</div>
							</>
						)}
						{selectedPreferredTags.length > 0 && (
							<div className="badge badge-secondary badge-sm">
								선호 태그 OR {selectedPreferredTags.length}개
							</div>
						)}
					</div>
					<FileTable
						fileList={fileList}
						selectedRowIndex={selectedRowIndex}
						selectedPath={sourcePath}
						thumbnailEnabled={thumbnailEnabled}
						thumbnailProgress={thumbnailProgress}
						tableContainerRef={tableContainerRef}
						showModifiedDate
						onRowClick={handleRowClick}
						onCopyFile={handleCopyFile}
						onMoveFile={handleMoveFile}
						onKeepFile={handleKeepFile}
						onRequestSourceMetadata={requestSourceMetadata}
						isRequestingSourceMetadata={isRequestingSourceMetadata}
					/>
				</div>
			)}
		</div>
	);
};
