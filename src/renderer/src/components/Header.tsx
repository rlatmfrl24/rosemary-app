interface HeaderProps {
	selectedPath: string | null;
	isScanning: boolean;
	thumbnailEnabled: boolean;
	onSelectPath: () => void;
	onScanFiles: () => void;
	onThumbnailEnabledChange: (enabled: boolean) => void;
}

export const Header = ({
	selectedPath,
	isScanning,
	thumbnailEnabled,
	onSelectPath,
	onScanFiles,
	onThumbnailEnabledChange,
}: HeaderProps): React.JSX.Element => {
	return (
		<div className="card bg-base-100 shadow-sm flex-shrink-0">
			<div className="card-body gap-3 p-3">
				<div className="flex flex-col gap-3 lg:flex-row lg:items-end">
					<div className="min-w-0 flex-1">
						<div className="mb-1 flex items-center gap-2 text-[11px] text-base-content/55">
							<span className="badge badge-ghost badge-sm">스캔 경로</span>
							<span>{selectedPath ? "선택됨" : "선택 필요"}</span>
						</div>
						<input
							className="input input-sm input-bordered w-full font-mono text-xs"
							type="text"
							value={selectedPath ?? ""}
							placeholder="폴더를 선택하세요"
							readOnly
						/>
					</div>
					<div className="flex flex-wrap gap-2 lg:justify-end">
						<button
							type="button"
							className="btn btn-sm btn-outline"
							onClick={onSelectPath}
						>
							폴더 선택
						</button>
						<button
							type="button"
							className="btn btn-sm btn-primary"
							onClick={onScanFiles}
							disabled={!selectedPath || isScanning}
						>
							{isScanning ? (
								<>
									<span className="loading loading-spinner loading-xs" />
									스캔 중
								</>
							) : (
								"스캔"
							)}
						</button>
						<label className="flex h-8 cursor-pointer items-center gap-2 rounded-btn border border-base-300 bg-base-100 px-3">
							<span className="text-xs font-semibold text-base-content/70">
								썸네일
							</span>
							<input
								type="checkbox"
								className="toggle toggle-primary toggle-sm"
								checked={thumbnailEnabled}
								disabled={isScanning}
								aria-label="썸네일 스캔 사용"
								onChange={(event) =>
									onThumbnailEnabledChange(event.target.checked)
								}
							/>
						</label>
					</div>
				</div>
			</div>
		</div>
	);
};
