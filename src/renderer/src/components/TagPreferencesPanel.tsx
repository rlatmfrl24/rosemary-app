import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
	TagPreference,
	TagPreferenceKind,
} from "../../../shared/tag-preferences";
import { getSourceTagNamespaceLabel } from "../utils/gallery-metadata";

const TAG_NAMESPACE_OPTIONS = [
	"artist",
	"group",
	"parody",
	"language",
	"character",
	"female",
	"male",
	"mixed",
	"cosplayer",
	"reclass",
	"other",
	"unknown",
];

const getKindLabel = (kind: TagPreferenceKind): string =>
	kind === "preferred" ? "선호" : "제외";

export const TagPreferencesPanel = (): React.JSX.Element => {
	const [preferences, setPreferences] = useState<TagPreference[]>([]);
	const [kind, setKind] = useState<TagPreferenceKind>("preferred");
	const [namespace, setNamespace] = useState("female");
	const [value, setValue] = useState("");
	const [isLoading, setIsLoading] = useState(true);
	const [isMutating, setIsMutating] = useState(false);

	const loadPreferences = useCallback(async (): Promise<void> => {
		try {
			setIsLoading(true);
			setPreferences(await window.api.crawlerDb.listTagPreferences());
		} catch (error) {
			console.error("사용자 태그 설정 조회 실패:", error);
			alert(
				`사용자 태그 설정을 불러오지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
			);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadPreferences();
	}, [loadPreferences]);

	const preferencesByKind = useMemo(
		() => ({
			preferred: preferences.filter(
				(preference) => preference.kind === "preferred",
			),
			excluded: preferences.filter(
				(preference) => preference.kind === "excluded",
			),
		}),
		[preferences],
	);

	const upsertPreference = useCallback(
		async (
			nextKind: TagPreferenceKind,
			nextNamespace: string,
			nextValue: string,
		): Promise<void> => {
			try {
				setIsMutating(true);
				const saved = await window.api.crawlerDb.upsertTagPreference({
					kind: nextKind,
					namespace: nextNamespace,
					value: nextValue,
				});
				setPreferences((current) =>
					[...current.filter((item) => item.key !== saved.key), saved].sort(
						(left, right) =>
							left.kind.localeCompare(right.kind) ||
							left.namespace.localeCompare(right.namespace) ||
							left.value.localeCompare(right.value),
					),
				);
			} catch (error) {
				console.error("사용자 태그 설정 저장 실패:", error);
				alert(
					`사용자 태그 설정을 저장하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			} finally {
				setIsMutating(false);
			}
		},
		[],
	);

	const handleSubmit = useCallback(
		async (event: React.FormEvent): Promise<void> => {
			event.preventDefault();
			const trimmedNamespace = namespace.trim();
			const trimmedValue = value.trim();
			if (!trimmedNamespace || !trimmedValue) {
				alert("namespace와 태그명을 모두 입력해주세요.");
				return;
			}
			await upsertPreference(kind, trimmedNamespace, trimmedValue);
			setValue("");
		},
		[kind, namespace, upsertPreference, value],
	);

	const handleDelete = useCallback(
		async (preference: TagPreference): Promise<void> => {
			const confirmed = confirm(
				`${getSourceTagNamespaceLabel(preference.namespace)}: ${preference.value} 설정을 삭제하시겠습니까?`,
			);
			if (!confirmed) return;

			try {
				setIsMutating(true);
				await window.api.crawlerDb.deleteTagPreference(preference);
				setPreferences((current) =>
					current.filter((item) => item.key !== preference.key),
				);
			} catch (error) {
				console.error("사용자 태그 설정 삭제 실패:", error);
				alert(
					`사용자 태그 설정을 삭제하지 못했습니다.\n${error instanceof Error ? error.message : "알 수 없는 오류"}`,
				);
			} finally {
				setIsMutating(false);
			}
		},
		[],
	);

	const renderPreferenceList = (
		listKind: TagPreferenceKind,
	): React.JSX.Element => {
		const list = preferencesByKind[listKind];
		const nextKind = listKind === "preferred" ? "excluded" : "preferred";

		return (
			<section
				className={`rounded-box border p-3 ${
					listKind === "preferred"
						? "border-secondary/25 bg-secondary/5"
						: "border-error/25 bg-error/5"
				}`}
			>
				<div className="mb-2 flex items-center justify-between gap-2">
					<div className="font-semibold">{getKindLabel(listKind)} 태그</div>
					<span
						className={`badge badge-sm ${listKind === "preferred" ? "badge-secondary" : "badge-error"}`}
					>
						{list.length}개
					</span>
				</div>
				<div className="max-h-48 space-y-1 overflow-y-auto pr-1">
					{list.length === 0 ? (
						<div className="rounded bg-base-100/70 px-3 py-4 text-center text-xs text-base-content/55">
							등록된 태그가 없습니다.
						</div>
					) : (
						list.map((preference) => (
							<div
								key={preference.key}
								className="flex items-center gap-2 rounded bg-base-100/80 px-2 py-2"
							>
								<div className="min-w-0 flex-1">
									<div className="truncate text-sm font-medium">
										{preference.value}
									</div>
									<div className="truncate font-mono text-[11px] text-base-content/50">
										{preference.namespace}
									</div>
								</div>
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									disabled={isMutating}
									aria-label={`${preference.value} 태그를 ${getKindLabel(nextKind)} 태그로 전환`}
									onClick={() =>
										void upsertPreference(
											nextKind,
											preference.namespace,
											preference.value,
										)
									}
								>
									{getKindLabel(nextKind)}로
								</button>
								<button
									type="button"
									className="btn btn-error btn-outline btn-xs"
									disabled={isMutating}
									aria-label={`${preference.value} 태그 설정 삭제`}
									onClick={() => void handleDelete(preference)}
								>
									삭제
								</button>
							</div>
						))
					)}
				</div>
			</section>
		);
	};

	return (
		<section className="rounded-box border border-primary/20 bg-primary/5 p-4">
			<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
				<div>
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="font-semibold">사용자 태그 관리</h3>
						<span className="badge badge-secondary badge-sm">
							선호 {preferencesByKind.preferred.length}
						</span>
						<span className="badge badge-error badge-sm">
							제외 {preferencesByKind.excluded.length}
						</span>
					</div>
					<p className="mt-1 text-xs text-base-content/60">
						선호 태그는 검토 우선순위와 랜덤 재검토 필터에 사용하고, 제외 태그는
						신규 다운로드 전송을 차단합니다.
					</p>
				</div>
				{isLoading && (
					<span
						className="loading loading-spinner loading-sm"
						role="status"
						aria-label="태그 설정 불러오는 중"
					/>
				)}
			</div>

			<form
				className="mt-3 grid gap-2 md:grid-cols-[140px_180px_minmax(0,1fr)_auto]"
				onSubmit={(event) => void handleSubmit(event)}
			>
				<select
					className="select select-bordered select-sm"
					value={kind}
					disabled={isMutating}
					aria-label="태그 분류"
					onChange={(event) => setKind(event.target.value as TagPreferenceKind)}
				>
					<option value="preferred">선호 태그</option>
					<option value="excluded">제외 태그</option>
				</select>
				<input
					className="input input-bordered input-sm font-mono"
					list="tag-namespace-options"
					value={namespace}
					disabled={isMutating}
					placeholder="namespace"
					aria-label="태그 namespace"
					onChange={(event) => setNamespace(event.target.value)}
				/>
				<datalist id="tag-namespace-options">
					{TAG_NAMESPACE_OPTIONS.map((option) => (
						<option key={option} value={option} />
					))}
				</datalist>
				<input
					className="input input-bordered input-sm"
					value={value}
					disabled={isMutating}
					placeholder="태그명"
					aria-label="태그명"
					onChange={(event) => setValue(event.target.value)}
				/>
				<button
					type="submit"
					className="btn btn-primary btn-sm"
					disabled={isMutating || !namespace.trim() || !value.trim()}
				>
					추가
				</button>
			</form>

			<div className="mt-3 grid gap-3 md:grid-cols-2">
				{renderPreferenceList("preferred")}
				{renderPreferenceList("excluded")}
			</div>
		</section>
	);
};
