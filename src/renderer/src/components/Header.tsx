interface HeaderProps {
	selectedPath: string | null;
	isScanning: boolean;
	isLaunchingHitomiDownloader: boolean;
	onSelectPath: () => void;
	onScanFiles: () => void;
	onLaunchHitomiDownloader: () => void;
}

export const Header = ({
	selectedPath,
	isScanning,
	isLaunchingHitomiDownloader,
	onSelectPath,
	onScanFiles,
	onLaunchHitomiDownloader,
}: HeaderProps): React.JSX.Element => {
	return (
		<div className="card bg-base-100 shadow-sm flex-shrink-0">
			<div className="card-body gap-3 p-3">
				<div className="flex flex-col gap-3 xl:flex-row xl:items-end">
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
					<div className="flex flex-wrap gap-2 xl:justify-end">
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
						<button
							type="button"
							className="btn btn-sm btn-ghost"
							onClick={onLaunchHitomiDownloader}
							disabled={isLaunchingHitomiDownloader}
						>
							{isLaunchingHitomiDownloader ? (
								<>
									<span className="loading loading-spinner loading-xs" />
									실행 중
								</>
							) : (
								"다운로더"
							)}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
};
