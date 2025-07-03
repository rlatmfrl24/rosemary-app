import { useEffect, useState } from "react";
import { formatFileSize } from "../utils/file";

interface DuplicateFile {
	sourceFile: string;
	sourcePath: string;
	sourceSize: number;
	targetPath: string;
	targetSize: number;
	relativePath: string;
}

interface DuplicateFileHandlerProps {
	duplicates: DuplicateFile[];
	isVisible: boolean;
	onComplete: (actions: Record<string, "overwrite" | "skip">) => void;
	onCancel: () => void;
}

export const DuplicateFileHandler = ({
	duplicates,
	isVisible,
	onComplete,
	onCancel,
}: DuplicateFileHandlerProps): React.JSX.Element => {
	const [showChoiceModal, setShowChoiceModal] = useState(false);
	const [showIndividualModal, setShowIndividualModal] = useState(false);
	const [currentDuplicateIndex, setCurrentDuplicateIndex] = useState(0);
	const [duplicateActions, setDuplicateActions] = useState<
		Record<string, "overwrite" | "skip">
	>({});

	// isVisible이 true가 되면 선택 모달 표시
	useEffect(() => {
		if (isVisible && duplicates.length > 0) {
			setShowChoiceModal(true);
		}
	}, [isVisible, duplicates.length]);

	const handleChoiceSelect = (choice: "1" | "2" | "3") => {
		setShowChoiceModal(false);

		if (choice === "1") {
			// 전부 덮어쓰기
			const actions: Record<string, "overwrite" | "skip"> = {};
			for (const duplicate of duplicates) {
				actions[duplicate.relativePath] = "overwrite";
			}
			onComplete(actions);
		} else if (choice === "2") {
			// 전부 건너뛰기
			const actions: Record<string, "overwrite" | "skip"> = {};
			for (const duplicate of duplicates) {
				actions[duplicate.relativePath] = "skip";
			}
			onComplete(actions);
		} else if (choice === "3") {
			// 개별 확인
			setCurrentDuplicateIndex(0);
			setDuplicateActions({});
			setShowIndividualModal(true);
		}
	};

	const handleIndividualChoice = (action: "overwrite" | "skip") => {
		const currentDuplicate = duplicates[currentDuplicateIndex];
		const newActions = {
			...duplicateActions,
			[currentDuplicate.relativePath]: action,
		};
		setDuplicateActions(newActions);

		if (currentDuplicateIndex < duplicates.length - 1) {
			setCurrentDuplicateIndex(currentDuplicateIndex + 1);
		} else {
			// 모든 개별 확인 완료
			setShowIndividualModal(false);
			onComplete(newActions);
		}
	};

	const handleCancel = () => {
		setShowChoiceModal(false);
		setShowIndividualModal(false);
		setDuplicateActions({});
		setCurrentDuplicateIndex(0);
		onCancel();
	};

	if (!isVisible) return <></>;

	const currentDuplicate = duplicates[currentDuplicateIndex];
	const sourceSize = currentDuplicate
		? formatFileSize(currentDuplicate.sourceSize)
		: "";
	const targetSize =
		currentDuplicate?.targetSize >= 0
			? formatFileSize(currentDuplicate.targetSize)
			: "정보 없음";

	const sizeDiff =
		currentDuplicate?.targetSize >= 0
			? currentDuplicate.sourceSize - currentDuplicate.targetSize
			: 0;

	const sizeDiffText =
		currentDuplicate?.targetSize >= 0
			? sizeDiff > 0
				? ` (+${formatFileSize(sizeDiff)} 더 큼)`
				: sizeDiff < 0
					? ` (${formatFileSize(Math.abs(sizeDiff))} 더 작음)`
					: " (동일한 크기)"
			: "";

	return (
		<>
			{/* 중복 파일 처리 방법 선택 모달 */}
			{showChoiceModal && (
				<dialog className="modal modal-open">
					<div className="modal-box flex flex-col gap-4">
						<h3 className="font-bold text-2xl text-center">
							중복 파일 처리 방법 선택
						</h3>
						<p className="text-center">
							{duplicates.length}개의 중복 파일이 발견되었습니다.
						</p>
						<div className="flex flex-col gap-2">
							<button
								type="button"
								className="btn btn-block btn-outline"
								onClick={() => handleChoiceSelect("1")}
							>
								전부 덮어쓰기
								<div className="text-xs opacity-70">
									기존 파일을 새 파일로 모두 교체
								</div>
							</button>
							<button
								type="button"
								className="btn btn-block btn-outline"
								onClick={() => handleChoiceSelect("2")}
							>
								전부 건너뛰기
								<div className="text-xs opacity-70">
									중복 파일은 모두 이동하지 않음
								</div>
							</button>
							<button
								type="button"
								className="btn btn-block btn-outline"
								onClick={() => handleChoiceSelect("3")}
							>
								개별 확인
								<div className="text-xs opacity-70">각 파일별로 선택</div>
							</button>
						</div>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-block btn-primary"
								onClick={handleCancel}
							>
								취소
							</button>
						</div>
					</div>
				</dialog>
			)}

			{/* 개별 파일 확인 모달 */}
			{showIndividualModal && currentDuplicate && (
				<dialog className="modal modal-open">
					<div className="modal-box max-w-2xl flex flex-col gap-4">
						<h3 className="font-bold text-lg">
							📁 중복 파일 확인 ({currentDuplicateIndex + 1}/{duplicates.length}
							)
						</h3>
						<div className="flex flex-col gap-4">
							<div>
								<strong>파일명:</strong> {currentDuplicate.sourceFile}
							</div>
							<div>
								<strong>경로:</strong> {currentDuplicate.relativePath}
							</div>
							<div className="divider">📊 용량 비교</div>
							<div className="grid grid-cols-2 gap-4">
								<div className="bg-blue-100 p-3 rounded">
									<div className="font-semibold text-blue-800">새 파일</div>
									<div className="text-lg text-blue-800">{sourceSize}</div>
								</div>
								<div className="bg-orange-100 p-3 rounded">
									<div className="font-semibold text-orange-800">기존 파일</div>
									<div className="text-lg text-orange-800">
										{targetSize}
										{sizeDiffText}
									</div>
								</div>
							</div>
						</div>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-warning"
								onClick={() => handleIndividualChoice("overwrite")}
							>
								덮어쓰기
							</button>
							<button
								type="button"
								className="btn btn-neutral"
								onClick={() => handleIndividualChoice("skip")}
							>
								건너뛰기
							</button>
						</div>
					</div>
				</dialog>
			)}
		</>
	);
};
