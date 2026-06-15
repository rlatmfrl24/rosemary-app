import { useCallback, useEffect, useRef, useState } from "react";
import {
	CRAWLER_TARGET_URL,
	type CrawlerStatusSnapshot,
	type CrawlItem,
	DEFAULT_CRAWL_MAX_PAGES,
} from "../../../shared/crawler";
import {
	CopyIcon,
	CrawlerIcon,
	ExternalLinkIcon,
	ListIcon,
	PlayIcon,
	StopIcon,
	TrashIcon,
	UndoIcon,
} from "./Icons";

const EMPTY_STATUS: CrawlerStatusSnapshot = {
	status: "idle",
	phase: "idle",
	runId: null,
	targetUrl: CRAWLER_TARGET_URL,
	maxPages: DEFAULT_CRAWL_MAX_PAGES,
	pagesVisited: 0,
	itemsSeen: 0,
	newItems: 0,
	duplicateItems: 0,
	skippedItems: 0,
	currentCursor: null,
	startedAt: null,
	finishedAt: null,
	lastError: null,
	isStopping: false,
};

const formatDateTime = (value: string | null): string => {
	if (!value) {
		return "-";
	}

	return new Date(value).toLocaleString("ko-KR");
};

const getStatusBadgeClass = (
	status: CrawlerStatusSnapshot["status"],
): string => {
	switch (status) {
		case "running":
			return "badge-primary";
		case "completed":
			return "badge-success";
		case "partial":
			return "badge-warning";
		case "cancelled":
			return "badge-neutral";
		case "failed":
			return "badge-error";
		default:
			return "badge-outline";
	}
};

const getStatusLabel = (status: CrawlerStatusSnapshot["status"]): string => {
	switch (status) {
		case "running":
			return "실행 중";
		case "completed":
			return "완료";
		case "partial":
			return "부분 완료";
		case "cancelled":
			return "중지됨";
		case "failed":
			return "실패";
		default:
			return "대기";
	}
};

const getPhaseLabel = (phase: CrawlerStatusSnapshot["phase"]): string => {
	switch (phase) {
		case "front":
			return "최신 페이지 확인";
		default:
			return "대기";
	}
};

const getRecentItemsLimit = (status: CrawlerStatusSnapshot): number => {
	return Math.max(status.newItems, 1);
};

const DELETED_RECENT_ITEMS_STORAGE_KEY =
	"rosemary:crawler:deleted-recent-items:v1";

interface DeletedRecentItemsSnapshot {
	version: 1;
	runId: number | null;
	items: CrawlItem[];
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> => {
	return typeof value === "object" && value !== null;
};

const isStoredCrawlItem = (value: unknown): value is CrawlItem => {
	return (
		isObjectRecord(value) &&
		typeof value.code === "string" &&
		typeof value.targetUrl === "string" &&
		typeof value.type === "string" &&
		typeof value.name === "string" &&
		typeof value.link === "string" &&
		(value.sourceCursor === null || typeof value.sourceCursor === "string") &&
		typeof value.createdRunId === "number" &&
		typeof value.discoveredAt === "string"
	);
};

const loadDeletedRecentItemsSnapshot =
	(): DeletedRecentItemsSnapshot | null => {
		try {
			const rawValue = window.localStorage.getItem(
				DELETED_RECENT_ITEMS_STORAGE_KEY,
			);
			if (!rawValue) {
				return null;
			}

			const parsedValue: unknown = JSON.parse(rawValue);
			if (
				!isObjectRecord(parsedValue) ||
				parsedValue.version !== 1 ||
				!Array.isArray(parsedValue.items)
			) {
				return null;
			}

			return {
				version: 1,
				runId: typeof parsedValue.runId === "number" ? parsedValue.runId : null,
				items: parsedValue.items.filter(isStoredCrawlItem),
			};
		} catch (error) {
			console.warn("삭제된 크롤링 리스트 상태를 불러오지 못했습니다:", error);
			return null;
		}
	};

const saveDeletedRecentItemsSnapshot = (
	snapshot: DeletedRecentItemsSnapshot,
): void => {
	try {
		window.localStorage.setItem(
			DELETED_RECENT_ITEMS_STORAGE_KEY,
			JSON.stringify(snapshot),
		);
	} catch (error) {
		console.warn("삭제된 크롤링 리스트 상태를 저장하지 못했습니다:", error);
	}
};

const clearDeletedRecentItemsSnapshot = (): void => {
	try {
		window.localStorage.removeItem(DELETED_RECENT_ITEMS_STORAGE_KEY);
	} catch (error) {
		console.warn("삭제된 크롤링 리스트 상태를 삭제하지 못했습니다:", error);
	}
};

const copyTextToClipboard = async (text: string): Promise<void> => {
	const writeWithElectronClipboard = window.api?.clipboard?.writeText;
	if (writeWithElectronClipboard) {
		try {
			await writeWithElectronClipboard(text);
			return;
		} catch (error) {
			console.warn(
				"Electron 클립보드 복사 실패, 브라우저 복사로 재시도:",
				error,
			);
		}
	}

	if (navigator.clipboard?.writeText && document.hasFocus()) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch (error) {
			console.warn("브라우저 클립보드 복사 실패, 대체 복사로 재시도:", error);
		}
	}

