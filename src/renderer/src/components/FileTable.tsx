import type React from "react";
import type { RefObject } from "react";
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
}

export const FileTable = ({
	fileList,
	selectedRowIndex,
	selectedPath,
	tableContainerRef,
	onRowClick,
}: FileTableProps): React.JSX.Element => {
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
		<div className="card bg-base-100 shadow-lg flex-auto h-0 flex flex-col overflow-hidden">
			<div className="card-body p-4 flex flex-col overflow-hidden">
				<div className="flex items-center justify-between mb-4 flex-shrink-0">
					<div className="flex items-center gap-3">
						<span className="text-xl">📦</span>
						<span className="text-lg font-semibold">작품 목록</span>
						<div className="badge badge-neutral">{fileList.length}개</div>
					</div>
					<div className="text-xs text-base-content/60 hidden sm:block">
						↑↓ 이동 | Enter BandiView열기 | Del 목록제거 | Shift+Del 파일삭제
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
		</div>
	);
};
