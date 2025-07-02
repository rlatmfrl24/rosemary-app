interface HeaderProps {
	selectedPath: string | null;
	isScanning: boolean;
	onSelectPath: () => void;
	onScanFiles: () => void;
}

export const Header = ({
	selectedPath,
	isScanning,
	onSelectPath,
	onScanFiles,
}: HeaderProps): React.JSX.Element => {
	return (
		<div className="card bg-base-100 shadow-sm rounded-none border-b flex-shrink-0">
			<div className="card-body p-4">
				<div className="flex gap-4 items-center">
					<div className="flex-1">
						<input
							className="input input-bordered w-full"
							type="text"
							value={selectedPath ?? ""}
							placeholder="📁 선택된 폴더 경로가 여기에 표시됩니다"
							readOnly
						/>
					</div>
					<button
						type="button"
						className="btn btn-primary gap-2"
						onClick={onSelectPath}
					>
						<span>📂</span>
						폴더 선택
					</button>
					<button
						type="button"
						className="btn btn-secondary gap-2"
						onClick={onScanFiles}
						disabled={!selectedPath || isScanning}
					>
						{isScanning ? (
							<>
								<span className="loading loading-spinner loading-sm" />
								스캔 중...
							</>
						) : (
							<>
								<span>🔍</span>
								스캔 시작
							</>
						)}
					</button>
				</div>
			</div>
		</div>
	);
};
