import type { ScanArchiveProgress } from "../../../shared/file-organizer";
import { RosemaryBrand } from "./RosemaryBrand";

interface LoadingStateProps {
	progress: ScanArchiveProgress | null;
}

const getPhaseLabel = (
	phase: ScanArchiveProgress["phase"] | undefined,
): string => {
	if (phase === "reading") {
		return "파일 정보 읽는 중";
	}

	if (phase === "complete") {
		return "스캔 완료";
	}

	return "압축 파일 찾는 중";
};

export const LoadingState = ({
	progress,
}: LoadingStateProps): React.JSX.Element => {
	const progressValue =
		progress && progress.total > 0
			? Math.min(100, Math.round((progress.processed / progress.total) * 100))
			: 0;
	const currentName =
		progress?.currentFileName || progress?.currentPath || "스캔 준비 중";

	return (
		<div className="card bg-base-100 shadow-sm flex-1 flex items-center justify-center overflow-hidden">
			<div className="card-body w-full max-w-2xl py-10 text-center">
				<div className="flex flex-col items-center gap-4">
					<RosemaryBrand
						align="center"
						eyebrow="Scanning"
						subtitle="압축 파일과 상대 경로를 읽는 중입니다."
					/>
					<div className="w-full space-y-3">
						<div className="flex items-center justify-between gap-3 text-xs text-base-content/60">
							<span>{getPhaseLabel(progress?.phase)}</span>
							<span>{progressValue}%</span>
						</div>
						<progress
							className="progress progress-primary w-full"
							value={progressValue}
							max={100}
						/>
						<div className="flex flex-col gap-1 rounded-box bg-base-200 px-3 py-2 text-left">
							<div className="text-[11px] text-base-content/50">
								현재 처리 중
							</div>
							<div className="truncate font-mono text-xs text-base-content/75">
								{currentName}
							</div>
						</div>
						<div className="flex justify-center gap-2 text-xs text-base-content/60">
							<span>발견 {progress?.foundFiles ?? 0}개</span>
							<span>·</span>
							<span>
								{progress?.processed ?? 0}/{progress?.total ?? 0}
							</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
