import { useCallback, useEffect, useState } from "react";
import {
	CRAWLER_TARGET_URL,
	type CrawlDatabaseSummary,
	type CrawlerStatusSnapshot,
	type CrawlItem,
	type CrawlItemMutationInput,
} from "../../../shared/crawler";

interface FormState {
	code: string;
	type: string;
	name: string;
	link: string;
	sourceCursor: string;
	discoveredAt: string;
}

const toDateTimeLocalValue = (value: string): string => {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return "";
	}

	const offsetDate = new Date(
		date.getTime() - date.getTimezoneOffset() * 60000,
	);
	return offsetDate.toISOString().slice(0, 16);
};

const createDefaultFormState = (): FormState => ({
	code: "",
	type: "",
	name: "",
	link: "",
	sourceCursor: "",
	discoveredAt: toDateTimeLocalValue(new Date().toISOString()),
});

const EMPTY_SUMMARY: CrawlDatabaseSummary = {
	itemCount: 0,
	runCount: 0,
	typeCount: 0,
	types: [],
	lastDiscoveredAt: null,
	defaultMaxPages: 10,
	lastRunId: null,
};

const EMPTY_STATUS: CrawlerStatusSnapshot = {
	status: "idle",
	phase: "idle",
	runId: null,
	targetUrl: CRAWLER_TARGET_URL,
	maxPages: 10,
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

const toMutationInput = (formState: FormState): CrawlItemMutationInput => ({
	code: formState.code,
	type: formState.type,
	name: formState.name,
	link: formState.link,
	sourceCursor: formState.sourceCursor,
	discoveredAt: formState.discoveredAt
		? new Date(formState.discoveredAt).toISOString()
		: undefined,
});

export const CrawlerDbPanel = (): React.JSX.Element => {
	const [summary, setSummary] = useState<CrawlDatabaseSummary>(EMPTY_SUMMARY);
	const [items, setItems] = useState<CrawlItem[]>([]);
	const [crawlerStatus, setCrawlerStatus] =
		useState<CrawlerStatusSnapshot>(EMPTY_STATUS);
	const [searchQuery, setSearchQuery] = useState("");
	const [typeFilter, setTypeFilter] = useState("");
	const [limit, setLimit] = useState("100");
	const [isLoading, setIsLoading] = useState(true);
	const [isMutating, setIsMutating] = useState(false);
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [editingCode, setEditingCode] = useState<string | null>(null);
	const [formState, setFormState] = useState<FormState>(
		createDefaultFormState(),
	);

	const loadData = useCallback(async () => {
		try {
			setIsLoading(true);
			const [nextSummary, nextItems, nextStatus] = await Promise.all([
				window.api.crawlerDb.getSummary(),
				window.api.crawlerDb.listItems({
					query: searchQuery,
					type: typeFilter,
					limit: Number.parseInt(limit, 10) || 100,
				}),
				window.api.crawler.getStatus(),
			]);
			setSummary(nextSummary);
			setItems(nextItems);
			setCrawlerStatus(nextStatus);
		} catch (error) {
			console.error("크롤링 DB 조회 실패:", error);
			alert(
				`DB 정보를 불러오지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsLoading(false);
		}
	}, [limit, searchQuery, typeFilter]);

	useEffect(() => {
		void loadData();
	}, [loadData]);

	const handleOpenCreate = useCallback(() => {
		setEditingCode(null);
		setFormState(createDefaultFormState());
		setIsModalOpen(true);
	}, []);

	const handleOpenEdit = useCallback((item: CrawlItem) => {
		setEditingCode(item.code);
		setFormState({
			code: item.code,
			type: item.type,
			name: item.name,
			link: item.link,
			sourceCursor: item.sourceCursor ?? "",
			discoveredAt: toDateTimeLocalValue(item.discoveredAt),
		});
		setIsModalOpen(true);
	}, []);

	const handleCloseModal = useCallback(() => {
		setIsModalOpen(false);
		setEditingCode(null);
	}, []);

	const handleSubmit = useCallback(async (): Promise<void> => {
		try {
			setIsMutating(true);
			const input = toMutationInput(formState);
			if (editingCode) {
				await window.api.crawlerDb.updateItem(editingCode, input);
			} else {
				await window.api.crawlerDb.createItem(input);
			}

			handleCloseModal();
			await loadData();
		} catch (error) {
			console.error("크롤링 DB 저장 실패:", error);
			alert(
				`DB 저장에 실패했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsMutating(false);
		}
	}, [editingCode, formState, handleCloseModal, loadData]);

	const handleDelete = useCallback(
		async (code: string): Promise<void> => {
			const confirmed = confirm(
				`코드 ${code} 항목을 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`,
			);
			if (!confirmed) {
				return;
			}

			try {
				setIsMutating(true);
				await window.api.crawlerDb.deleteItem(code);
				await loadData();
			} catch (error) {
				console.error("크롤링 DB 삭제 실패:", error);
				alert(
					`DB 삭제에 실패했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			} finally {
				setIsMutating(false);
			}
		},
		[loadData],
	);

	const handleResetDatabase = useCallback(async (): Promise<void> => {
		const confirmed = confirm(
			"크롤링 DB를 초기화하시겠습니까?\n모든 크롤링 이력과 런 기록이 삭제됩니다.",
		);
		if (!confirmed) {
			return;
		}

		try {
			setIsMutating(true);
			const result = await window.api.crawlerDb.resetDatabase();
			await loadData();
			alert(
				`DB 초기화가 완료되었습니다.\n삭제된 항목: ${result.itemCount}개\n삭제된 런: ${result.runCount}개`,
			);
		} catch (error) {
			console.error("크롤링 DB 초기화 실패:", error);
			alert(
				`DB 초기화에 실패했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsMutating(false);
		}
	}, [loadData]);

	const isReadOnly = crawlerStatus.status === "running";

	return (
		<>
			<div className="flex flex-1 flex-col gap-4 overflow-hidden">
				<div className="card bg-base-100 shadow-lg flex-shrink-0">
					<div className="card-body p-4 gap-4">
						<div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
							<div>
								<h2 className="card-title text-xl">
									<span>🗄️</span>
									크롤링 DB 관리
								</h2>
								<div className="text-sm text-base-content/70">
									`crawl_items` 기준으로 조회, 수동 추가/수정/삭제, 전체
									초기화를 수행합니다.
								</div>
							</div>

							<div className="flex items-center gap-2">
								<div className="badge badge-outline">
									기본 최대 페이지 {summary.defaultMaxPages}
								</div>
								<div className="badge badge-outline">
									최근 런 ID {summary.lastRunId ?? "-"}
								</div>
							</div>
						</div>

						{isReadOnly && (
							<div className="alert alert-warning py-3">
								<span>
									크롤링 실행 중에는 DB 수정과 초기화가 잠깁니다. 조회만
									가능합니다.
								</span>
							</div>
						)}

						<div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
							<div className="stat rounded-box bg-base-200 p-4">
								<div className="stat-title text-xs">총 항목 수</div>
								<div className="stat-value text-primary text-2xl">
									{summary.itemCount}
								</div>
							</div>
							<div className="stat rounded-box bg-base-200 p-4">
								<div className="stat-title text-xs">총 런 수</div>
								<div className="stat-value text-secondary text-2xl">
									{summary.runCount}
								</div>
							</div>
							<div className="stat rounded-box bg-base-200 p-4">
								<div className="stat-title text-xs">유형 수</div>
								<div className="stat-value text-accent text-2xl">
									{summary.typeCount}
								</div>
							</div>
							<div className="stat rounded-box bg-base-200 p-4">
								<div className="stat-title text-xs">마지막 수집 시각</div>
								<div className="stat-value text-lg">
									{formatDateTime(summary.lastDiscoveredAt)}
								</div>
							</div>
						</div>

						<form
							className="flex flex-col gap-3 xl:flex-row xl:items-end"
							onSubmit={(event) => {
								event.preventDefault();
								void loadData();
							}}
						>
							<label className="form-control flex-1">
								<span className="label-text text-sm font-medium mb-1">
									검색
								</span>
								<input
									className="input input-bordered w-full"
									placeholder="코드, 제목, 링크 검색"
									type="text"
									value={searchQuery}
									onChange={(event) => setSearchQuery(event.target.value)}
								/>
							</label>

							<label className="form-control w-full xl:w-48">
								<span className="label-text text-sm font-medium mb-1">
									유형 필터
								</span>
								<select
									className="select select-bordered w-full"
									value={typeFilter}
									onChange={(event) => setTypeFilter(event.target.value)}
								>
									<option value="">전체</option>
									{summary.types.map((type) => (
										<option key={type} value={type}>
											{type}
										</option>
									))}
								</select>
							</label>

							<label className="form-control w-full xl:w-32">
								<span className="label-text text-sm font-medium mb-1">
									조회 개수
								</span>
								<select
									className="select select-bordered w-full"
									value={limit}
									onChange={(event) => setLimit(event.target.value)}
								>
									<option value="50">50</option>
									<option value="100">100</option>
									<option value="200">200</option>
									<option value="500">500</option>
								</select>
							</label>

							<div className="flex flex-wrap gap-2">
								<button
									type="submit"
									className="btn btn-outline"
									disabled={isLoading}
								>
									조회
								</button>
								<button
									type="button"
									className="btn btn-primary"
									disabled={isMutating || isReadOnly}
									onClick={handleOpenCreate}
								>
									신규 추가
								</button>
								<button
									type="button"
									className="btn btn-error btn-outline"
									disabled={isMutating || isReadOnly}
									onClick={() => void handleResetDatabase()}
								>
									DB 초기화
								</button>
							</div>
						</form>
					</div>
				</div>

				<div className="card bg-base-100 shadow-lg flex-auto h-0 flex flex-col overflow-hidden">
					<div className="card-body p-4 flex flex-col overflow-hidden">
						<div className="flex items-center justify-between mb-4 flex-shrink-0">
							<div className="flex items-center gap-3">
								<span className="text-xl">🗃️</span>
								<span className="text-lg font-semibold">DB 항목 목록</span>
								<div className="badge badge-neutral">{items.length}개</div>
							</div>
							<div className="text-xs text-base-content/60 hidden sm:block">
								조회 조건에 맞는 항목을 스크롤 목록으로 표시합니다.
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
											<th className="w-28">런 ID</th>
											<th className="w-36">커서</th>
											<th className="w-40">수집 시각</th>
											<th className="w-40">작업</th>
										</tr>
									</thead>
									<tbody>
										{items.length === 0 ? (
											<tr>
												<td
													className="py-8 text-center text-base-content/60"
													colSpan={7}
												>
													{isLoading
														? "DB 항목을 불러오는 중입니다."
														: "조건에 맞는 DB 항목이 없습니다."}
												</td>
											</tr>
										) : (
											items.map((item) => (
												<tr key={item.code}>
													<td className="font-mono text-xs">{item.code}</td>
													<td>{item.type}</td>
													<td>
														<div
															className="max-w-xl truncate"
															title={item.name}
														>
															{item.name}
														</div>
														<a
															className="link link-primary text-xs"
															href={item.link}
															rel="noreferrer"
															target="_blank"
														>
															{item.link}
														</a>
													</td>
													<td>{item.createdRunId}</td>
													<td>{item.sourceCursor ?? "-"}</td>
													<td>{formatDateTime(item.discoveredAt)}</td>
													<td>
														<div className="flex gap-2">
															<button
																type="button"
																className="btn btn-xs btn-outline"
																disabled={isMutating || isReadOnly}
																onClick={() => handleOpenEdit(item)}
															>
																수정
															</button>
															<button
																type="button"
																className="btn btn-xs btn-error btn-outline"
																disabled={isMutating || isReadOnly}
																onClick={() => void handleDelete(item.code)}
															>
																삭제
															</button>
														</div>
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

			{isModalOpen && (
				<dialog className="modal modal-open">
					<div className="modal-box w-11/12 max-w-3xl flex flex-col gap-4">
						<h3 className="font-bold text-xl">
							{editingCode ? "DB 항목 수정" : "DB 항목 추가"}
						</h3>

						<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
							<label className="form-control">
								<span className="label-text font-semibold mb-1">코드</span>
								<input
									className="input input-bordered"
									type="text"
									value={formState.code}
									onChange={(event) =>
										setFormState((prev) => ({
											...prev,
											code: event.target.value,
										}))
									}
								/>
							</label>

							<label className="form-control">
								<span className="label-text font-semibold mb-1">유형</span>
								<input
									className="input input-bordered"
									type="text"
									value={formState.type}
									onChange={(event) =>
										setFormState((prev) => ({
											...prev,
											type: event.target.value,
										}))
									}
								/>
							</label>

							<label className="form-control md:col-span-2">
								<span className="label-text font-semibold mb-1">제목</span>
								<input
									className="input input-bordered"
									type="text"
									value={formState.name}
									onChange={(event) =>
										setFormState((prev) => ({
											...prev,
											name: event.target.value,
										}))
									}
								/>
							</label>

							<label className="form-control md:col-span-2">
								<span className="label-text font-semibold mb-1">링크</span>
								<input
									className="input input-bordered"
									type="text"
									value={formState.link}
									onChange={(event) =>
										setFormState((prev) => ({
											...prev,
											link: event.target.value,
										}))
									}
								/>
							</label>

							<label className="form-control">
								<span className="label-text font-semibold mb-1">소스 커서</span>
								<input
									className="input input-bordered"
									type="text"
									value={formState.sourceCursor}
									onChange={(event) =>
										setFormState((prev) => ({
											...prev,
											sourceCursor: event.target.value,
										}))
									}
								/>
							</label>

							<label className="form-control">
								<span className="label-text font-semibold mb-1">수집 시각</span>
								<input
									className="input input-bordered"
									type="datetime-local"
									value={formState.discoveredAt}
									onChange={(event) =>
										setFormState((prev) => ({
											...prev,
											discoveredAt: event.target.value,
										}))
									}
								/>
							</label>
						</div>

						<div className="text-xs text-base-content/60">
							수동 추가한 항목도 크롤링 중복 검사 대상에 포함됩니다.
						</div>

						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								disabled={isMutating}
								onClick={handleCloseModal}
							>
								취소
							</button>
							<button
								type="button"
								className="btn btn-primary"
								disabled={isMutating}
								onClick={() => void handleSubmit()}
							>
								{isMutating ? (
									<>
										<span className="loading loading-spinner loading-sm" />
										저장 중...
									</>
								) : editingCode ? (
									"수정 저장"
								) : (
									"항목 추가"
								)}
							</button>
						</div>
					</div>
				</dialog>
			)}
		</>
	);
};
