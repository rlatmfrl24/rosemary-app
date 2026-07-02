import type React from "react";
import type { RefObject } from "react";
import { useEffect, useMemo, useState } from "react";
import type {
	DuplicateAction,
	FileInfo,
	FileReviewFilter,
	ReviewFileInfo,
} from "../types";
import {
	formatFileSize,
	getRelativePath,
	parseFileStructure,
} from "../utils/file";
import { CopyIcon, FavoriteIcon, FolderIcon, MoveIcon } from "./Icons";

interface ThumbnailProgress {
	loaded: number;
	total: number;
	currentFileName?: string;
}

type TableFileInfo = FileInfo &
	Partial<
		Pick<
			ReviewFileInfo,
			| "reviewStatus"
			| "reviewChecks"
			| "duplicate"
			| "duplicateAction"
			| "groupCandidate"
			| "favoriteArtistCandidate"
			| "useGroupTarget"
			| "reviewError"
		>
	>;

interface FileTableProps<TFile extends TableFileInfo = ReviewFileInfo> {
	fileList: TFile[];
	visibleFileIndexes?: number[];
	activeFilter?: FileReviewFilter;
	selectedRowIndex: number;
	selectedPath: string | null;
	thumbnailEnabled: boolean;
	thumbnailProgress: ThumbnailProgress | null;
	tableContainerRef: RefObject<HTMLDivElement>;
	reviewPhase?: "idle" | "checking" | "complete" | "failed";
	showModifiedDate?: boolean;
	onRowClick: (index: number) => void;
	onFilterChange?: (filter: FileReviewFilter) => void;
	onDuplicateActionChange?: (filePath: string, action: DuplicateAction) => void;
	onGroupTargetChange?: (filePath: string, useGroupTarget: boolean) => void;
	onCopyFile?: (file: TFile) => void;
	onMoveFile?: (file: TFile) => void;
	onKeepFile?: (file: TFile) => void;
	onMoveToFavoriteArtist?: (file: TFile) => void;
}

interface ContextMenuState<TFile extends TableFileInfo = ReviewFileInfo> {
	isOpen: boolean;
	x: number;
	y: number;
	file: TFile | null;
}

interface StatusInfo {
	label: string;
	className: string;
	description: string;
}

const FILTER_OPTIONS: Array<{
	value: FileReviewFilter;
	label: string;
}> = [
	{ value: "all", label: "전체" },
	{ value: "ready", label: "일반 보관" },
	{ value: "duplicate", label: "중복" },
	{ value: "group-merge", label: "그룹 후보" },
	{ value: "review-needed", label: "확인 필요" },
];

const getTypeColor = (type: string | undefined): string => {
	if (!type) return "badge-outline";

	switch (type) {
		case "Doujinshi":
			return "badge-error";
		case "Manga":
			return "badge-info";
		case "Artist CG":
			return "badge-outline";
		case "Image Set":
			return "badge-warning";
		case "Western":
			return "badge-accent";
		case "Non-H":
			return "badge-secondary";
		default:
			return "badge-outline";
	}
};

const getValueOrFallback = (value: string | undefined): string => value || "-";

const formatModifiedDate = (modifiedTimeMs: number | undefined): string => {
	if (typeof modifiedTimeMs !== "number") {
		return "-";
	}

	return new Intl.DateTimeFormat("ko-KR", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(modifiedTimeMs));
};

const getReviewStatusInfo = (file: TableFileInfo): StatusInfo => {
	if (file.reviewError) {
		return {
			label: "확인 필요",
			className: "badge-error",
			description: file.reviewError,
		};
	}

	if (file.reviewStatus === "checking") {
		return {
			label: "검토 중",
			className: "badge-info",
			description: "중복과 기존 그룹 후보를 확인하는 중입니다.",
		};
	}

	if (file.duplicate) {
		if (file.duplicateAction === "overwrite") {
			return {
				label: "중복 덮어쓰기",
				className: "badge-warning",
				description: "기존 저장소 파일을 새 파일로 교체합니다.",
			};
		}

		if (file.duplicateAction === "skip") {
			return {
				label: "중복 건너뜀",
				className: "badge-neutral",
				description: "이 파일은 전체 보관 시 이동하지 않습니다.",
			};
		}

		if (file.duplicateAction === "keep") {
			return {
				label: "보류",
				className: "badge-ghost",
				description: "전체 보관에서 제외하고 목록에 남깁니다.",
			};
		}

		return {
			label: "중복",
			className: "badge-error",
			description: "덮어쓰기 또는 건너뛰기 선택이 필요합니다.",
		};
	}

	if (file.groupCandidate && file.useGroupTarget !== false) {
		return {
			label: "그룹 편입",
			className: "badge-warning",
			description: `${file.groupCandidate.groupName} 그룹으로 편입합니다.`,
		};
	}

	return {
		label: "일반 보관",
		className: "badge-success",
		description: "충돌 없이 일반 저장소 경로로 이동합니다.",
	};
};

