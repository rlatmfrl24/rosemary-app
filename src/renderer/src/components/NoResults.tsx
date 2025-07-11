export const NoResults = (): React.JSX.Element => {
	return (
		<div className="alert alert-info shadow-lg">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				fill="none"
				viewBox="0 0 24 24"
				className="stroke-current shrink-0 w-6 h-6"
				aria-label="정보 아이콘"
			>
				<title>정보 아이콘</title>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="2"
					d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
				/>
			</svg>
			<div>
				<h3 className="font-bold">압축파일을 찾을 수 없습니다</h3>
				<div className="text-xs">
					해당 경로에서 압축파일을 찾을 수 없습니다.
				</div>
			</div>
		</div>
	);
};
