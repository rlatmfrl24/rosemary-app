import { useCallback, useEffect, useState } from "react";
import {
	type ArchiveMetadataRecoveryFailure,
	type ArchiveMetadataRecoveryFolderPreview,
	type ArchiveMetadataRecoveryPhase,
	type ArchiveMetadataRecoverySnapshot,
	type ArchiveMetadataRecoveryStatus,
	CRAWLER_TARGET_URL,
	type CrawlDatabaseSummary,
	type CrawlerStatusSnapshot,
	type CrawlItem,
	type CrawlItemMutationInput,
	type MetadataBackfillFailure,
	type MetadataBackfillSnapshot,
	type MetadataBackfillStatus,
} from "../../../shared/crawler";
import { DatabaseIcon, ListIcon } from "./Icons";

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
	metadataCount: 0,
	metadataMissingCount: 0,
	metadataInvalidLinkCount: 0,
	archiveIndexedCount: 0,
	archiveOfficialMetadataCount: 0,
	archiveCatalogMetadataCount: 0,
	archiveMetadataMissingCount: 0,
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
	metadataRequested: 0,
	metadataUpdated: 0,
	metadataFailed: 0,
	currentCursor: null,
	startedAt: null,
	finishedAt: null,
	lastError: null,
	isStopping: false,
};

const EMPTY_BACKFILL_STATUS: MetadataBackfillSnapshot = {
	jobId: null,
	status: "idle",
	totalCount: 0,
	processedCount: 0,
	updatedCount: 0,
	failedCount: 0,
	retryCount: 0,
	remainingCount: 0,
	alreadyPresentCount: 0,
	invalidLinkCount: 0,
	startedAt: null,
	updatedAt: null,
	finishedAt: null,
	lastError: null,
	isPausing: false,
};

const EMPTY_ARCHIVE_RECOVERY_STATUS: ArchiveMetadataRecoverySnapshot = {
	jobId: null,
	status: "idle",
	phase: "idle",
	scope: null,
	scopePath: null,
	totalCount: 0,
	processedCount: 0,
	officialCount: 0,
	catalogCount: 0,
	unresolvedCount: 0,
	failedCount: 0,
	expungedCount: 0,
	accessDeniedCount: 0,
	tokenNotFoundCount: 0,
	retryCount: 0,
	priorityCount: 0,
	remainingCount: 0,
	startedAt: null,
	updatedAt: null,
	finishedAt: null,
	lastError: null,
	isPausing: false,
};

const getBackfillStatusLabel = (
	status: MetadataBackfillStatus | ArchiveMetadataRecoveryStatus,
): string => {
	if (status === "running") return "실행 중";
	if (status === "paused") return "일시 중단";
	if (status === "completed") return "완료";
	if (status === "completed_with_errors") return "오류 포함 완료";
	return "대기";
};

const getBackfillStatusClassName = (
	status: MetadataBackfillStatus | ArchiveMetadataRecoveryStatus,
): string => {
	if (status === "running") return "badge-info";
	if (status === "paused") return "badge-warning";
	if (status === "completed") return "badge-success";
	if (status === "completed_with_errors") return "badge-error";
	return "badge-ghost";
};

const getArchiveRecoveryPhaseLabel = (
	phase: ArchiveMetadataRecoveryPhase,
): string => {
	if (phase === "indexing") return "보관 인덱스 갱신";
	if (phase === "catalog") return "Hitomi 카탈로그";
	if (phase === "search") return "gallery token 검색";
	if (phase === "metadata") return "공식 API 승격";
	return "대기";
};

