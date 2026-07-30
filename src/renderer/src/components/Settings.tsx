import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../../../shared/settings";

interface SettingsProps {
	isOpen: boolean;
	onClose: () => void;
}

export const Settings = ({
	isOpen,
	onClose,
}: SettingsProps): React.JSX.Element | null => {
	const [settings, setSettings] = useState<AppSettings>({
		bandiViewPath: "",
		hitomiDownloaderPath: "",
		hitomiApiEnabled: false,
		hitomiApiAutoSendOnCrawlComplete: false,
		storePath: "",
		keepPath: "",
		favoriteArtistPath: "",
	});
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [isInstallingHitomiApi, setIsInstallingHitomiApi] = useState(false);
	const [isTestingHitomiApi, setIsTestingHitomiApi] = useState(false);

	// 설정 불러오기
	const loadSettings = useCallback(async () => {
		try {
			setIsLoading(true);
			const loadedSettings = await window.api.settings.get();
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
			const success = await window.api.settings.save(settings);
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
	const selectFilePath = useCallback(
		async (
			type:
				| "bandiView"
				| "hitomiDownloader"
				| "store"
				| "keep"
				| "favoriteArtist",
		) => {
			try {
				if (type === "bandiView" || type === "hitomiDownloader") {
					const title =
						type === "bandiView"
							? "BandiView 실행 파일 선택"
							: "Hitomi Downloader 실행 파일 선택";
					const selectedPath =
						await window.api.settings.selectExecutable(title);
					if (selectedPath) {
						setSettings((prev) => ({
							...prev,
							[type === "bandiView" ? "bandiViewPath" : "hitomiDownloaderPath"]:
								selectedPath,
						}));
					}
				} else if (type === "store") {
					// 폴더 선택용 (storePath)
					const selectedPath = await window.api.settings.selectDirectory();
					if (selectedPath) {
						setSettings((prev) => ({
							...prev,
							storePath: selectedPath,
						}));
					}
				} else if (type === "keep") {
					// 폴더 선택용 (keepPath)
					const selectedPath = await window.api.settings.selectDirectory();
					if (selectedPath) {
						setSettings((prev) => ({
							...prev,
							keepPath: selectedPath,
						}));
					}
				} else if (type === "favoriteArtist") {
					// 폴더 선택용 (favoriteArtistPath)
					const selectedPath = await window.api.settings.selectDirectory();
					if (selectedPath) {
						setSettings((prev) => ({
							...prev,
							favoriteArtistPath: selectedPath,
						}));
					}
				}
			} catch (error) {
				console.error("경로 선택 실패:", error);
				const errorMessage =
					type === "bandiView" || type === "hitomiDownloader"
						? "파일 경로 선택 중 오류가 발생했습니다."
						: "폴더 경로 선택 중 오류가 발생했습니다.";
				alert(errorMessage);
			}
		},
		[],
	);

	const installHitomiApiExtension = useCallback(async () => {
		try {
			setIsInstallingHitomiApi(true);
			const savedBeforeInstall = await window.api.settings.save(settings);
			if (!savedBeforeInstall) {
				alert(
					"현재 설정을 저장하지 못해 Hitomi API 확장을 설치할 수 없습니다.",
				);
				return;
			}

			const result = await window.api.settings.installHitomiApiExtension();
			if (!result.success) {
				alert(result.message);
				return;
			}

			alert(`${result.message}\n설치 경로: ${result.installedPath}`);
		} catch (error) {
			console.error("Hitomi API 확장 설치 실패:", error);
			alert(
				`Hitomi API 확장 설치 중 오류가 발생했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsInstallingHitomiApi(false);
		}
	}, [settings]);

	const testHitomiApiConnection = useCallback(async () => {
		try {
			setIsTestingHitomiApi(true);
			const result = await window.api.settings.getHitomiApiStatus();
			alert(result.message);
		} catch (error) {
			console.error("Hitomi API 연결 테스트 실패:", error);
			alert(
				`Hitomi API 연결 테스트 중 오류가 발생했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsTestingHitomiApi(false);
		}
	}, []);

	// 모달이 열릴 때 설정 불러오기
	useEffect(() => {
		if (isOpen) {
			loadSettings();
		}
	}, [isOpen, loadSettings]);

	if (!isOpen) return null;

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
						<div className="form-control">
							<label className="label" htmlFor="hitomiDownloaderPath">
								<span className="label-text font-semibold">
									Hitomi Downloader 실행 파일 경로
								</span>
							</label>
							<div className="flex gap-2">
								<input
									id="hitomiDownloaderPath"
									type="text"
									className="input input-bordered flex-1"
									value={settings.hitomiDownloaderPath}
									onChange={(e) =>
										setSettings((prev) => ({
											...prev,
											hitomiDownloaderPath: e.target.value,
										}))
									}
									placeholder="Hitomi Downloader 실행 파일 경로를 선택하세요"
								/>
								<button
									type="button"
									className="btn btn-outline"
									onClick={() => selectFilePath("hitomiDownloader")}
								>
									실행 파일 선택
								</button>
							</div>
							<div className="label">
								<span className="label-text-alt text-xs">
									신규 파일 정리 탭에서 바로 실행할 Hitomi Downloader 실행
									파일의 경로입니다.
								</span>
							</div>
						</div>

						<div className="rounded-box border border-base-300 p-4">
							<div className="flex flex-col gap-3">
								<div className="flex flex-col gap-1">
									<div className="font-semibold">Hitomi API 연동</div>
									<div className="text-xs text-base-content/60">
										API는 로컬 주소 127.0.0.1:6009만 사용합니다.
									</div>
								</div>
								<div className="flex flex-wrap gap-2">
									<button
										type="button"
										className="btn btn-outline btn-sm"
										disabled={isInstallingHitomiApi}
										onClick={() => void installHitomiApiExtension()}
									>
										{isInstallingHitomiApi ? (
											<>
												<span className="loading loading-spinner loading-xs" />
												설치 중...
											</>
										) : (
											"API 확장 설치/활성화"
										)}
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-sm"
										disabled={isTestingHitomiApi}
										onClick={() => void testHitomiApiConnection()}
									>
										{isTestingHitomiApi ? (
											<>
												<span className="loading loading-spinner loading-xs" />
												확인 중...
											</>
										) : (
											"연결 테스트"
										)}
									</button>
								</div>
								<div className="text-xs text-base-content/60">
									로컬 크롤링은 연결 확인 후 시작되며 신규 항목을 자동으로
									전송합니다.
								</div>
							</div>
						</div>

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

						{/* Favorite 폴더 경로 설정 */}
						<div className="form-control">
							<label className="label" htmlFor="keepPath">
								<span className="label-text font-semibold">
									Favorite 폴더 경로
								</span>
							</label>
							<div className="flex gap-2">
								<input
									id="keepPath"
									type="text"
									className="input input-bordered flex-1"
									value={settings.keepPath}
									onChange={(e) =>
										setSettings((prev) => ({
											...prev,
											keepPath: e.target.value,
										}))
									}
									placeholder="Favorite 폴더 경로를 선택하세요"
								/>
								<button
									type="button"
									className="btn btn-outline w-32"
									onClick={() => selectFilePath("keep")}
								>
									폴더 선택
								</button>
							</div>
							<div className="label">
								<span className="label-text-alt text-xs pl-1">
									선택 파일을 일반 저장소가 아닌 Favorite으로 이동할 때 사용할
									폴더 경로입니다.
								</span>
							</div>
						</div>

						{/* Favorite Artist 폴더 경로 설정 */}
						<div className="form-control">
							<label className="label" htmlFor="favoriteArtistPath">
								<span className="label-text font-semibold">
									Favorite Artist 폴더 경로
								</span>
							</label>
							<div className="flex gap-2">
								<input
									id="favoriteArtistPath"
									type="text"
									className="input input-bordered flex-1"
									value={settings.favoriteArtistPath}
									onChange={(e) =>
										setSettings((prev) => ({
											...prev,
											favoriteArtistPath: e.target.value,
										}))
									}
									placeholder="Favorite Artist 폴더 경로를 선택하세요"
								/>
								<button
									type="button"
									className="btn btn-outline w-32"
									onClick={() => selectFilePath("favoriteArtist")}
								>
									폴더 선택
								</button>
							</div>
							<div className="label">
								<span className="label-text-alt text-xs pl-1">
									신규 파일 작가가 이 폴더의 1단계 하위 작가 폴더와 일치하면
									작가 이동 버튼을 표시합니다.
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
