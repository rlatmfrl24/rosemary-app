import { RosemaryBrand } from "./RosemaryBrand";

export const LoadingState = (): React.JSX.Element => {
	return (
		<div className="card bg-base-100 shadow-sm flex-1 flex items-center justify-center overflow-hidden">
			<div className="card-body py-10 text-center">
				<div className="flex flex-col items-center gap-4">
					<RosemaryBrand
						align="center"
						eyebrow="Scanning"
						subtitle="압축 파일과 상대 경로를 읽는 중입니다."
					/>
					<span className="loading loading-dots loading-md text-primary" />
					<div className="text-sm text-base-content/70">
						잠시만 기다려주세요.
					</div>
				</div>
			</div>
		</div>
	);
};
