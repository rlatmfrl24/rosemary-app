import type React from "react";
import type { RefObject } from "react";
import { useEffect, useState } from "react";
import type { FileInfo } from "../types";
import {
	formatFileSize,
	getRelativePath,
	parseFileStructure,
} from "../utils/file";
import { ArchiveIcon, CopyIcon, MoveIcon } from "./Icons";

interface ThumbnailProgress {
	loaded: number;
	total: number;
	currentFileName?: string;
}

interface FileTableProps {
	fileList: FileInfo[];
	selectedRowIndex: number;
	selectedPath: string | null;
	thumbnailEnabled: boolean;
	thumbnailProgress: ThumbnailProgress | null;
	tableContainerRef: RefObject<HTMLDivElement>;
	onRowClick: (index: number) => void;
	onCopyFile?: (file: FileInfo) => void;
	onMoveFile?: (file: FileInfo) => void;
	onKeepFile?: (file: FileInfo) => void;
}

interface ContextMenuState {
	isOpen: boolean;
	x: number;
	y: number;
	file: FileInfo | null;
}

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

export const FileTable = ({
	fileList,
	selectedRowIndex,
	selectedPath,
	thumbnailEnabled,
	thumbnailProgress,
	tableContainerRef,
	onRowClick,
	onCopyFile,
	onMoveFile,
	onKeepFile,
}: FileTableProps): React.JSX.Element => {
	const [contextMenu, setContextMenu] = useState<ContextMenuState>({
		isOpen: false,
		x: 0,
		y: 0,
		file: null,
	});

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

	const handleContextMenu = (e: React.MouseEvent, file: FileInfo) => {
		e.preventDefault();
		e.stopPropagation();

		setContextMenu({
			isOpen: true,
			x: e.clientX,
			y: e.clientY,
			file,
		});
	};

	const handleMenuItemClick = (action: "copy" | "move" | "keep") => {
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
		}

		setContextMenu({ isOpen: false, x: 0, y: 0, file: null });
	};

	const renderListHeader = (): React.JSX.Element => (
		<div className="mb-3 flex flex-shrink-0 items-center justify-between gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-sm font-semibold">파일 목록</span>
				<div className="badge badge-neutral badge-sm">{fileList.length}개</div>
				{thumbnailEnabled && thumbnailProgress && (
					<div className="badge badge-outline badge-sm gap-1">
						{thumbnailProgress.loaded < thumbnailProgress.total && (
							<span className="loading loading-spinner loading-xs" />
						)}
						썸네일 {thumbnailProgress.loaded}/{thumbnailProgress.total}
					</div>
				)}
			</div>
			<div className="hidden max-w-[42rem] truncate text-[11px] text-base-content/50 lg:block">
				{thumbnailProgress?.currentFileName
					? `썸네일 로딩: ${thumbnailProgress.currentFileName}`
					: "Enter 열기 · Del 제거 · Shift+Del 삭제 · 우클릭 메뉴"}
			</div>
		</div>
	);

	const renderCardThumbnail = (file: FileInfo): React.JSX.Element => {
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

	const renderTable = (): React.JSX.Element => (
		<div className="card flex h-0 flex-auto flex-col overflow-hidden bg-base-100 shadow-sm">
			<div className="card-body flex flex-col overflow-hidden p-3">
				{renderListHeader()}

				<div className="flex-1 overflow-hidden rounded-box border border-base-content/5">
					<div ref={tableContainerRef} className="h-full overflow-auto">
						<table className="table table-pin-rows table-xs table-fixed w-full">
							<thead>
								<tr>
									<th className="w-[6%] min-w-[40px]">#</th>
									<th className="hidden w-[8%] min-w-[60px] sm:table-cell">
										코드
									</th>
									<th className="hidden w-[6%] min-w-[50px] md:table-cell">
										유형
									</th>
									<th className="w-[44%] sm:w-[38%] md:w-[38%] lg:w-[36%]">
										제목
									</th>
									<th className="hidden w-[10%] min-w-[80px] lg:table-cell">
										오리진
									</th>
									<th className="hidden w-[12%] min-w-[100px] md:table-cell">
										작가
									</th>
									<th className="hidden w-[6%] min-w-[50px] lg:table-cell">
										분류
									</th>
									<th className="w-[8%] min-w-[60px]">크기</th>
								</tr>
							</thead>
							<tbody>
								{fileList.map((file, index) => {
									const relativePath = getRelativePath(
										file.path,
										selectedPath || "",
									);
									const parsedData = parseFileStructure(relativePath);
									const isSelected = selectedRowIndex === index;

									return (
										<tr
											key={file.path}
											className={`hover cursor-pointer ${isSelected ? "bg-primary/20 hover:bg-primary/30" : ""}`}
											onClick={() => onRowClick(index)}
											onContextMenu={(e) => handleContextMenu(e, file)}
										>
											<th className="text-xs text-base-content/60">
												{index + 1}
											</th>
											<td className="hidden sm:table-cell">
												<div className="truncate font-mono text-xs text-base-content/60">
													{parsedData.code || "-"}
												</div>
											</td>
											<td className="hidden md:table-cell">
												<div
													className={`badge ${getTypeColor(parsedData.type)} badge-xs`}
												>
													{parsedData.type || "-"}
												</div>
											</td>
											<td>
												<div
													className="truncate text-sm font-medium"
													title={parsedData.title}
												>
													{parsedData.title || file.name}
												</div>
												<div className="mt-1 truncate text-xs text-base-content/60 sm:hidden">
													{parsedData.code && `${parsedData.code} · `}
													{parsedData.artist && `${parsedData.artist}`}
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
											<td className="hidden md:table-cell">
												<div
													className="truncate text-sm font-semibold text-base-content"
													title={parsedData.artist}
												>
													{parsedData.artist || "-"}
												</div>
											</td>
											<td className="hidden lg:table-cell">
												<div className="truncate text-xs opacity-70">
													{parsedData.category || "-"}
												</div>
											</td>
											<td>
												<div className="badge badge-ghost badge-xs">
													{formatFileSize(file.size)}
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</div>
			</div>
		</div>
	);

	const renderCardList = (): React.JSX.Element => (
		<div className="flex h-0 flex-auto flex-col overflow-hidden">
			{renderListHeader()}

			<div ref={tableContainerRef} className="h-full overflow-auto pr-1">
				<div className="flex flex-col gap-3">
					{fileList.map((file, index) => {
						const relativePath = getRelativePath(file.path, selectedPath || "");
						const parsedData = parseFileStructure(relativePath);
						const isSelected = selectedRowIndex === index;
						const title = parsedData.title || file.name;

						return (
							<button
								type="button"
								key={file.path}
								data-file-row-index={index}
								className={`flex w-full cursor-pointer flex-col gap-4 rounded-box border bg-base-100 p-3 text-left shadow-sm transition-colors sm:flex-row ${
									isSelected
										? "border-primary/60 bg-primary/5"
										: "border-base-content/10 hover:border-primary/30 hover:bg-base-100/80"
								}`}
								onClick={() => onRowClick(index)}
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
													#{index + 1}
												</span>
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

									<div className="grid gap-2 md:grid-cols-3">
										<div className="min-w-0 rounded bg-base-200/70 px-3 py-2">
											<div className="text-[11px] text-base-content/45">
												오리진
											</div>
											<div
												className="truncate text-sm font-medium"
												title={parsedData.origin}
											>
												{getValueOrFallback(parsedData.origin)}
											</div>
										</div>
										<div className="min-w-0 rounded bg-base-200/70 px-3 py-2">
											<div className="text-[11px] text-base-content/45">
												작가
											</div>
											<div
												className="truncate text-sm font-semibold text-base-content"
												title={parsedData.artist}
											>
												{getValueOrFallback(parsedData.artist)}
											</div>
										</div>
										<div className="min-w-0 rounded bg-base-200/70 px-3 py-2">
											<div className="text-[11px] text-base-content/45">
												분류
											</div>
											<div
												className="truncate text-sm"
												title={parsedData.category}
											>
												{getValueOrFallback(parsedData.category)}
											</div>
										</div>
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
			</div>
		</div>
	);

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
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200"
					onClick={() => handleMenuItemClick("copy")}
				>
					<CopyIcon className="h-4 w-4 text-base-content/70" />
					<span>복사</span>
				</button>

				<button
					type="button"
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200"
					onClick={() => handleMenuItemClick("move")}
				>
					<MoveIcon className="h-4 w-4 text-base-content/70" />
					<span>이동</span>
				</button>

				<button
					type="button"
					className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200"
					onClick={() => handleMenuItemClick("keep")}
				>
					<ArchiveIcon className="h-4 w-4 text-base-content/70" />
					<span>보관</span>
				</button>
			</div>
		);
	};

	return (
		<>
			{thumbnailEnabled ? renderCardList() : renderTable()}
			{renderContextMenu()}
		</>
	);
};