	const textArea = document.createElement("textarea");
	textArea.value = text;
	textArea.setAttribute("readonly", "");
	textArea.style.position = "absolute";
	textArea.style.left = "-9999px";
	document.body.append(textArea);
	textArea.select();

	const copied = document.execCommand("copy");
	textArea.remove();

	if (!copied) {
		throw new Error("클립보드 복사에 실패했습니다.");
	}
};

export const CrawlerPanel = (): React.JSX.Element => {
	const [status, setStatus] = useState<CrawlerStatusSnapshot>(EMPTY_STATUS);
	const [recentItems, setRecentItems] = useState<CrawlItem[]>([]);
	const [maxPagesInput, setMaxPagesInput] = useState(
		String(DEFAULT_CRAWL_MAX_PAGES),
	);
	const [isLoading, setIsLoading] = useState(true);
	const [isStarting, setIsStarting] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [isCopyingCodes, setIsCopyingCodes] = useState(false);
	const [deletedRecentItemsSnapshot, setDeletedRecentItemsSnapshot] =
		useState<DeletedRecentItemsSnapshot | null>(() =>
			loadDeletedRecentItemsSnapshot(),
		);
	const [isLaunchingHitomiDownloader, setIsLaunchingHitomiDownloader] =
		useState(false);
	const hydratedRef = useRef(false);
	const clearedRunIdRef = useRef<number | null>(
		deletedRecentItemsSnapshot?.runId ?? null,
	);
	const deletedRecentItemsSnapshotRef =
		useRef<DeletedRecentItemsSnapshot | null>(deletedRecentItemsSnapshot);
	const deletedRecentItems = deletedRecentItemsSnapshot?.items ?? [];

	const applyDeletedRecentItemsSnapshot = useCallback(
		(snapshot: DeletedRecentItemsSnapshot | null): void => {
			deletedRecentItemsSnapshotRef.current = snapshot;
			clearedRunIdRef.current = snapshot?.runId ?? null;
			setDeletedRecentItemsSnapshot(snapshot);

			if (snapshot) {
				saveDeletedRecentItemsSnapshot(snapshot);
				return;
			}

			clearDeletedRecentItemsSnapshot();
		},
		[],
	);

	const syncStatus = useCallback(async () => {
		const nextStatus = await window.api.crawler.getStatus();
		setStatus(nextStatus);

		if (!hydratedRef.current) {
			setMaxPagesInput(String(nextStatus.maxPages || DEFAULT_CRAWL_MAX_PAGES));
			hydratedRef.current = true;
		}

		if (!nextStatus.runId) {
			applyDeletedRecentItemsSnapshot(null);
			setRecentItems([]);
			return nextStatus;
		}

		if (
			deletedRecentItemsSnapshotRef.current &&
			deletedRecentItemsSnapshotRef.current.runId !== nextStatus.runId
		) {
			applyDeletedRecentItemsSnapshot(null);
		}

		const items = await window.api.crawler.getRecentItems({
			runId: nextStatus.runId,
			limit: getRecentItemsLimit(nextStatus),
		});
		setRecentItems(clearedRunIdRef.current === nextStatus.runId ? [] : items);
		return nextStatus;
	}, [applyDeletedRecentItemsSnapshot]);

	useEffect(() => {
		let cancelled = false;

		const poll = async () => {
			try {
				const nextStatus = await window.api.crawler.getStatus();
				if (cancelled) {
					return;
				}

				setStatus(nextStatus);

				if (!hydratedRef.current) {
					setMaxPagesInput(
						String(nextStatus.maxPages || DEFAULT_CRAWL_MAX_PAGES),
					);
					hydratedRef.current = true;
				}

				if (nextStatus.runId) {
					if (
						deletedRecentItemsSnapshotRef.current &&
						deletedRecentItemsSnapshotRef.current.runId !== nextStatus.runId
					) {
						applyDeletedRecentItemsSnapshot(null);
					}

					const items = await window.api.crawler.getRecentItems({
						runId: nextStatus.runId,
						limit: getRecentItemsLimit(nextStatus),
					});
					if (!cancelled) {
						setRecentItems(
							clearedRunIdRef.current === nextStatus.runId ? [] : items,
						);
					}
				} else if (!cancelled) {
					applyDeletedRecentItemsSnapshot(null);
					setRecentItems([]);
				}
			} catch (error) {
				if (!cancelled) {
					console.error("크롤링 상태 동기화 실패:", error);
				}
			} finally {
				if (!cancelled) {
					setIsLoading(false);
				}
			}
		};

		void poll();
		const intervalId = window.setInterval(() => {
			void poll();
		}, 1000);

		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [applyDeletedRecentItemsSnapshot]);

	const handleStart = useCallback(async (): Promise<void> => {
		try {
			const parsedMaxPages = Number.parseInt(maxPagesInput, 10);
			if (!Number.isInteger(parsedMaxPages) || parsedMaxPages < 1) {
				alert("최대 페이지 수는 1 이상의 정수여야 합니다.");
				return;
			}

			if (recentItems.length > 0) {
				const shouldCopyAndReset = confirm(
					`기존 신규 수집 항목 ${recentItems.length}개가 있습니다.\n\n클립보드에 복사하고 리스트를 초기화한 뒤 새 크롤링을 시작할까요?\n\n취소하면 기존 리스트를 유지하고 시작하지 않습니다.`,
				);

				if (!shouldCopyAndReset) {
					return;
				}

				setIsCopyingCodes(true);
				await copyTextToClipboard(
					recentItems.map((item) => item.code).join("\n"),
				);
				applyDeletedRecentItemsSnapshot(null);
				setRecentItems([]);
				setIsCopyingCodes(false);
			}

			setIsStarting(true);
			const nextStatus = await window.api.crawler.start({
				maxPages: parsedMaxPages,
			});
			setStatus(nextStatus);
			setMaxPagesInput(String(parsedMaxPages));
			const items = await window.api.crawler.getRecentItems({
				runId: nextStatus.runId ?? undefined,
				limit: getRecentItemsLimit(nextStatus),
			});
			applyDeletedRecentItemsSnapshot(null);
			setRecentItems(items);
		} catch (error) {
			console.error("크롤링 시작 실패:", error);
			alert(
				`크롤링을 시작하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsCopyingCodes(false);
			setIsStarting(false);
		}
	}, [applyDeletedRecentItemsSnapshot, maxPagesInput, recentItems]);

	const handleStop = useCallback(async (): Promise<void> => {
		try {
			setIsStopping(true);
			const nextStatus = await window.api.crawler.stop();
			setStatus(nextStatus);
			await syncStatus();
		} catch (error) {
			console.error("크롤링 중지 실패:", error);
			alert(
				`크롤링 중지 요청에 실패했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsStopping(false);
		}
	}, [syncStatus]);

	const handleCopyCodes = useCallback(async (): Promise<void> => {
		if (recentItems.length === 0) {
			alert("복사할 신규 항목 코드가 없습니다.");
			return;
		}

		try {
			setIsCopyingCodes(true);
			await copyTextToClipboard(
				recentItems.map((item) => item.code).join("\n"),
			);
			alert(`${recentItems.length}개 코드가 클립보드에 복사되었습니다.`);
		} catch (error) {
			console.error("신규 항목 코드 복사 실패:", error);
			alert(
				`코드 복사에 실패했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsCopyingCodes(false);
		}
	}, [recentItems]);

	const handleDeleteRecentItems = useCallback((): void => {
		if (recentItems.length === 0) {
			alert("삭제할 신규 항목 리스트가 없습니다.");
			return;
		}

		const downloaded = confirm(
			`현재 리스트의 신규 항목 ${recentItems.length}개를 모두 다운로드했습니까?\n\n확인을 누르면 현재 화면의 리스트를 삭제합니다. 삭제 후에는 실행 취소로 복원할 수 있습니다.`,
		);

		if (!downloaded) {
			return;
		}

		applyDeletedRecentItemsSnapshot({
			version: 1,
			runId: status.runId,
			items: recentItems,
		});
		setRecentItems([]);
	}, [applyDeletedRecentItemsSnapshot, recentItems, status.runId]);

	const handleUndoDeleteRecentItems = useCallback((): void => {
		if (!deletedRecentItemsSnapshot) {
			return;
		}

		setRecentItems(deletedRecentItemsSnapshot.items);
		applyDeletedRecentItemsSnapshot(null);
	}, [applyDeletedRecentItemsSnapshot, deletedRecentItemsSnapshot]);

	const handleLaunchHitomiDownloader = useCallback(async (): Promise<void> => {
		try {
			setIsLaunchingHitomiDownloader(true);
			await window.api.settings.launchHitomiDownloader();
		} catch (error) {
			console.error("Hitomi Downloader 실행 중 오류 발생:", error);
			alert(
				`Hitomi Downloader 실행 중 오류가 발생했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsLaunchingHitomiDownloader(false);
		}
	}, []);

	const isRunning = status.status === "running";

	return (
		<div className="flex flex-1 flex-col gap-4 overflow-hidden">
			<div className="card bg-base-100 shadow-lg flex-shrink-0">
				<div className="card-body p-4 gap-4">
					<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
						<div className="flex flex-col gap-2">
							<div className="flex items-center gap-3">
								<h2 className="card-title text-xl">
									<span className="flex h-8 w-8 items-center justify-center rounded-full bg-base-300 text-base-content/80">
										<CrawlerIcon className="h-4 w-4" />
									</span>
									로컬 크롤링
								</h2>
								<div className={`badge ${getStatusBadgeClass(status.status)}`}>
									{getStatusLabel(status.status)}
								</div>
								<div className="badge badge-outline">
									{getPhaseLabel(status.phase)}
								</div>
							</div>
							<a
								className="link link-primary break-all text-sm"
								href={CRAWLER_TARGET_URL}
								rel="noreferrer"
								target="_blank"
							>
								{CRAWLER_TARGET_URL}
							</a>
							<div className="text-xs text-base-content/60">
								랜덤 대기와 로컬 이력 DB를 사용해 신규 코드만 수집합니다.
							</div>
						</div>

						<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
							<label className="form-control w-full sm:w-40">
								<span className="label-text text-sm font-medium mb-1">
									최대 페이지 수
								</span>
								<input
									className="input input-bordered w-full"
									disabled={isRunning || isStarting}
									inputMode="numeric"
									min={1}
									step={1}
									type="number"
									value={maxPagesInput}
									onChange={(event) => setMaxPagesInput(event.target.value)}
								/>
							</label>

							<div className="flex gap-2 sm:self-end">
								<button
									type="button"
									className="btn btn-ghost"
									disabled={isLaunchingHitomiDownloader}
									onClick={() => void handleLaunchHitomiDownloader()}
								>
									{isLaunchingHitomiDownloader ? (
										<>
											<span className="loading loading-spinner loading-sm" />
											실행 중...
										</>
									) : (
										<>
											<ExternalLinkIcon className="h-4 w-4" />
											다운로더 열기
										</>
									)}
								</button>
								<button
									type="button"
									className="btn btn-primary"
									disabled={
										isLoading || isRunning || isStarting || isCopyingCodes
									}
									onClick={() => void handleStart()}
								>
									{isStarting || isCopyingCodes ? (
										<>
											<span className="loading loading-spinner loading-sm" />
											{isCopyingCodes ? "정리 중..." : "시작 중..."}
										</>
									) : (
										<>
											<PlayIcon className="h-4 w-4" />
											크롤링 시작
										</>
									)}
								</button>
								<button
									type="button"
									className="btn btn-outline"
									disabled={!isRunning || isStopping}
									onClick={() => void handleStop()}
								>
									{isStopping || status.isStopping ? (
										<>
											<span className="loading loading-spinner loading-sm" />
											중지 요청...
										</>
									) : (
										<>
											<StopIcon className="h-4 w-4" />
											중지
										</>
									)}
								</button>
							</div>
						</div>
					</div>

					<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
						<div className="stat bg-base-200 rounded-box p-4">
							<div className="stat-title text-xs">방문 페이지</div>
							<div className="stat-value text-2xl text-base-content">
								{status.pagesVisited}
							</div>
							<div className="stat-desc text-xs">
								최대 {status.maxPages}페이지
							</div>
						</div>
						<div className="stat bg-base-200 rounded-box p-4">
							<div className="stat-title text-xs">신규 수집</div>
							<div className="stat-value text-2xl text-primary">
								{status.newItems}
							</div>
							<div className="stat-desc text-xs">
								중복 {status.duplicateItems}건
							</div>
						</div>
						<div className="stat bg-base-200 rounded-box p-4">
							<div className="stat-title text-xs">유효 아이템</div>
							<div className="stat-value text-2xl text-base-content">
								{status.itemsSeen}
							</div>
							<div className="stat-desc text-xs">
								스킵 {status.skippedItems}건
							</div>
						</div>
					</div>

					<div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
						<div className="rounded-box bg-base-200 px-4 py-3 text-sm">
							<div className="font-semibold mb-1">시작 시간</div>
							<div className="text-base-content/70">
								{formatDateTime(status.startedAt)}
							</div>
						</div>
						<div className="rounded-box bg-base-200 px-4 py-3 text-sm">
							<div className="font-semibold mb-1">종료 시간</div>
							<div className="text-base-content/70">
								{formatDateTime(status.finishedAt)}
							</div>
						</div>
						<div className="rounded-box bg-base-200 px-4 py-3 text-sm">
							<div className="font-semibold mb-1">마지막 오류</div>
							<div className="text-base-content/70 break-all">
								{status.lastError ?? "-"}
							</div>
						</div>
					</div>
				</div>
			</div>

			<div className="card bg-base-100 shadow-lg flex-auto h-0 flex flex-col overflow-hidden">
				<div className="card-body p-4 flex flex-col overflow-hidden">
					<div className="flex items-center justify-between mb-4 flex-shrink-0">
						<div className="flex items-center gap-3">
							<span className="flex h-8 w-8 items-center justify-center rounded-full bg-base-300 text-base-content/80">
								<ListIcon className="h-4 w-4" />
							</span>
							<span className="text-lg font-semibold">
								이번 런 신규 수집 항목
							</span>
							<div className="badge badge-neutral">{recentItems.length}개</div>
						</div>
						<div className="flex items-center gap-2">
							<div className="text-xs text-base-content/60 hidden sm:block">
								신규 수집된 항목 전체를 표시합니다.
							</div>
							<button
								type="button"
								className="btn btn-sm btn-outline"
								disabled={recentItems.length === 0 || isCopyingCodes}
								onClick={() => void handleCopyCodes()}
							>
								{isCopyingCodes ? (
									<>
										<span className="loading loading-spinner loading-xs" />
										복사 중...
									</>
								) : (
									<>
										<CopyIcon className="h-4 w-4" />
										신규 항목 복사
									</>
								)}
							</button>
							<button
								type="button"
								className="btn btn-sm btn-outline"
								disabled={recentItems.length === 0}
								onClick={handleDeleteRecentItems}
							>
								<TrashIcon className="h-4 w-4" />
								현재 리스트 삭제
							</button>
							{deletedRecentItems.length > 0 && (
								<button
									type="button"
									className="btn btn-sm btn-ghost"
									onClick={handleUndoDeleteRecentItems}
								>
									<UndoIcon className="h-4 w-4" />
									실행 취소
								</button>
							)}
						</div>
					</div>

					<div className="flex-1 overflow-hidden rounded-box border border-base-content/5">
						<div className="overflow-auto h-full">
							<table className="table table-pin-rows table-xs table-fixed w-full">
								<thead>
									<tr>
										<th className="w-24">코드</th>
										<th className="w-28">유형</th>
										<th>제목</th>
										<th className="w-40">수집 시각</th>
										<th className="w-24">링크</th>
									</tr>
								</thead>
								<tbody>
									{recentItems.length === 0 ? (
										<tr>
											<td
												className="text-center text-base-content/60 py-6"
												colSpan={5}
											>
												{isLoading
													? "크롤링 상태를 불러오는 중입니다."
													: "표시할 신규 수집 항목이 없습니다."}
											</td>
										</tr>
									) : (
										recentItems.map((item) => (
											<tr key={item.code}>
												<td className="font-mono text-xs">{item.code}</td>
												<td>{item.type || "-"}</td>
												<td>
													<div className="truncate" title={item.name}>
														{item.name}
													</div>
												</td>
												<td>{formatDateTime(item.discoveredAt)}</td>
												<td>
													<a
														className="link link-primary"
														href={item.link}
														rel="noreferrer"
														target="_blank"
													>
														열기
													</a>
												</td>
											</tr>
										))
									)}
								</tbody>
							</table>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};
