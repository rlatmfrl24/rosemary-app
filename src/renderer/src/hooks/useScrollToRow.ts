import { type RefObject, useCallback, useEffect } from "react";

interface UseScrollToRowProps {
	selectedRowIndex: number;
	tableContainerRef: RefObject<HTMLDivElement>;
}

export const useScrollToRow = ({
	selectedRowIndex,
	tableContainerRef,
}: UseScrollToRowProps): void => {
	const scrollToSelectedRow = useCallback(
		(rowIndex: number): void => {
			if (!tableContainerRef.current || rowIndex < 0) return;

			const container = tableContainerRef.current;
			const table = container.querySelector("table");
			const thead = table?.querySelector("thead");
			const tbody = table?.querySelector("tbody");
			const rows = tbody
				? tbody.querySelectorAll("tr")
				: container.querySelectorAll("[data-file-row-index]");
			const targetRow = rows[rowIndex] as HTMLElement | undefined;
			if (!targetRow) return;

			const isTableMode = Boolean(tbody);
			const headerHeight = thead ? thead.offsetHeight : 0;
			const rowHeight = targetRow.offsetHeight;
			const containerHeight = container.clientHeight;
			const padding = isTableMode ? 20 : 32;

			const containerRect = container.getBoundingClientRect();
			const rowRect = targetRow.getBoundingClientRect();
			const rowTop =
				rowRect.top - containerRect.top + container.scrollTop - headerHeight;
			const rowBottom = rowTop + rowHeight;
			const visibleTop = container.scrollTop + padding;
			const visibleBottom = container.scrollTop + containerHeight - padding;
			const availableHeight = Math.max(0, containerHeight - padding * 2);

			const isRowFullyVisible =
				rowTop >= visibleTop && rowBottom <= visibleBottom;

			if (!isRowFullyVisible) {
				let newScrollTop: number;

				if (!isTableMode && rowHeight >= availableHeight) {
					newScrollTop = Math.max(0, rowTop - padding);
				} else if (rowTop < visibleTop || rowIndex === 0) {
					newScrollTop = Math.max(0, rowTop - padding);
				} else {
					newScrollTop = Math.max(0, rowBottom - containerHeight + padding);
				}

				container.scrollTo({
					top: newScrollTop,
					behavior: "smooth",
				});
			}
		},
		[tableContainerRef],
	);

	useEffect(() => {
		if (selectedRowIndex >= 0) {
			const timeoutId = setTimeout(() => {
				scrollToSelectedRow(selectedRowIndex);
			}, 50);

			return () => clearTimeout(timeoutId);
		}

		return undefined;
	}, [selectedRowIndex, scrollToSelectedRow]);
};
