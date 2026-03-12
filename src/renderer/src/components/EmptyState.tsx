import { RosemaryBrand } from "./RosemaryBrand";

interface EmptyStateProps {
	onSelectPath: () => void;
}

export const EmptyState = ({
	onSelectPath,
}: EmptyStateProps): React.JSX.Element => {
	return (
		<div className="flex-1 flex items-center justify-center">
			<div className="card w-full max-w-md border border-base-300/70 bg-base-100 shadow-sm">
				<div className="card-body items-center gap-4 px-6 py-8 text-center">
					<RosemaryBrand
						align="center"
						eyebrow="File Organizer"
						subtitle="폴더를 선택한 뒤 스캔하면 바로 목록이 채워집니다."
					/>
					<button
						className="btn btn-primary btn-sm"
						onClick={onSelectPath}
						type="button"
					>
						폴더 선택
					</button>
				</div>
			</div>
		</div>
	);
};
