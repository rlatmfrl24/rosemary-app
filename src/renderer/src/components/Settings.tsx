import { useCallback, useEffect, useState } from "react";

interface SettingsData {
	bandiViewPath: string;
	storePath: string;
}

interface SettingsProps {
	isOpen: boolean;
	onClose: () => void;
}

export const Settings = ({
	isOpen,
	onClose,
}: SettingsProps): React.JSX.Element => {
	const [settings, setSettings] = useState<SettingsData>({
		bandiViewPath: "",
		storePath: "",
	});
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	// 설정 불러오기
	const loadSettings = useCallback(async () => {
		try {
			setIsLoading(true);
			const loadedSettings =
				await window.electron.ipcRenderer.invoke("get-settings");
			setSettings(loadedSettings);
		} catch (error) {
			console.error("설정 불러오기 실패:", error);
			alert("설정을 불러오는 중 오류가 발생했습니다.");
		} finally {
			setIsLoading(false);
		}
	}, []);

	// 설정 저장
	const saveSettings = useCallback(async () => {
		try {
			setIsSaving(true);
			const success = await window.electron.ipcRenderer.invoke(
				"save-settings",
				settings,
			);
			if (success) {
				alert("설정이 저장되었습니다.");
				onClose();
			} else {
				alert("설정 저장에 실패했습니다.");
			}
		} catch (error) {
			console.error("설정 저장 실패:", error);
			alert("설정을 저장하는 중 오류가 발생했습니다.");
		} finally {
			setIsSaving(false);
		}
	}, [settings, onClose]);

	// 파일 경로 선택
	const selectFilePath = useCallback(async (type: "bandiView" | "store") => {
		try {
			if (type === "bandiView") {
				const title = "BandiView 실행 파일 선택";
				const filters = [
					{ name: "실행 파일", extensions: ["exe"] },
					{ name: "모든 파일", extensions: ["*"] },
				];

				const selectedPath = await window.electron.ipcRenderer.invoke(
					"select-file-path",
					title,
					filters,
				);
				if (selectedPath) {
					setSettings((prev) => ({
						...prev,
						bandiViewPath: selectedPath,
					}));
				}
			} else {
				// 폴더 선택용 (storePath)
				const selectedPath =
					await window.electron.ipcRenderer.invoke("get-target-path");
				if (selectedPath) {
					setSettings((prev) => ({
						...prev,
						storePath: selectedPath,
					}));
				}
			}
		} catch (error) {
			console.error("경로 선택 실패:", error);
			const errorMessage =
				type === "bandiView"
					? "파일 경로 선택 중 오류가 발생했습니다."
					: "폴더 경로 선택 중 오류가 발생했습니다.";
			alert(errorMessage);
		}
	}, []);

	// 모달이 열릴 때 설정 불러오기
	useEffect(() => {
		if (isOpen) {
			loadSettings();
		}
	}, [isOpen, loadSettings]);

	if (!isOpen) return <></>;

	return (
		<dialog className="modal modal-open">
			<div className="modal-box w-11/12 max-w-2xl flex flex-col gap-4">
				<h2 className="font-bold text-xl">설정</h2>

				{isLoading ? (
					<div className="flex justify-center items-center p-8">
						<span className="loading loading-spinner loading-lg" />
						<span className="ml-2">설정을 불러오는 중...</span>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{/* BandiView 경로 설정 */}
						<div className="form-control">
							<label className="label" htmlFor="bandiViewPath">
								<span className="label-text font-semibold">
									BandiView 실행 파일 경로
								</span>
							</label>
							<div className="flex gap-2">
								<input
									id="bandiViewPath"
									type="text"
									className="input input-bordered flex-1"
									value={settings.bandiViewPath}
									onChange={(e) =>
										setSettings((prev) => ({
											...prev,
											bandiViewPath: e.target.value,
										}))
									}
									placeholder="BandiView 실행 파일 경로를 선택하세요"
								/>
								<button
									type="button"
									className="btn btn-outline"
									onClick={() => selectFilePath("bandiView")}
								>
									실행 파일 선택
								</button>
							</div>
							<div className="label">
								<span className="label-text-alt text-xs">
									압축 파일을 열어볼 때 사용할 BandiView 실행 파일의 경로입니다.
								</span>
							</div>
						</div>

						{/* 저장소 경로 설정 */}
						<div className="form-control">
							<label className="label" htmlFor="storePath">
								<span className="label-text font-semibold">
									기본 저장소 경로
								</span>
							</label>
							<div className="flex gap-2">
								<input
									id="storePath"
									type="text"
									className="input input-bordered flex-1"
									value={settings.storePath}
									onChange={(e) =>
										setSettings((prev) => ({
											...prev,
											storePath: e.target.value,
										}))
									}
									placeholder="기본 저장소 폴더 경로를 선택하세요"
								/>
								<button
									type="button"
									className="btn btn-outline w-32"
									onClick={() => selectFilePath("store")}
								>
									폴더 선택
								</button>
							</div>
							<div className="label">
								<span className="label-text-alt text-xs pl-1">
									파일을 정리하거나 이동할 때 사용할 기본 폴더 경로입니다.
								</span>
							</div>
						</div>
					</div>
				)}

				<div className="modal-action">
					<button
						type="button"
						className="btn btn-ghost"
						onClick={onClose}
						disabled={isSaving}
					>
						취소
					</button>
					<button
						type="button"
						className="btn btn-primary"
						onClick={saveSettings}
						disabled={isLoading || isSaving}
					>
						{isSaving ? (
							<>
								<span className="loading loading-spinner loading-sm" />
								저장 중...
							</>
						) : (
							"저장"
						)}
					</button>
				</div>
			</div>
		</dialog>
	);
};