const getTargetPathPreview = (
	file: TableFileInfo,
	selectedPath: string | null,
): string => {
	if (file.duplicateAction === "skip") {
		return "이 파일은 전체 보관 시 이동하지 않음";
	}

	if (file.duplicateAction === "keep") {
		return "전체 보관에서 제외하고 목록에 유지";
	}

	if (file.duplicate && !file.duplicateAction) {
		return "중복 처리 선택 필요";
	}

	if (file.duplicate && file.duplicateAction === "overwrite") {
		return file.duplicate.targetPath;
	}

	if (file.groupCandidate && file.useGroupTarget !== false) {
		return `${file.groupCandidate.groupPath}\\${file.name}`;
	}

	return getRelativePath(file.path, selectedPath || "") || file.name;
};

const getFilterCounts = (
	fileList: TableFileInfo[],
): Record<FileReviewFilter, number> => ({
	all: fileList.length,
	ready: fileList.filter(
		(file) => !file.reviewStatus || file.reviewStatus === "ready",
	).length,
	duplicate: fileList.filter((file) => Boolean(file.duplicate)).length,
	"group-merge": fileList.filter((file) => Boolean(file.groupCandidate)).length,
	"review-needed": fileList.filter(
		(file) =>
			file.reviewStatus === "review-needed" ||
			file.reviewStatus === "checking" ||
			Boolean(file.duplicate && !file.duplicateAction) ||
			file.duplicateAction === "skip" ||
			file.duplicateAction === "keep",
	).length,
});

const renderDetailValue = (
	label: string,
	value: string | number | undefined,
): React.JSX.Element => (
	<div className="min-w-0 rounded bg-base-200/70 px-3 py-2">
		<div className="text-[11px] text-base-content/50">{label}</div>
		<div className="truncate text-sm font-medium" title={String(value || "-")}>
			{value || "-"}
		</div>
	</div>
);

