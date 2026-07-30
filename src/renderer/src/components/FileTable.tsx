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
import {
	getGalleryMetadataSourceLabel,
	getMetadataProvenanceClassName,
	getMetadataProvenanceLabel,
	getSourceTagNamespaceLabel,
	groupSourceTags,
	resolveFileDisplayMetadata,
} from "../utils/gallery-metadata";
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
			| "reviewIssues"
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
	onRequestSourceMetadata?: (file: TFile) => void | Promise<void>;
	isRequestingSourceMetadata?: (file: TFile) => boolean;
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
	{ value: "favorite-artist", label: "작가 후보" },
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

const getArchiveRecoveryStatusInfo = (
	file: TableFileInfo,
	isRequesting: boolean,
): StatusInfo => {
	const status = file.archiveRecovery?.status;
	if (isRequesting || status === "pending") {
		return {
			label: isRequesting ? "조회 요청 중" : "대기/조회 중",
			className: "badge-info",
			description: "Hitomi 로컬 카탈로그에서 원천 정보를 조회하고 있습니다.",
		};
	}
	if (
		status === "official" ||
		file.sourceMetadata?.sourceKind === "ehentai-api"
	) {
		return {
			label: "기존 공식",
			className: "badge-success",
			description:
				"과거에 저장된 E-Hentai 원천 정보를 읽기 전용으로 보유하고 있습니다.",
		};
	}
	if (status === "expunged") {
		return {
			label: "삭제됨",
			className: "badge-neutral",
			description: "과거 원격 조회에서 삭제된 gallery로 확인된 상태입니다.",
		};
	}
	if (status === "access-denied") {
		return {
			label: "과거 접근 불가",
			className: "badge-warning",
			description: "과거 원격 조회에서 접근할 수 없었던 상태입니다.",
		};
	}
	if (status === "token-not-found") {
		return {
			label: "카탈로그에 없음",
			className: "badge-warning",
			description:
				"현재 Hitomi 로컬 카탈로그에서 gallery id를 찾지 못했습니다.",
		};
	}
	if (status === "failed") {
		return {
			label: "실패",
			className: "badge-error",
			description: "Hitomi 로컬 카탈로그 읽기 또는 저장에 실패했습니다.",
		};
	}
	if (
		status === "catalog-only" ||
		file.sourceMetadata?.sourceKind === "hitomi-catalog"
	) {
		return {
			label: "로컬 카탈로그",
			className: "badge-secondary",
			description: "Hitomi Downloader 전체 다운로드 DB의 정보를 사용합니다.",
		};
	}
	return {
		label: "로컬 미조회",
		className: "badge-ghost",
		description: "버튼을 누르면 Hitomi 로컬 카탈로그만 조회합니다.",
	};
};