const getArchiveRecoveryScopeLabel = (
	scope: ArchiveMetadataRecoverySnapshot["scope"],
): string => {
	if (scope === "file") return "파일 우선 큐";
	if (scope === "folder") return "선택 폴더";
	if (scope === "retry") return "미복구 재시도";
	if (scope === "legacy-full") return "기존 전체 복구";
	return "선택 대기";
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
	const [backfillStatus, setBackfillStatus] =
		useState<MetadataBackfillSnapshot>(EMPTY_BACKFILL_STATUS);
	const [backfillFailures, setBackfillFailures] = useState<
		MetadataBackfillFailure[]
	>([]);
	const [archiveRecoveryStatus, setArchiveRecoveryStatus] =
		useState<ArchiveMetadataRecoverySnapshot>(EMPTY_ARCHIVE_RECOVERY_STATUS);
	const [archiveRecoveryFailures, setArchiveRecoveryFailures] = useState<
		ArchiveMetadataRecoveryFailure[]
	>([]);
	const [searchQuery, setSearchQuery] = useState("");
	const [typeFilter, setTypeFilter] = useState("");
	const [limit, setLimit] = useState("100");
	const [isLoading, setIsLoading] = useState(true);
	const [isMutating, setIsMutating] = useState(false);
	const [isBackfillMutating, setIsBackfillMutating] = useState(false);
	const [isArchiveRecoveryMutating, setIsArchiveRecoveryMutating] =
		useState(false);
	const [archiveFolderPreview, setArchiveFolderPreview] =
		useState<ArchiveMetadataRecoveryFolderPreview | null>(null);
	const [isModalOpen, setIsModalOpen] = useState(false);
	const [editingCode, setEditingCode] = useState<string | null>(null);
	const [formState, setFormState] = useState<FormState>(
		createDefaultFormState(),
	);

	const loadData = useCallback(async () => {
		try {
			setIsLoading(true);
			const [
				nextSummary,
				nextItems,
				nextStatus,
				nextBackfillStatus,
				nextBackfillFailures,
				nextArchiveRecoveryStatus,
				nextArchiveRecoveryFailures,
			] = await Promise.all([
				window.api.crawlerDb.getSummary(),
				window.api.crawlerDb.listItems({
					query: searchQuery,
					type: typeFilter,
					limit: Number.parseInt(limit, 10) || 100,
				}),
				window.api.crawler.getStatus(),
				window.api.crawlerDb.getMetadataBackfillStatus(),
				window.api.crawlerDb.listMetadataBackfillFailures(50),
				window.api.crawlerDb.getArchiveMetadataRecoveryStatus(),
				window.api.crawlerDb.listArchiveMetadataRecoveryFailures(50),
			]);
			setSummary(nextSummary);
			setItems(nextItems);
			setCrawlerStatus(nextStatus);
			setBackfillStatus(nextBackfillStatus);
			setBackfillFailures(nextBackfillFailures);
			setArchiveRecoveryStatus(nextArchiveRecoveryStatus);
			setArchiveRecoveryFailures(nextArchiveRecoveryFailures);
		} catch (error) {
			console.error("크롤링 DB 조회 실패:", error);
			alert(
				`DB 정보를 불러오지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsLoading(false);
		}
	}, [limit, searchQuery, typeFilter]);

	const loadBackfillData = useCallback(async (): Promise<void> => {
		const [
			nextSummary,
			nextStatus,
			nextFailures,
			nextArchiveStatus,
			nextArchiveFailures,
		] = await Promise.all([
			window.api.crawlerDb.getSummary(),
			window.api.crawlerDb.getMetadataBackfillStatus(),
			window.api.crawlerDb.listMetadataBackfillFailures(50),
			window.api.crawlerDb.getArchiveMetadataRecoveryStatus(),
			window.api.crawlerDb.listArchiveMetadataRecoveryFailures(50),
		]);
		setSummary(nextSummary);
		setBackfillStatus(nextStatus);
		setBackfillFailures(nextFailures);
		setArchiveRecoveryStatus(nextArchiveStatus);
		setArchiveRecoveryFailures(nextArchiveFailures);
	}, []);

	useEffect(() => {
		void loadData();
	}, [loadData]);

	useEffect(() => {
		if (
			backfillStatus.status !== "running" &&
			archiveRecoveryStatus.status !== "running"
		) {
			return;
		}

		const intervalId = window.setInterval(() => {
			void loadBackfillData().catch((error) => {
				console.error("메타데이터 백필 상태 조회 실패:", error);
			});
		}, 1000);

		return () => window.clearInterval(intervalId);
	}, [archiveRecoveryStatus.status, backfillStatus.status, loadBackfillData]);

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
			"크롤링 DB를 초기화하시겠습니까?\n모든 크롤링 이력, 원천 메타데이터, 백필·보관분 복구 기록이 삭제됩니다.",
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

	const handleBackfillAction = useCallback(
		async (action: "start" | "pause" | "resume" | "retry"): Promise<void> => {
			if (action === "start") {
				const confirmed = confirm(
					`원천 메타데이터 백필을 시작하시겠습니까?\n수집 가능 누락 항목: ${summary.metadataMissingCount}개\n이미 수집된 항목은 다시 요청하지 않습니다.`,
				);
				if (!confirmed) return;
			}
			if (action === "retry") {
				const confirmed = confirm(
					`실패하거나 아직 누락된 ${summary.metadataMissingCount}개 항목으로 새 백필 작업을 시작하시겠습니까?`,
				);
				if (!confirmed) return;
			}

			try {
				setIsBackfillMutating(true);
				let nextStatus: MetadataBackfillSnapshot;
				if (action === "start") {
					nextStatus = await window.api.crawlerDb.startMetadataBackfill();
				} else if (action === "pause") {
					nextStatus = await window.api.crawlerDb.pauseMetadataBackfill();
				} else if (action === "resume") {
					nextStatus = await window.api.crawlerDb.resumeMetadataBackfill();
				} else {
					nextStatus =
						await window.api.crawlerDb.retryMetadataBackfillFailures();
				}
				setBackfillStatus(nextStatus);
				await loadBackfillData();
			} catch (error) {
				console.error("메타데이터 백필 작업 실패:", error);
				alert(
					`메타데이터 백필 작업을 처리하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			} finally {
				setIsBackfillMutating(false);
			}
		},
		[loadBackfillData, summary.metadataMissingCount],
	);

	const handleArchiveRecoveryAction = useCallback(
		async (action: "start" | "pause" | "resume" | "retry"): Promise<void> => {
			let selectedPreview: ArchiveMetadataRecoveryFolderPreview | null = null;
			try {
				if (action === "start") {
					const folderPath = await window.api.settings.selectDirectory();
					if (!folderPath) return;
					selectedPreview =
						await window.api.crawlerDb.previewArchiveMetadataRecoveryFolder(
							folderPath,
						);
					setArchiveFolderPreview(selectedPreview);
					const largeQueueWarning =
						selectedPreview.requiresLargeQueueConfirmation
							? "\n\n주의: 1,000개 이상의 저속 원격 요청 대상입니다."
							: "";
					const confirmed = confirm(
						`선택 폴더의 원천 정보 보강을 시작하시겠습니까?\n\n파일 ${selectedPreview.fileCount}개 · gallery id ${selectedPreview.galleryCount}개\n보강 대상 ${selectedPreview.eligibleCount}개 · 공식 보유 ${selectedPreview.officialCount}개\n카탈로그 전용 ${selectedPreview.catalogOnlyCount}개 · token 보유 ${selectedPreview.knownTokenCount}개\n검색 필요 ${selectedPreview.searchRequiredCount}개${largeQueueWarning}`,
					);
					if (!confirmed) return;
				}
				if (action === "retry") {
					const confirmed = confirm(
						"최근 선택 작업의 token 미복구·접근 불가·실패 항목만 새 작업으로 다시 시도하시겠습니까?",
					);
					if (!confirmed) return;
				}
				setIsArchiveRecoveryMutating(true);
				let nextStatus: ArchiveMetadataRecoverySnapshot;
				if (action === "start") {
					if (!selectedPreview) return;
					nextStatus = await window.api.crawlerDb.startArchiveMetadataRecovery({
						scope: "folder",
						folderPath: selectedPreview.folderPath,
					});
				} else if (action === "pause") {
					nextStatus =
						await window.api.crawlerDb.pauseArchiveMetadataRecovery();
				} else if (action === "resume") {
					nextStatus =
						await window.api.crawlerDb.resumeArchiveMetadataRecovery();
				} else {
					nextStatus =
						await window.api.crawlerDb.retryArchiveMetadataRecoveryUnresolved();
				}
				setArchiveRecoveryStatus(nextStatus);
				await loadBackfillData();
			} catch (error) {
				console.error("보관분 메타데이터 복구 실패:", error);
				alert(
					`보관분 메타데이터 복구 작업을 처리하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			} finally {
				setIsArchiveRecoveryMutating(false);
			}
		},
		[loadBackfillData],
	);

	const isBackfillRunning = backfillStatus.status === "running";
	const isArchiveRecoveryRunning = archiveRecoveryStatus.status === "running";
	const isReadOnly =
		crawlerStatus.status === "running" ||
		isBackfillRunning ||
		isArchiveRecoveryRunning;
	const backfillProgress =
		backfillStatus.totalCount > 0
			? Math.round(
					(backfillStatus.processedCount / backfillStatus.totalCount) * 100,
				)
			: backfillStatus.status === "completed"
				? 100
				: 0;
	const archiveRecoveryProgress =
		archiveRecoveryStatus.totalCount > 0
			? Math.round(
					(archiveRecoveryStatus.processedCount /
						archiveRecoveryStatus.totalCount) *
						100,
				)
			: archiveRecoveryStatus.status === "completed"
				? 100
				: 0;

	return (
		<>
			<div className="flex flex-1 flex-col gap-4 overflow-hidden">
				<div className="card max-h-[60vh] flex-shrink-0 overflow-auto bg-base-100 shadow-lg">
					<div className="card-body p-4 gap-4">
						<div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
							<div>
								<h2 className="card-title text-xl">
									<span className="flex h-8 w-8 items-center justify-center rounded-full bg-base-300 text-base-content/80">
										<DatabaseIcon className="h-4 w-4" />
									</span>
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
									크롤링 또는 메타데이터 작업 실행 중에는 DB 수정과 초기화가
									잠깁니다. 조회만 가능합니다.
								</span>
							</div>
						)}

						<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
							<div className="stat rounded-box bg-base-200 p-4">
								<div className="stat-title text-xs">총 항목 수</div>
								<div className="stat-value text-2xl text-base-content">
									{summary.itemCount}
								</div>
							</div>
							<div className="stat rounded-box bg-base-200 p-4">
								<div className="stat-title text-xs">총 런 수</div>
								<div className="stat-value text-2xl text-base-content">
									{summary.runCount}
								</div>
							</div>
							<div className="stat rounded-box bg-base-200 p-4">
								<div className="stat-title text-xs">유형 수</div>
								<div className="stat-value text-2xl text-base-content">
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

						<section className="rounded-box border border-info/25 bg-info/5 p-4">
							<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
								<div>
									<div className="flex flex-wrap items-center gap-2">
										<h3 className="font-semibold">원천 메타데이터 백필</h3>
										<span
											className={`badge badge-sm ${getBackfillStatusClassName(backfillStatus.status)}`}
										>
											{backfillStatus.isPausing
												? "중단 중"
												: getBackfillStatusLabel(backfillStatus.status)}
										</span>
										{backfillStatus.jobId && (
											<span className="badge badge-ghost badge-sm">
												작업 #{backfillStatus.jobId}
											</span>
										)}
									</div>
									<p className="mt-1 text-xs text-base-content/60">
										token이 있는 기존 크롤링 항목 중 메타데이터가 없는 항목만
										수집합니다.
									</p>
								</div>

								<div className="flex flex-wrap gap-2">
									{isBackfillRunning ? (
										<button
											type="button"
											className="btn btn-warning btn-sm"
											disabled={isBackfillMutating || backfillStatus.isPausing}
											onClick={() => void handleBackfillAction("pause")}
										>
											{backfillStatus.isPausing ? "중단 중..." : "일시 중단"}
										</button>
									) : backfillStatus.status === "paused" ? (
										<button
											type="button"
											className="btn btn-primary btn-sm"
											disabled={
												isBackfillMutating ||
												crawlerStatus.status === "running" ||
												isArchiveRecoveryRunning
											}
											onClick={() => void handleBackfillAction("resume")}
										>
											재개
										</button>
									) : backfillStatus.status === "completed_with_errors" ? (
										<button
											type="button"
											className="btn btn-error btn-outline btn-sm"
											disabled={
												isBackfillMutating ||
												crawlerStatus.status === "running" ||
												isArchiveRecoveryRunning ||
												summary.metadataMissingCount === 0
											}
											onClick={() => void handleBackfillAction("retry")}
										>
											실패 항목 재시도
										</button>
									) : (
										<button
											type="button"
											className="btn btn-primary btn-sm"
											disabled={
												isBackfillMutating ||
												crawlerStatus.status === "running" ||
												isArchiveRecoveryRunning ||
												summary.metadataMissingCount === 0
											}
											onClick={() => void handleBackfillAction("start")}
										>
											백필 시작
										</button>
									)}
								</div>
							</div>

							<div className="mt-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
								<div className="rounded bg-base-100/70 p-3">
									<div className="text-base-content/55">저장 완료</div>
									<div className="mt-1 text-lg font-semibold text-success">
										{summary.metadataCount}
									</div>
								</div>
								<div className="rounded bg-base-100/70 p-3">
									<div className="text-base-content/55">수집 가능 누락</div>
									<div className="mt-1 text-lg font-semibold text-info">
										{summary.metadataMissingCount}
									</div>
								</div>
								<div className="rounded bg-base-100/70 p-3">
									<div className="text-base-content/55">token 없는 항목</div>
									<div className="mt-1 text-lg font-semibold">
										{summary.metadataInvalidLinkCount}
									</div>
								</div>
								<div className="rounded bg-base-100/70 p-3">
									<div className="text-base-content/55">최근 작업 실패</div>
									<div className="mt-1 text-lg font-semibold text-error">
										{backfillStatus.failedCount}
									</div>
								</div>
								<div className="rounded bg-base-100/70 p-3">
									<div className="text-base-content/55">HTTP 재시도</div>
									<div className="mt-1 text-lg font-semibold text-warning">
										{backfillStatus.retryCount}
									</div>
								</div>
							</div>

							{backfillStatus.jobId && (
								<div className="mt-4 space-y-2">
									<div className="flex items-center justify-between text-xs">
										<span>
											처리 {backfillStatus.processedCount}/
											{backfillStatus.totalCount} · 성공{" "}
											{backfillStatus.updatedCount}· 실패{" "}
											{backfillStatus.failedCount} · 남음{" "}
											{backfillStatus.remainingCount} · HTTP 재시도{" "}
											{backfillStatus.retryCount}
										</span>
										<span className="font-semibold">{backfillProgress}%</span>
									</div>
									<progress
										className="progress progress-info w-full"
										value={backfillProgress}
										max={100}
									/>
									<div className="text-[11px] text-base-content/50">
										시작 {formatDateTime(backfillStatus.startedAt)} · 갱신{" "}
										{formatDateTime(backfillStatus.updatedAt)}
									</div>
								</div>
							)}

							{backfillStatus.lastError && (
								<div className="mt-3 rounded bg-error/10 p-3 text-xs text-error">
									{backfillStatus.lastError}
								</div>
							)}

							{backfillFailures.length > 0 && (
								<div className="mt-3 max-h-32 overflow-auto rounded border border-error/20 bg-base-100/70">
									{backfillFailures.map((failure) => (
										<div
											key={failure.galleryId}
											className="flex gap-3 border-b border-base-content/5 px-3 py-2 text-xs last:border-b-0"
										>
											<span className="font-mono font-semibold">
												{failure.galleryId}
											</span>
											<span className="min-w-0 flex-1 break-words text-error">
												{failure.error}
											</span>
											<span className="text-base-content/45">
												{failure.attemptCount}회
											</span>
										</div>
									))}
								</div>
							)}
						</section>

						<section className="rounded-box border border-success/25 bg-success/5 p-4">
							<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
								<div>
									<div className="flex flex-wrap items-center gap-2">
										<h3 className="font-semibold">보관분 메타데이터 복구</h3>
										<span
											className={`badge badge-sm ${getBackfillStatusClassName(archiveRecoveryStatus.status)}`}
										>
											{archiveRecoveryStatus.isPausing
												? "중단 중"
												: getBackfillStatusLabel(archiveRecoveryStatus.status)}
										</span>
										{archiveRecoveryStatus.jobId && (
											<span className="badge badge-ghost badge-sm">
												작업 #{archiveRecoveryStatus.jobId}
											</span>
										)}
										{archiveRecoveryStatus.phase !== "idle" && (
											<span className="badge badge-outline badge-sm">
												{getArchiveRecoveryPhaseLabel(
													archiveRecoveryStatus.phase,
												)}
											</span>
										)}
									</div>
									<p className="mt-1 text-xs text-base-content/60">
										선택한 파일 또는 폴더만 저속 큐로 보강합니다. 파일을
										선택하는 것만으로는 원격 요청하지 않습니다.
									</p>
									{(archiveRecoveryStatus.scopePath ||
										archiveFolderPreview?.folderPath) && (
										<div className="mt-2 max-w-2xl break-all font-mono text-[11px] text-base-content/50">
											{archiveRecoveryStatus.scopePath ??
												archiveFolderPreview?.folderPath}
										</div>
									)}
									{archiveRecoveryStatus.scope && (
										<span className="badge badge-outline badge-sm">
											{getArchiveRecoveryScopeLabel(
												archiveRecoveryStatus.scope,
											)}
										</span>
									)}
								</div>

								<div className="flex flex-wrap gap-2">
									{isArchiveRecoveryRunning ? (
										<button
											type="button"
											className="btn btn-warning btn-sm"
											disabled={
												isArchiveRecoveryMutating ||
												archiveRecoveryStatus.isPausing
											}
											onClick={() => void handleArchiveRecoveryAction("pause")}
										>
											{archiveRecoveryStatus.isPausing
												? "중단 중..."
												: "일시 중단"}
										</button>
									) : archiveRecoveryStatus.status === "paused" ? (
										<button
											type="button"
											className="btn btn-primary btn-sm"
											disabled={
												isArchiveRecoveryMutating ||
												crawlerStatus.status === "running" ||
												isBackfillRunning
											}
											onClick={() => void handleArchiveRecoveryAction("resume")}
										>
											재개
										</button>
									) : (
										<>
											<button
												type="button"
												className="btn btn-success btn-sm"
												disabled={
													isArchiveRecoveryMutating ||
													crawlerStatus.status === "running" ||
													isBackfillRunning
												}
												onClick={() =>
													void handleArchiveRecoveryAction("start")
												}
											>
												폴더 선택 및 보강
											</button>
											{archiveRecoveryStatus.jobId &&
												archiveRecoveryStatus.tokenNotFoundCount +
													archiveRecoveryStatus.accessDeniedCount +
													archiveRecoveryStatus.failedCount >
													0 && (
													<button
														type="button"
														className="btn btn-success btn-outline btn-sm"
														disabled={
															isArchiveRecoveryMutating ||
															crawlerStatus.status === "running" ||
															isBackfillRunning
														}
														onClick={() =>
															void handleArchiveRecoveryAction("retry")
														}
													>
														미복구 재시도
													</button>
												)}
										</>
									)}
								</div>
							</div>

							<div className="mt-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-4 xl:grid-cols-9">
								{[
									["선택 대상", archiveRecoveryStatus.totalCount],
									["공식", archiveRecoveryStatus.officialCount],
									["카탈로그 전용", archiveRecoveryStatus.catalogCount],
									["삭제됨", archiveRecoveryStatus.expungedCount],
									["접근 불가", archiveRecoveryStatus.accessDeniedCount],
									["token 미복구", archiveRecoveryStatus.tokenNotFoundCount],
									["실패", archiveRecoveryStatus.failedCount],
									["재시도", archiveRecoveryStatus.retryCount],
									["파일 우선 대기", archiveRecoveryStatus.priorityCount],
								].map(([label, value]) => (
									<div key={label} className="rounded bg-base-100/70 p-3">
										<div className="text-base-content/55">{label}</div>
										<div className="mt-1 text-lg font-semibold">{value}</div>
									</div>
								))}
							</div>

							{archiveRecoveryStatus.jobId && (
								<div className="mt-4 space-y-2">
									<div className="flex items-center justify-between text-xs">
										<span>
											처리 {archiveRecoveryStatus.processedCount}/
											{archiveRecoveryStatus.totalCount} · 공식{" "}
											{archiveRecoveryStatus.officialCount} · 카탈로그{" "}
											{archiveRecoveryStatus.catalogCount} · 미복구{" "}
											{archiveRecoveryStatus.unresolvedCount} · 실패{" "}
											{archiveRecoveryStatus.failedCount} · 남음{" "}
											{archiveRecoveryStatus.remainingCount}
										</span>
										<span className="font-semibold">
											{archiveRecoveryProgress}%
										</span>
									</div>
									<progress
										className="progress progress-success w-full"
										value={archiveRecoveryProgress}
										max={100}
									/>
								</div>
							)}

							{archiveRecoveryStatus.lastError && (
								<div className="mt-3 rounded bg-warning/10 p-3 text-xs text-warning-content">
									{archiveRecoveryStatus.lastError}
								</div>
							)}

							{archiveRecoveryFailures.length > 0 && (
								<div className="mt-3 max-h-32 overflow-auto rounded border border-error/20 bg-base-100/70">
									{archiveRecoveryFailures.map((failure) => (
										<div
											key={failure.galleryId}
											className="flex gap-3 border-b border-base-content/5 px-3 py-2 text-xs last:border-b-0"
										>
											<span className="font-mono font-semibold">
												{failure.galleryId}
											</span>
											<span className="badge badge-ghost badge-xs">
												{getArchiveRecoveryPhaseLabel(failure.phase)}
											</span>
											<span className="badge badge-warning badge-xs">
												{failure.status === "token-not-found"
													? "token 미복구"
													: failure.status === "access-denied"
														? "접근 불가"
														: "실패"}
											</span>
											<span className="min-w-0 flex-1 break-words text-error">
												{failure.error}
											</span>
										</div>
									))}
								</div>
							)}
						</section>

						<form
							className="flex flex-col gap-3 lg:flex-row lg:items-end"
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

							<label className="form-control w-full lg:w-48">
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

							<label className="form-control w-full lg:w-32">
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
								<span className="flex h-8 w-8 items-center justify-center rounded-full bg-base-300 text-base-content/80">
									<ListIcon className="h-4 w-4" />
								</span>
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