export const FileTable = <TFile extends TableFileInfo = ReviewFileInfo>({
	fileList,
	visibleFileIndexes,
	activeFilter = "all",
	selectedRowIndex,
	selectedPath,
	thumbnailEnabled,
	thumbnailProgress,
	tableContainerRef,
	reviewPhase = "idle",
	showModifiedDate = false,
	onRowClick,
	onFilterChange,
	onDuplicateActionChange,
	onGroupTargetChange,
	onCopyFile,
	onMoveFile,
	onKeepFile,
	onMoveToFavoriteArtist,
}: FileTableProps<TFile>): React.JSX.Element => {
	const [contextMenu, setContextMenu] = useState<ContextMenuState<TFile>>({
		isOpen: false,
		x: 0,
		y: 0,
		file: null,
	});
	const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
	const displayFileIndexes = useMemo(
		() => visibleFileIndexes ?? fileList.map((_, index) => index),
		[fileList, visibleFileIndexes],
	);
	const filterCounts = useMemo(() => getFilterCounts(fileList), [fileList]);
	const selectedFile =
		selectedRowIndex >= 0 ? fileList[selectedRowIndex] : undefined;

	useEffect(() => {
		const handleClickOutside = () => {
			if (contextMenu.isOpen) {
				setContextMenu({ isOpen: false, x: 0, y: 0, file: null });
			}
		};

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape" && contextMenu.isOpen) {
				setContextMenu({ isOpen: false, x: 0, y: 0, file: null });
			}
		};

		document.addEventListener("click", handleClickOutside);
		document.addEventListener("keydown", handleEscape);

		return () => {
			document.removeEventListener("click", handleClickOutside);
			document.removeEventListener("keydown", handleEscape);
		};
	}, [contextMenu.isOpen]);

	useEffect(() => {
		if (!selectedFile) {
			setIsDetailModalOpen(false);
		}
	}, [selectedFile]);

	useEffect(() => {
		if (!isDetailModalOpen) {
			return;
		}

		const handleEscape = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				setIsDetailModalOpen(false);
			}
		};

		document.addEventListener("keydown", handleEscape);

		return () => {
			document.removeEventListener("keydown", handleEscape);
		};
	}, [isDetailModalOpen]);

	const handleContextMenu = (e: React.MouseEvent, file: TFile) => {
		e.preventDefault();
		e.stopPropagation();

		setContextMenu({
			isOpen: true,
			x: e.clientX,
			y: e.clientY,
			file,
		});
	};

	const handleMenuItemClick = (
		action: "copy" | "move" | "keep" | "favoriteArtist",
	) => {
		if (!contextMenu.file) return;

		if (action === "copy") {
			if (onCopyFile) {
				onCopyFile(contextMenu.file);
			} else {
				console.log("Copy file:", contextMenu.file.name);
			}
		} else if (action === "move") {
			if (onMoveFile) {
				onMoveFile(contextMenu.file);
			} else {
				console.log("Move file:", contextMenu.file.name);
			}
		} else if (action === "keep") {
			if (onKeepFile) {
				onKeepFile(contextMenu.file);
			} else {
				console.log("Keep file:", contextMenu.file.name);
			}
		} else if (action === "favoriteArtist") {
			if (onMoveToFavoriteArtist) {
				onMoveToFavoriteArtist(contextMenu.file);
			} else {
				console.log("Move file to Favorite Artist:", contextMenu.file.name);
			}
		}

		setContextMenu({ isOpen: false, x: 0, y: 0, file: null });
	};

	const handleSelectableKeyDown = (
		event: React.KeyboardEvent,
		index: number,
	): void => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		onRowClick(index);
	};

	const renderListHeader = (): React.JSX.Element => (
		<div className="mb-3 flex flex-shrink-0 flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-semibold">파일 목록</span>
					<div className="badge badge-neutral badge-sm">
						{displayFileIndexes.length}/{fileList.length}개
					</div>
					{reviewPhase === "checking" && (
						<div className="badge badge-info badge-sm gap-1">
							<span className="loading loading-spinner loading-xs" />
							검토 중
						</div>
					)}
					{thumbnailEnabled && thumbnailProgress && (
						<div className="badge badge-outline badge-sm gap-1">
							{thumbnailProgress.loaded < thumbnailProgress.total && (
								<span className="loading loading-spinner loading-xs" />
							)}
							썸네일 {thumbnailProgress.loaded}/{thumbnailProgress.total}
						</div>
					)}
					{onFilterChange && selectedFile && (
						<button
							type="button"
							className="btn btn-outline btn-xs [@media(min-width:1440px)]:hidden"
							aria-label="선택 파일 상세 열기"
							onClick={() => setIsDetailModalOpen(true)}
						>
							상세
						</button>
					)}
				</div>
				{thumbnailProgress?.currentFileName && (
					<div className="hidden max-w-[32rem] truncate text-[11px] text-base-content/50 lg:block">
						{thumbnailProgress.currentFileName}
					</div>
				)}
			</div>

			{onFilterChange && (
				<fieldset className="flex flex-wrap gap-2">
					<legend className="sr-only">파일 검토 상태 필터</legend>
					{FILTER_OPTIONS.map((option) => (
						<button
							type="button"
							key={option.value}
							className={`btn btn-xs ${
								activeFilter === option.value ? "btn-primary" : "btn-ghost"
							}`}
							aria-pressed={activeFilter === option.value}
							aria-label={`${option.label} 파일 필터`}
							onClick={() => onFilterChange(option.value)}
						>
							{option.label}
							<span className="badge badge-sm">
								{filterCounts[option.value]}
							</span>
						</button>
					))}
				</fieldset>
			)}
		</div>
	);

	const renderStatusBadge = (file: TFile): React.JSX.Element => {
		const statusInfo = getReviewStatusInfo(file);

		return (
			<span
				className={`badge ${statusInfo.className} badge-sm max-w-full truncate`}
				title={statusInfo.description}
			>
				{statusInfo.label}
			</span>
		);
	};

	const renderCardThumbnail = (file: TFile): React.JSX.Element => {
		if (!file.thumbnail) {
			if (file.thumbnailLoadState === "loading") {
				return (
					<div className="flex h-72 w-full items-center justify-center rounded bg-base-200 text-primary sm:h-60 sm:w-44 lg:h-72 lg:w-52">
						<span className="loading loading-spinner loading-md" />
					</div>
				);
			}

			return (
				<div className="flex h-72 w-full items-center justify-center rounded bg-base-200 text-sm font-semibold text-base-content/45 sm:h-60 sm:w-44 lg:h-72 lg:w-52">
					없음
				</div>
			);
		}

		const isIcon = file.thumbnail.source === "file-icon";

		return (
			<div className="h-72 w-full overflow-hidden rounded border border-base-content/10 bg-base-200 shadow-sm sm:h-60 sm:w-44 lg:h-72 lg:w-52">
				<img
					src={file.thumbnail.dataUrl}
					alt={`${file.name} 썸네일`}
					className={`h-full w-full ${isIcon ? "object-contain p-6" : "object-cover"}`}
					loading="lazy"
					draggable={false}
				/>
			</div>
		);
	};

	const renderEmptyFilteredState = (): React.JSX.Element => (
		<div className="flex h-full items-center justify-center p-8 text-center text-sm text-base-content/55">
			해당 상태의 파일이 없습니다.
		</div>
	);

	const renderTable = (): React.JSX.Element => (
		<div className="card flex h-full min-h-0 flex-col overflow-hidden bg-base-100 shadow-sm">
			<div className="card-body flex min-h-0 flex-col overflow-hidden p-3">
				{renderListHeader()}

				<div className="min-h-0 flex-1 overflow-hidden rounded-box border border-base-content/5">
					<div ref={tableContainerRef} className="h-full overflow-auto">
						{displayFileIndexes.length === 0 ? (
							renderEmptyFilteredState()
						) : (
							<table className="table table-pin-rows table-xs w-full min-w-[680px] table-fixed 2xl:min-w-0">
								<thead>
									<tr>
										<th className="w-[44px]">#</th>
										{onFilterChange && (
											<th className="hidden w-[112px] lg:table-cell">상태</th>
										)}
										<th className="hidden w-[78px] md:table-cell">코드</th>
										<th className="hidden w-[78px] lg:table-cell">유형</th>
										<th>제목</th>
										<th className="hidden w-[12%] min-w-[92px] lg:table-cell">
											오리진
										</th>
										<th className="hidden w-[14%] min-w-[108px] xl:table-cell">
											작가
										</th>
										<th className="w-[76px]">크기</th>
										{showModifiedDate && (
											<th className="hidden w-[92px] md:table-cell">수정일</th>
										)}
									</tr>
								</thead>
								<tbody>
									{displayFileIndexes.map((fileIndex, orderIndex) => {
										const file = fileList[fileIndex];
										if (!file) {
											return null;
										}

										const relativePath = getRelativePath(
											file.path,
											selectedPath || "",
										);
										const parsedData = parseFileStructure(relativePath);
										const statusInfo = getReviewStatusInfo(file);
										const isSelected = selectedRowIndex === fileIndex;
										const groupedLabel = file.groupName
											? `그룹화됨: ${file.groupName}`
											: "그룹화됨";

										return (
											<tr
												key={file.path}
												data-file-row-index={fileIndex}
												tabIndex={0}
												aria-selected={isSelected}
												aria-label={`${orderIndex + 1}. ${parsedData.title || file.name}, ${statusInfo.label}`}
												className={`hover cursor-pointer focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-primary ${
													isSelected
														? "bg-primary/20 hover:bg-primary/30"
														: file.isGrouped
															? "bg-warning/5"
															: ""
												}`}
												onClick={() => onRowClick(fileIndex)}
												onKeyDown={(event) =>
													handleSelectableKeyDown(event, fileIndex)
												}
												onContextMenu={(e) => handleContextMenu(e, file)}
											>
												<th className="text-xs text-base-content/60">
													{orderIndex + 1}
												</th>
												{onFilterChange && (
													<td className="hidden lg:table-cell">
														<div className="max-w-full truncate">
															{renderStatusBadge(file)}
														</div>
													</td>
												)}
												<td className="hidden md:table-cell">
													<div className="truncate font-mono text-xs text-base-content/60">
														{parsedData.code || "-"}
													</div>
												</td>
												<td className="hidden lg:table-cell">
													<div
														className={`badge ${getTypeColor(parsedData.type)} badge-xs`}
													>
														{parsedData.type || "-"}
													</div>
												</td>
												<td>
													<div className="flex min-w-0 flex-col gap-1">
														<div className="flex flex-wrap items-center gap-1">
															{onFilterChange && (
																<span className="lg:hidden">
																	{renderStatusBadge(file)}
																</span>
															)}
															{file.isGrouped && (
																<span
																	className="badge badge-warning badge-xs"
																	title={groupedLabel}
																>
																	그룹화됨
																</span>
															)}
															{file.groupCandidate && (
																<span className="badge badge-outline badge-xs">
																	후보 {file.groupCandidate.confidence}%
																</span>
															)}
														</div>
														<div
															className="truncate text-sm font-medium"
															title={parsedData.title || file.name}
														>
															{parsedData.title || file.name}
														</div>
														<div className="truncate text-xs text-base-content/55 md:hidden">
															{parsedData.code && `${parsedData.code} · `}
															{parsedData.artist || relativePath}
														</div>
													</div>
												</td>
												<td className="hidden lg:table-cell">
													<div
														className="truncate text-sm font-medium"
														title={parsedData.origin}
													>
														{parsedData.origin || "-"}
													</div>
												</td>
												<td className="hidden xl:table-cell">
													<div
														className="truncate text-sm font-semibold text-base-content"
														title={parsedData.artist}
													>
														{parsedData.artist || "-"}
													</div>
												</td>
												<td>
													<div className="badge badge-ghost badge-xs">
														{formatFileSize(file.size)}
													</div>
												</td>
												{showModifiedDate && (
													<td className="hidden md:table-cell">
														<div className="truncate text-xs text-base-content/70">
															{formatModifiedDate(file.modifiedTimeMs)}
														</div>
													</td>
												)}
											</tr>
										);
									})}
								</tbody>
							</table>
						)}
					</div>
				</div>
			</div>
		</div>
	);

	const renderCardList = (): React.JSX.Element => (
		<div className="card flex h-full min-h-0 flex-col overflow-hidden bg-base-100 shadow-sm">
			<div className="card-body flex min-h-0 flex-col overflow-hidden p-3">
				{renderListHeader()}

				<div
					ref={tableContainerRef}
					className="min-h-0 flex-1 overflow-auto pr-1"
				>
					{displayFileIndexes.length === 0 ? (
						renderEmptyFilteredState()
					) : (
						<div className="flex flex-col gap-3">
							{displayFileIndexes.map((fileIndex, orderIndex) => {
								const file = fileList[fileIndex];
								if (!file) {
									return null;
								}

								const relativePath = getRelativePath(
									file.path,
									selectedPath || "",
								);
								const parsedData = parseFileStructure(relativePath);
								const isSelected = selectedRowIndex === fileIndex;
								const title = parsedData.title || file.name;
								const groupedLabel = file.groupName
									? `그룹화됨: ${file.groupName}`
									: "그룹화됨";

								return (
									<button
										type="button"
										key={file.path}
										data-file-row-index={fileIndex}
										aria-pressed={isSelected}
										className={`flex w-full cursor-pointer flex-col gap-4 rounded-box border bg-base-100 p-3 text-left shadow-sm transition-colors focus:outline focus:outline-2 focus:outline-primary sm:flex-row ${
											isSelected
												? "border-primary/60 bg-primary/5"
												: "border-base-content/10 hover:border-primary/30 hover:bg-base-100/80"
										}`}
										onClick={() => onRowClick(fileIndex)}
										onKeyDown={(event) =>
											handleSelectableKeyDown(event, fileIndex)
										}
										onContextMenu={(e) => handleContextMenu(e, file)}
									>
										<div className="flex flex-shrink-0 justify-center sm:justify-start">
											{renderCardThumbnail(file)}
										</div>

										<div className="flex min-w-0 flex-1 flex-col gap-3">
											<div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
												<div className="min-w-0">
													<div className="mb-2 flex flex-wrap items-center gap-2">
														<span className="badge badge-neutral badge-sm">
															#{orderIndex + 1}
														</span>
														{onFilterChange && renderStatusBadge(file)}
														{parsedData.code && (
															<span className="badge badge-ghost badge-sm font-mono">
																{parsedData.code}
															</span>
														)}
														<span
															className={`badge ${getTypeColor(parsedData.type)} badge-sm`}
														>
															{parsedData.type || "유형 없음"}
														</span>
														{file.isGrouped && (
															<span
																className="badge badge-warning badge-sm"
																title={groupedLabel}
															>
																그룹화됨
															</span>
														)}
													</div>
													<div className="break-words text-lg font-semibold leading-snug text-base-content">
														{title}
													</div>
													<div
														className="mt-1 truncate font-mono text-[11px] text-base-content/45"
														title={file.name}
													>
														{file.name}
													</div>
												</div>
												<div className="badge badge-ghost badge-sm shrink-0">
													{formatFileSize(file.size)}
												</div>
											</div>

											<div
												className={`grid gap-2 ${showModifiedDate ? "md:grid-cols-4" : "md:grid-cols-3"}`}
											>
												{renderDetailValue(
													"오리진",
													getValueOrFallback(parsedData.origin),
												)}
												{renderDetailValue(
													"작가",
													getValueOrFallback(parsedData.artist),
												)}
												{renderDetailValue(
													"분류",
													getValueOrFallback(parsedData.category),
												)}
												{showModifiedDate &&
													renderDetailValue(
														"수정일",
														formatModifiedDate(file.modifiedTimeMs),
													)}
											</div>

											<div
												className="truncate rounded bg-base-200/70 px-3 py-2 font-mono text-[11px] text-base-content/55"
												title={relativePath}
											>
												{relativePath || file.name}
											</div>
										</div>
									</button>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);

	const renderDetailPanel = (
		variant: "panel" | "modal" = "panel",
	): React.JSX.Element => {
		const panelClassName =
			variant === "modal"
				? "min-h-0 bg-base-100"
				: "card min-h-[220px] bg-base-100 shadow-sm [@media(min-width:1440px)]:h-full [@media(min-width:1440px)]:min-h-0";
		const bodyClassName =
			variant === "modal"
				? "flex max-h-[calc(85vh-4rem)] flex-col gap-4 overflow-auto p-4"
				: "card-body flex min-h-0 flex-col gap-4 overflow-auto p-4";

		if (!selectedFile) {
			return (
				<aside className={panelClassName}>
					<div className="flex min-h-[160px] items-center justify-center p-4 text-center text-sm text-base-content/55">
						선택된 파일이 없습니다.
					</div>
				</aside>
			);
		}

		const relativePath = getRelativePath(selectedFile.path, selectedPath || "");
		const parsedData = parseFileStructure(relativePath);
		const statusInfo = getReviewStatusInfo(selectedFile);
		const favoriteArtistCandidate = selectedFile.favoriteArtistCandidate;
		const actionGridClassName = favoriteArtistCandidate
			? "grid-cols-2"
			: "grid-cols-3";

		return (
			<aside className={panelClassName}>
				<div className={bodyClassName}>
					<div className="min-w-0">
						{onFilterChange && (
							<div className="mb-2 flex flex-wrap items-center gap-2">
								<span className={`badge ${statusInfo.className} badge-sm`}>
									{statusInfo.label}
								</span>
								{selectedFile.groupCandidate && (
									<span className="badge badge-outline badge-sm">
										그룹 {selectedFile.groupCandidate.confidence}%
									</span>
								)}
							</div>
						)}
						<h2
							className="break-words text-base font-semibold leading-snug"
							title={parsedData.title || selectedFile.name}
						>
							{parsedData.title || selectedFile.name}
						</h2>
						<div
							className="mt-1 truncate font-mono text-[11px] text-base-content/50"
							title={selectedFile.name}
						>
							{selectedFile.name}
						</div>
					</div>

					<div className="grid gap-2 sm:grid-cols-2 [@media(min-width:1440px)]:grid-cols-1">
						{renderDetailValue("코드", parsedData.code)}
						{renderDetailValue("유형", parsedData.type)}
						{renderDetailValue("오리진", parsedData.origin)}
						{renderDetailValue("작가", parsedData.artist)}
						{renderDetailValue("분류", parsedData.category)}
						{renderDetailValue("크기", formatFileSize(selectedFile.size))}
					</div>

					<div className="space-y-2">
						<div>
							<div className="text-[11px] font-semibold text-base-content/50">
								상대 경로
							</div>
							<div
								className="mt-1 break-all rounded-box bg-base-200/70 p-2 font-mono text-[11px]"
								title={relativePath}
							>
								{relativePath || selectedFile.name}
							</div>
						</div>
						<div>
							<div className="text-[11px] font-semibold text-base-content/50">
								대상 경로
							</div>
							<div
								className="mt-1 break-all rounded-box bg-base-200/70 p-2 font-mono text-[11px]"
								title={getTargetPathPreview(selectedFile, selectedPath)}
							>
								{getTargetPathPreview(selectedFile, selectedPath)}
							</div>
						</div>
					</div>

					{selectedFile.reviewError && (
						<div className="alert alert-error py-2 text-sm">
							<span>{selectedFile.reviewError}</span>
						</div>
					)}

					{selectedFile.duplicate && (
						<section className="rounded-box border border-error/20 bg-error/5 p-3">
							<div className="mb-2 text-sm font-semibold">중복 파일</div>
							<div className="space-y-2 text-xs">
								<div className="break-all font-mono">
									{selectedFile.duplicate.targetPath}
								</div>
								<div className="flex flex-wrap gap-2">
									<span className="badge badge-ghost badge-sm">
										새 파일 {formatFileSize(selectedFile.duplicate.sourceSize)}
									</span>
									<span className="badge badge-ghost badge-sm">
										기존 {formatFileSize(selectedFile.duplicate.targetSize)}
									</span>
								</div>
							</div>
							<div className="mt-3 join w-full">
								<button
									type="button"
									className={`btn join-item btn-xs flex-1 ${
										selectedFile.duplicateAction === "overwrite"
											? "btn-warning"
											: "btn-outline"
									}`}
									aria-pressed={selectedFile.duplicateAction === "overwrite"}
									aria-label={`${selectedFile.name} 중복 파일 덮어쓰기 선택`}
									onClick={() =>
										onDuplicateActionChange?.(selectedFile.path, "overwrite")
									}
								>
									덮어쓰기
								</button>
								<button
									type="button"
									className={`btn join-item btn-xs flex-1 ${
										selectedFile.duplicateAction === "skip"
											? "btn-neutral"
											: "btn-outline"
									}`}
									aria-pressed={selectedFile.duplicateAction === "skip"}
									aria-label={`${selectedFile.name} 중복 파일 건너뛰기 선택`}
									onClick={() =>
										onDuplicateActionChange?.(selectedFile.path, "skip")
									}
								>
									건너뛰기
								</button>
								<button
									type="button"
									className={`btn join-item btn-xs flex-1 ${
										selectedFile.duplicateAction === "keep"
											? "btn-neutral"
											: "btn-outline"
									}`}
									aria-pressed={selectedFile.duplicateAction === "keep"}
									aria-label={`${selectedFile.name} 중복 파일 목록 유지 선택`}
									onClick={() =>
										onDuplicateActionChange?.(selectedFile.path, "keep")
									}
								>
									목록 유지
								</button>
							</div>
						</section>
					)}

					{selectedFile.groupCandidate && (
						<section className="rounded-box border border-warning/25 bg-warning/5 p-3">
							<div className="mb-2 flex items-center justify-between gap-2">
								<div className="text-sm font-semibold">그룹 후보</div>
								<span className="badge badge-warning badge-sm">
									{selectedFile.groupCandidate.confidence}%
								</span>
							</div>
							<div className="space-y-2 text-xs">
								<div className="font-semibold">
									{selectedFile.groupCandidate.groupName}
								</div>
								<div className="break-all font-mono text-base-content/70">
									{selectedFile.groupCandidate.groupPath}
								</div>
								<div className="flex flex-wrap gap-1">
									{selectedFile.groupCandidate.reasons.map((reason) => (
										<span key={reason} className="badge badge-outline badge-xs">
											{reason}
										</span>
									))}
								</div>
								{selectedFile.groupCandidate.sampleFiles.length > 0 && (
									<div className="max-h-20 overflow-auto rounded bg-base-100/70 p-2 font-mono text-[11px]">
										{selectedFile.groupCandidate.sampleFiles.map((sample) => (
											<div key={sample} className="truncate" title={sample}>
												{sample}
											</div>
										))}
									</div>
								)}
								{selectedFile.duplicate && (
									<div className="rounded bg-base-100/70 p-2 text-[11px] text-base-content/60">
										중복 파일은 중복 처리 선택이 우선 적용됩니다.
									</div>
								)}
							</div>
							<div className="mt-3 join w-full">
								<button
									type="button"
									className={`btn join-item btn-xs flex-1 ${
										selectedFile.useGroupTarget !== false
											? "btn-warning"
											: "btn-outline"
									}`}
									disabled={Boolean(selectedFile.duplicate)}
									aria-pressed={selectedFile.useGroupTarget !== false}
									aria-label={`${selectedFile.name} 그룹 후보로 편입`}
									onClick={() => onGroupTargetChange?.(selectedFile.path, true)}
								>
									그룹 편입
								</button>
								<button
									type="button"
									className={`btn join-item btn-xs flex-1 ${
										selectedFile.useGroupTarget === false
											? "btn-neutral"
											: "btn-outline"
									}`}
									disabled={Boolean(selectedFile.duplicate)}
									aria-pressed={selectedFile.useGroupTarget === false}
									aria-label={`${selectedFile.name} 기본 경로로 보관`}
									onClick={() =>
										onGroupTargetChange?.(selectedFile.path, false)
									}
								>
									기본 경로
								</button>
							</div>
						</section>
					)}

					<div className={`grid ${actionGridClassName} gap-2`}>
						<button
							type="button"
							className="btn btn-outline btn-sm min-w-0 px-2"
							aria-label={`${selectedFile.name} 복사`}
							title="복사"
							onClick={() => onCopyFile?.(selectedFile)}
						>
							<CopyIcon className="h-4 w-4" />
							<span className="text-xs">복사</span>
						</button>
						<button
							type="button"
							className="btn btn-outline btn-success btn-sm min-w-0 px-2"
							aria-label={`${selectedFile.name} 저장소 루트로 이동`}
							title="저장소로 이동"
							onClick={() => onMoveFile?.(selectedFile)}
						>
							<MoveIcon className="h-4 w-4" />
							<span className="text-xs">저장소</span>
						</button>
						<button
							type="button"
							className="btn btn-accent btn-outline btn-sm min-w-0 px-2"
							aria-label={`${selectedFile.name} Favorite 폴더로 이동`}
							title="Favorite 폴더로 이동"
							onClick={() => onKeepFile?.(selectedFile)}
						>
							<FavoriteIcon className="h-4 w-4" />
							<span className="text-xs">Favorite</span>
						</button>
						{favoriteArtistCandidate && (
							<button
								type="button"
								className="btn btn-info btn-outline btn-sm min-w-0 px-2"
								aria-label={`${selectedFile.name} Favorite Artist ${favoriteArtistCandidate.artistFolderName} 폴더로 이동`}
								title={`Favorite Artist/${favoriteArtistCandidate.artistFolderName}로 이동`}
								onClick={() => onMoveToFavoriteArtist?.(selectedFile)}
							>
								<FolderIcon className="h-4 w-4" />
								<span className="text-xs">작가</span>
							</button>
						)}
					</div>
				</div>
			</aside>
		);
	};

	const renderContextMenu = (): React.JSX.Element | null => {
		if (!contextMenu.isOpen) {
			return null;
		}

		return (
			<div
				className="fixed z-50 min-w-[150px] rounded-box border border-base-content/10 bg-base-100 py-2 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
				style={{
					left: contextMenu.x,
					top: contextMenu.y,
				}}
				role="menu"
				tabIndex={-1}
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setContextMenu({ isOpen: false, x: 0, y: 0, file: null });
					}
				}}
			>
				<div className="mb-2 truncate border-b border-base-content/10 px-3 py-2 text-xs text-base-content/60">
					{contextMenu.file?.name}
				</div>

				<button
					type="button"
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200 focus:bg-base-200 focus:outline-none"
					role="menuitem"
					onClick={() => handleMenuItemClick("copy")}
				>
					<CopyIcon className="h-4 w-4 text-base-content/70" />
					<span>복사</span>
				</button>

				<button
					type="button"
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200 focus:bg-base-200 focus:outline-none"
					role="menuitem"
					onClick={() => handleMenuItemClick("move")}
				>
					<MoveIcon className="h-4 w-4 text-base-content/70" />
					<span>저장소 이동</span>
				</button>

				<button
					type="button"
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200 focus:bg-base-200 focus:outline-none"
					role="menuitem"
					onClick={() => handleMenuItemClick("keep")}
				>
					<FavoriteIcon className="h-4 w-4 text-base-content/70" />
					<span>Favorite 이동</span>
				</button>

				{contextMenu.file?.favoriteArtistCandidate && (
					<button
						type="button"
						className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200 focus:bg-base-200 focus:outline-none"
						role="menuitem"
						onClick={() => handleMenuItemClick("favoriteArtist")}
					>
						<FolderIcon className="h-4 w-4 text-base-content/70" />
						<span>Favorite Artist 이동</span>
					</button>
				)}
			</div>
		);
	};

	return (
		<>
			<div className="grid min-h-0 flex-1 gap-3 overflow-hidden [@media(min-width:1440px)]:grid-cols-[minmax(0,1fr)_minmax(300px,360px)]">
				<div className="min-h-0 overflow-hidden">
					{thumbnailEnabled ? renderCardList() : renderTable()}
				</div>
				{onFilterChange && (
					<div className="hidden min-h-0 overflow-hidden [@media(min-width:1440px)]:block">
						{renderDetailPanel()}
					</div>
				)}
			</div>
			{onFilterChange && isDetailModalOpen && (
				<dialog
					className="modal modal-open [@media(min-width:1440px)]:hidden"
					open
				>
					<div className="modal-box max-h-[85vh] max-w-3xl overflow-hidden p-0">
						<div className="flex items-center justify-between gap-3 border-b border-base-content/10 px-4 py-3">
							<div className="min-w-0">
								<div className="text-sm font-semibold">선택 파일 상세</div>
								<div
									className="truncate text-xs text-base-content/55"
									title={selectedFile?.name}
								>
									{selectedFile?.name}
								</div>
							</div>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								aria-label="선택 파일 상세 닫기"
								onClick={() => setIsDetailModalOpen(false)}
							>
								닫기
							</button>
						</div>
						{renderDetailPanel("modal")}
					</div>
					<form method="dialog" className="modal-backdrop">
						<button
							type="button"
							aria-label="선택 파일 상세 닫기"
							onClick={() => setIsDetailModalOpen(false)}
						>
							close
						</button>
					</form>
				</dialog>
			)}
			{renderContextMenu()}
		</>
	);
};