const getArchiveRecoveryButtonLabel = (file: TableFileInfo): string => {
	switch (file.archiveRecovery?.status) {
		case "catalog-only":
			return "로컬 카탈로그 새로고침";
		case "access-denied":
		case "token-not-found":
		case "failed":
			return "로컬 카탈로그 다시 조회";
		default:
			return "로컬 카탈로그 조회";
	}
};

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

	if (file.reviewIssues && file.reviewIssues.length > 0) {
		const hasMetadataConflict = file.reviewIssues.some(
			(issue) => issue.kind === "metadata-conflict",
		);
		return {
			label: hasMetadataConflict ? "원천 충돌" : "대상 모호",
			className: "badge-warning",
			description: file.reviewIssues.map((issue) => issue.message).join(" / "),
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

	if (file.favoriteArtistCandidate) {
		return {
			label: "작가 후보",
			className: "badge-info",
			description: `${file.favoriteArtistCandidate.relativeTargetDirectory} 작가 폴더로 이동할 수 있습니다.`,
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
		(file) =>
			(!file.reviewStatus || file.reviewStatus === "ready") &&
			!file.favoriteArtistCandidate,
	).length,
	"favorite-artist": fileList.filter((file) =>
		Boolean(file.favoriteArtistCandidate),
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

const renderDetailBadgeValue = (
	label: string,
	value: string,
	className: string,
): React.JSX.Element => (
	<div className="min-w-0 rounded bg-base-200/70 px-3 py-2">
		<div className="text-[11px] text-base-content/50">{label}</div>
		<div className={`badge badge-sm mt-0.5 ${className}`}>{value}</div>
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
	onRequestSourceMetadata,
	isRequestingSourceMetadata,
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
		if (event.key !== " ") {
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

	const renderFavoriteArtistBadge = (
		file: TableFileInfo,
		size: "xs" | "sm" = "xs",
	): React.JSX.Element | null => {
		if (!file.favoriteArtistCandidate) {
			return null;
		}

		const sizeClassName = size === "sm" ? "badge-sm" : "badge-xs";

		return (
			<span
				className={`badge badge-info ${sizeClassName}`}
				title={`Favorite Artist/${file.favoriteArtistCandidate.artistFolderName}`}
			>
				작가 후보
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
										<th className="hidden w-[78px] 2xl:table-cell">평점</th>
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
										const displayData = resolveFileDisplayMetadata(
											parseFileStructure(relativePath),
											file.sourceMetadata,
										);
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
												aria-label={`${orderIndex + 1}. ${displayData.title || file.name}, ${statusInfo.label}`}
												className={`hover cursor-pointer focus:outline focus:outline-2 focus:outline-offset-[-2px] focus:outline-primary ${
													isSelected
														? "bg-primary/20 hover:bg-primary/30"
														: file.isGrouped
															? "bg-warning/5"
															: ""
												}`}
												onFocus={() => onRowClick(fileIndex)}
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
														{displayData.code || "-"}
													</div>
												</td>
												<td className="hidden lg:table-cell">
													<div
														className={`badge ${getTypeColor(displayData.type)} badge-xs`}
													>
														{displayData.type || "-"}
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
															{renderFavoriteArtistBadge(file)}
														</div>
														<div
															className="truncate text-sm font-medium"
															title={displayData.title || "제목 정보 없음"}
														>
															{displayData.title || "제목 정보 없음"}
														</div>
														{displayData.titleJapanese &&
															displayData.titleJapanese !==
																displayData.title && (
																<div
																	className="truncate text-xs text-base-content/55"
																	title={displayData.titleJapanese}
																>
																	{displayData.titleJapanese}
																</div>
															)}
														<div className="truncate text-xs text-base-content/55 md:hidden">
															{displayData.code && `${displayData.code} · `}
															{displayData.artist || relativePath}
														</div>
													</div>
												</td>
												<td className="hidden lg:table-cell">
													<div
														className="truncate text-sm font-medium"
														title={displayData.origin}
													>
														{displayData.origin || "-"}
													</div>
												</td>
												<td className="hidden xl:table-cell">
													<div
														className="truncate text-sm font-semibold text-base-content"
														title={displayData.artist}
													>
														{displayData.artist || "-"}
													</div>
												</td>
												<td className="hidden 2xl:table-cell">
													<div className="badge badge-ghost badge-xs tabular-nums">
														{displayData.sourceMetadata?.rating?.toFixed(2) ||
															"-"}
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
								const displayData = resolveFileDisplayMetadata(
									parseFileStructure(relativePath),
									file.sourceMetadata,
								);
								const isSelected = selectedRowIndex === fileIndex;
								const title = displayData.title || "제목 정보 없음";
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
										onFocus={() => onRowClick(fileIndex)}
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
														{displayData.code && (
															<span className="badge badge-ghost badge-sm font-mono">
																{displayData.code}
															</span>
														)}
														<span
															className={`badge ${getTypeColor(displayData.type)} badge-sm`}
														>
															{displayData.type || "유형 없음"}
														</span>
														{file.isGrouped && (
															<span
																className="badge badge-warning badge-sm"
																title={groupedLabel}
															>
																그룹화됨
															</span>
														)}
														{renderFavoriteArtistBadge(file, "sm")}
													</div>
													<div className="break-words text-lg font-semibold leading-snug text-base-content">
														{title}
													</div>
													{displayData.titleJapanese &&
														displayData.titleJapanese !== displayData.title && (
															<div className="mt-1 break-words text-sm text-base-content/60">
																{displayData.titleJapanese}
															</div>
														)}
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

											<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
												{renderDetailValue(
													"오리진",
													getValueOrFallback(displayData.origin),
												)}
												{renderDetailValue(
													"작가",
													getValueOrFallback(displayData.artist),
												)}
												{renderDetailValue(
													"평점",
													displayData.sourceMetadata?.rating?.toFixed(2),
												)}
												{renderDetailValue("언어", displayData.language)}
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
				? "flex min-h-0 max-h-[calc(85vh-4rem)] flex-col overflow-hidden bg-base-100"
				: "card flex min-h-[220px] flex-col overflow-hidden bg-base-100 shadow-sm [@media(min-width:1440px)]:h-full [@media(min-width:1440px)]:min-h-0";
		const bodyClassName =
			variant === "modal"
				? "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4"
				: "card-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4";

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
		const displayData = resolveFileDisplayMetadata(
			parseFileStructure(relativePath),
			selectedFile.sourceMetadata,
		);
		const sourceTagGroups = displayData.sourceMetadata
			? groupSourceTags(displayData.sourceMetadata.tags)
			: [];
		const statusInfo = getReviewStatusInfo(selectedFile);
		const favoriteArtistCandidate = selectedFile.favoriteArtistCandidate;
		const actionGridClassName = favoriteArtistCandidate
			? "grid-cols-2"
			: "grid-cols-3";
		const isSourceMetadataRequesting =
			isRequestingSourceMetadata?.(selectedFile) ?? false;
		const recoveryStatusInfo = getArchiveRecoveryStatusInfo(
			selectedFile,
			isSourceMetadataRequesting,
		);
		const canRequestSourceMetadata =
			Boolean(displayData.code && onRequestSourceMetadata) &&
			!isSourceMetadataRequesting &&
			selectedFile.archiveRecovery?.status !== "pending" &&
			selectedFile.archiveRecovery?.status !== "official" &&
			selectedFile.archiveRecovery?.status !== "expunged" &&
			selectedFile.sourceMetadata?.sourceKind !== "ehentai-api";

		return (
			<aside className={panelClassName}>
				<div
					className={`grid ${actionGridClassName} shrink-0 gap-2 border-b border-base-content/10 bg-base-100 px-4 py-3`}
				>
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
								{renderFavoriteArtistBadge(selectedFile, "sm")}
							</div>
						)}
						<h2
							className="break-words text-base font-semibold leading-snug"
							title={displayData.title || "제목 정보 없음"}
						>
							{displayData.title || "제목 정보 없음"}
						</h2>
						{displayData.titleJapanese &&
							displayData.titleJapanese !== displayData.title && (
								<div className="mt-1 break-words text-xs text-base-content/60">
									{displayData.titleJapanese}
								</div>
							)}
						{sourceTagGroups.length > 0 && (
							<div className="mt-3 space-y-2 rounded-box border border-primary/20 bg-primary/5 p-3">
								{sourceTagGroups.map((group) => (
									<div key={group.namespace}>
										<div className="mb-1 text-[11px] font-semibold text-base-content/55">
											{getSourceTagNamespaceLabel(group.namespace)}
										</div>
										<div className="flex flex-wrap gap-1.5">
											{group.values.map((value) => (
												<span
													key={`${group.namespace}:${value}`}
													className="badge badge-outline badge-sm"
												>
													{value}
												</span>
											))}
										</div>
									</div>
								))}
							</div>
						)}
						<div
							className="mt-1 truncate font-mono text-[11px] text-base-content/50"
							title={selectedFile.name}
						>
							{selectedFile.name}
						</div>
					</div>

					<div className="grid gap-2 sm:grid-cols-2 [@media(min-width:1440px)]:grid-cols-1">
						{renderDetailValue("코드", displayData.code)}
						{renderDetailValue("유형", displayData.type)}
						{renderDetailValue("작가", displayData.artist)}
						{renderDetailValue("그룹", displayData.group)}
						{renderDetailValue("오리진/시리즈", displayData.origin)}
						{renderDetailValue("언어", displayData.language)}
						{renderDetailValue("크기", formatFileSize(selectedFile.size))}
						{renderDetailBadgeValue(
							"표시 출처",
							getMetadataProvenanceLabel(displayData.provenance),
							getMetadataProvenanceClassName(displayData.provenance),
						)}
						{renderDetailValue(
							"수집 원천",
							displayData.sourceMetadata
								? getGalleryMetadataSourceLabel(displayData.sourceMetadata)
								: undefined,
						)}
						{renderDetailValue(
							"평점",
							displayData.sourceMetadata?.rating?.toFixed(2),
						)}
						{displayData.sourceMetadata?.canonicalGalleryId &&
							displayData.sourceMetadata.canonicalGalleryId !==
								displayData.code &&
							renderDetailValue(
								"최신 gallery id",
								displayData.sourceMetadata.canonicalGalleryId,
							)}
					</div>

					{displayData.code && onRequestSourceMetadata && (
						<section className="rounded-box border border-info/25 bg-info/5 p-3">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<div>
									<div className="text-sm font-semibold">
										Hitomi 로컬 카탈로그 조회
									</div>
									<div className="mt-1 text-xs text-base-content/60">
										{recoveryStatusInfo.description}
									</div>
								</div>
								<span
									className={`badge badge-sm ${recoveryStatusInfo.className}`}
								>
									{recoveryStatusInfo.label}
								</span>
							</div>
							{selectedFile.archiveRecovery?.error && (
								<div className="mt-2 break-words rounded bg-base-100/70 p-2 text-xs text-error">
									{selectedFile.archiveRecovery.error}
								</div>
							)}
							{canRequestSourceMetadata && (
								<button
									type="button"
									className="btn btn-info btn-sm mt-3 w-full"
									onClick={() => void onRequestSourceMetadata(selectedFile)}
								>
									{getArchiveRecoveryButtonLabel(selectedFile)}
								</button>
							)}
							{(isSourceMetadataRequesting ||
								selectedFile.archiveRecovery?.status === "pending") && (
								<button
									type="button"
									className="btn btn-info btn-sm mt-3 w-full"
									disabled
								>
									<span className="loading loading-spinner loading-xs" />
									로컬 카탈로그 처리 중
								</button>
							)}
						</section>
					)}

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

					{selectedFile.reviewIssues &&
						selectedFile.reviewIssues.length > 0 && (
							<section className="rounded-box border border-warning/30 bg-warning/10 p-3">
								<div className="mb-2 text-sm font-semibold">
									자동 처리 제외 사유
								</div>
								<div className="space-y-2 text-xs">
									{selectedFile.reviewIssues.map((issue, index) => (
										<div
											key={`${issue.kind}:${issue.field ?? "target"}:${index}`}
											className="rounded bg-base-100/70 p-2"
										>
											<div className="font-semibold">{issue.message}</div>
											{issue.sourceValues && (
												<div className="mt-1 text-base-content/65">
													원천: {issue.sourceValues.join(", ")}
												</div>
											)}
											{issue.filenameValues && (
												<div className="text-base-content/65">
													파일명/경로: {issue.filenameValues.join(", ")}
												</div>
											)}
											{issue.blockedGroupPath && (
												<div className="mt-1 break-all font-mono text-[11px]">
													{issue.blockedGroupPath}
												</div>
											)}
											{issue.candidatePaths?.map((candidatePath) => (
												<div
													key={candidatePath}
													className="mt-1 break-all font-mono text-[11px]"
												>
													{candidatePath}
												</div>
											))}
										</div>
									))}
								</div>
							</section>
						)}

					{selectedFile.duplicate && (
						<section className="rounded-box border border-error/20 bg-error/5 p-3">
							<div className="mb-2 text-sm font-semibold">중복 파일</div>
							<div className="space-y-2 text-xs">
								<div className="break-all font-mono">
									{selectedFile.duplicate.targetPath}
								</div>
								<div className="flex flex-wrap gap-2">
									<span className="badge badge-error badge-sm">
										{selectedFile.duplicate.matchKind === "gallery-id-and-path"
											? "gallery id + 경로 일치"
											: selectedFile.duplicate.matchKind === "gallery-id"
												? "gallery id 일치"
												: "상대 경로 일치"}
									</span>
									{selectedFile.duplicate.galleryId && (
										<span className="badge badge-ghost badge-sm font-mono">
											{selectedFile.duplicate.galleryId}
										</span>
									)}
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

					{favoriteArtistCandidate && (
						<section className="rounded-box border border-info/25 bg-info/5 p-3">
							<div className="mb-2 flex items-center justify-between gap-2">
								<div className="text-sm font-semibold">
									Favorite Artist 후보
								</div>
								<span className="badge badge-info badge-sm">
									{favoriteArtistCandidate.artistFolderName}
								</span>
							</div>
							<div className="space-y-2 text-xs">
								<div>
									<span className="text-base-content/55">매칭 작가: </span>
									<span className="font-semibold">
										{favoriteArtistCandidate.artist}
									</span>
								</div>
								<div className="flex flex-wrap gap-1">
									<span className="badge badge-outline badge-xs">
										{favoriteArtistCandidate.metadataSource === "source"
											? "원천 작가"
											: "파일명 보완"}
									</span>
									{favoriteArtistCandidate.matchedArtists.map((artist) => (
										<span key={artist} className="badge badge-ghost badge-xs">
											{artist}
										</span>
									))}
								</div>
								<div className="break-all rounded bg-base-100/70 p-2 font-mono text-[11px]">
									{favoriteArtistCandidate.relativeTargetDirectory}
								</div>
							</div>
						</section>
					)}
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
