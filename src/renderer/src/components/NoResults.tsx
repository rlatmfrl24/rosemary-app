export const NoResults = (): React.JSX.Element => {
	return (
		<div className="card bg-base-100 shadow-sm">
			<div className="card-body flex-row items-center gap-3 p-4">
				<div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-info/12 text-info">
					<svg
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						className="h-5 w-5 stroke-current"
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
				</div>
				<div>
					<h3 className="text-sm font-semibold">결과 없음</h3>
					<div className="text-xs text-base-content/65">
						선택한 경로에서 압축파일을 찾지 못했습니다.
					</div>
				</div>
			</div>
		</div>
	);
};
