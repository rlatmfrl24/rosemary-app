import type React from "react";
import type { RefObject } from "react";
import { useEffect, useState } from "react";
import type { FileInfo } from "../types";
import {
	formatFileSize,
	getRelativePath,
	parseFileStructure,
} from "../utils/file";

interface FileTableProps {
	fileList: FileInfo[];
	selectedRowIndex: number;
	selectedPath: string | null;
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

export const FileTable = ({
	fileList,
	selectedRowIndex,
	selectedPath,
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

	// 컨텍스트 메뉴 외부 클릭 시 닫기
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

	// 우클릭 메뉴 핸들러
	const handleContextMenu = (e: React.MouseEvent, file: FileInfo) => {
		e.preventDefault();
		e.stopPropagation();

		const x = e.clientX;
		const y = e.clientY;

		setContextMenu({
			isOpen: true,
			x,
			y,
			file,
		});
	};

	// 메뉴 아이템 클릭 핸들러
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

	// 유형별 뱃지 색상 함수
	const getTypeColor = (type: string | undefined): string => {
		if (!type) return "badge-outline";

		switch (type) {
			case "Doujinshi":
				return "badge-error";
			case "Manga":
				return "badge-info";
			case "Artist CG":
				return "badge-success";
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

	return (
		<div className="card bg-base-100 shadow-sm flex-auto h-0 flex flex-col overflow-hidden">
			<div className="card-body p-3 flex flex-col overflow-hidden">
				<div className="mb-3 flex items-center justify-between gap-3 flex-shrink-0">
					<div className="flex items-center gap-3">
						<span className="text-sm font-semibold">파일 목록</span>
						<div className="badge badge-neutral badge-sm">
							{fileList.length}개
						</div>
					</div>
					<div className="hidden text-[11px] text-base-content/50 lg:block">
						Enter 열기 · Del 제거 · Shift+Del 삭제 · 우클릭 메뉴
					</div>
				</div>

				<div className="flex-1 overflow-hidden rounded-box border border-base-content/5">
					<div ref={tableContainerRef} className="overflow-auto h-full">
						<table className="table table-pin-rows table-xs table-fixed w-full">
							<thead>
								<tr>
									<th className="w-[6%] min-w-[40px]">#</th>
									<th className="w-[8%] min-w-[60px] hidden sm:table-cell">
										코드
									</th>
									<th className="w-[6%] min-w-[50px] hidden md:table-cell">
										유형
									</th>
									<th className="w-[44%] sm:w-[38%] md:w-[38%] lg:w-[36%]">
										제목
									</th>
									<th className="w-[10%] min-w-[80px] hidden lg:table-cell">
										오리진
									</th>
									<th className="w-[12%] min-w-[100px] hidden md:table-cell">
										작가
									</th>
									<th className="w-[6%] min-w-[50px] hidden lg:table-cell">
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
											<th className="text-base-content/60 text-xs">
												{index + 1}
											</th>
											<td className="hidden sm:table-cell">
												<div className="text-xs font-mono text-base-content/60 truncate">
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
													className="text-sm font-medium truncate"
													title={parsedData.title}
												>
													{parsedData.title || file.name}
												</div>
												{/* 모바일에서 추가 정보 표시 */}
												<div className="sm:hidden text-xs text-base-content/60 truncate mt-1">
													{parsedData.code && `${parsedData.code} • `}
													{parsedData.artist && `${parsedData.artist}`}
												</div>
											</td>
											<td className="hidden lg:table-cell">
												<div
													className="text-sm font-medium truncate"
													title={parsedData.origin}
												>
													{parsedData.origin || "-"}
												</div>
											</td>
											<td className="hidden md:table-cell">
												<div
													className="text-sm font-semibold text-primary truncate"
													title={parsedData.artist}
												>
													{parsedData.artist || "-"}
												</div>
											</td>
											<td className="hidden lg:table-cell">
												<div className="text-xs opacity-70 truncate">
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

			{/* 컨텍스트 메뉴 */}
			{contextMenu.isOpen && (
				<div
					className="fixed z-50 min-w-[150px] rounded-box border border-base-content/20 bg-base-100 py-2 shadow-lg"
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
						<span>📋</span>
						<span>복사</span>
					</button>

					<button
						type="button"
						className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200"
						onClick={() => handleMenuItemClick("move")}
					>
						<span>✂️</span>
						<span>이동</span>
					</button>

					<button
						type="button"
						className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-base-200"
						onClick={() => handleMenuItemClick("keep")}
					>
						<span>💾</span>
						<span>보관</span>
					</button>
				</div>
			)}
		</div>
	);
};
