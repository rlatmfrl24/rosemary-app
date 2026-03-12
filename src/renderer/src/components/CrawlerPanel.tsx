import { useCallback, useEffect, useRef, useState } from "react";
import {
	CRAWLER_TARGET_URL,
	type CrawlerStatusSnapshot,
	type CrawlItem,
	DEFAULT_CRAWL_MAX_PAGES,
} from "../../../shared/crawler";

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

const copyTextToClipboard = async (text: string): Promise<void> => {
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
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
	const hydratedRef = useRef(false);

	const syncStatus = useCallback(async () => {
		const nextStatus = await window.api.crawler.getStatus();
		setStatus(nextStatus);

		if (!hydratedRef.current) {
			setMaxPagesInput(String(nextStatus.maxPages || DEFAULT_CRAWL_MAX_PAGES));
			hydratedRef.current = true;
		}

		if (!nextStatus.runId) {
			setRecentItems([]);
			return nextStatus;
		}

		const items = await window.api.crawler.getRecentItems({
			runId: nextStatus.runId,
			limit: getRecentItemsLimit(nextStatus),
		});
		setRecentItems(items);
		return nextStatus;
	}, []);

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
					const items = await window.api.crawler.getRecentItems({
						runId: nextStatus.runId,
						limit: getRecentItemsLimit(nextStatus),
					});
					if (!cancelled) {
						setRecentItems(items);
					}
				} else if (!cancelled) {
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
	}, []);

	const handleStart = useCallback(async (): Promise<void> => {
		try {
			const parsedMaxPages = Number.parseInt(maxPagesInput, 10);
			if (!Number.isInteger(parsedMaxPages) || parsedMaxPages < 1) {
				alert("최대 페이지 수는 1 이상의 정수여야 합니다.");
				return;
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
			setRecentItems(items);
		} catch (error) {
			console.error("크롤링 시작 실패:", error);
			alert(
				`크롤링을 시작하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsStarting(false);
		}
	}, [maxPagesInput]);

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

	const isRunning = status.status === "running";

	return (
		<div className="flex flex-1 flex-col gap-4 overflow-hidden">
			<div className="card bg-base-100 shadow-lg flex-shrink-0">
				<div className="card-body p-4 gap-4">
					<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
						<div className="flex flex-col gap-2">
							<div className="flex items-center gap-3">
								<h2 className="card-title text-xl">
									<span>🕷️</span>
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
									className="btn btn-primary"
									disabled={isLoading || isRunning || isStarting}
									onClick={() => void handleStart()}
								>
									{isStarting ? (
										<>
											<span className="loading loading-spinner loading-sm" />
											시작 중...
										</>
									) : (
										<>
											<span>▶</span>
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
											<span>■</span>
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
							<div className="stat-value text-primary text-2xl">
								{status.pagesVisited}
							</div>
							<div className="stat-desc text-xs">
								최대 {status.maxPages}페이지
							</div>
						</div>
						<div className="stat bg-base-200 rounded-box p-4">
							<div className="stat-title text-xs">신규 수집</div>
							<div className="stat-value text-success text-2xl">
								{status.newItems}
							</div>
							<div className="stat-desc text-xs">
								중복 {status.duplicateItems}건
							</div>
						</div>
						<div className="stat bg-base-200 rounded-box p-4">
							<div className="stat-title text-xs">유효 아이템</div>
							<div className="stat-value text-secondary text-2xl">
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
							<span className="text-xl">🧾</span>
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
										<span>📋</span>
										신규 항목 복사
									</>
								)}
							</button>
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
