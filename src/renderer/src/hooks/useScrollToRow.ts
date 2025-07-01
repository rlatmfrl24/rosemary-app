import { useEffect, useCallback, RefObject } from 'react'

interface UseScrollToRowProps {
  selectedRowIndex: number
  fileListLength: number
  tableContainerRef: RefObject<HTMLDivElement>
}

export const useScrollToRow = ({
  selectedRowIndex,
  fileListLength,
  tableContainerRef
}: UseScrollToRowProps): void => {
  const scrollToSelectedRow = useCallback(
    (rowIndex: number): void => {
      if (!tableContainerRef.current || rowIndex < 0) return

      const container = tableContainerRef.current
      const table = container.querySelector('table')
      const thead = table?.querySelector('thead')
      const tbody = table?.querySelector('tbody')
      if (!tbody) return

      const rows = tbody.querySelectorAll('tr')
      const targetRow = rows[rowIndex]
      if (!targetRow) return

      const headerHeight = thead ? thead.offsetHeight : 0
      const rowOffsetTop = targetRow.offsetTop
      const rowHeight = targetRow.offsetHeight
      const containerHeight = container.clientHeight
      const padding = 20

      const containerRect = container.getBoundingClientRect()
      const rowRect = targetRow.getBoundingClientRect()

      const visibleTop = containerRect.top + headerHeight
      const visibleBottom = containerRect.bottom

      const isRowFullyVisible =
        rowRect.top >= visibleTop + padding && rowRect.bottom <= visibleBottom - padding

      if (!isRowFullyVisible) {
        let newScrollTop: number

        if (rowIndex === 0) {
          newScrollTop = Math.max(0, rowOffsetTop - headerHeight - padding)
        } else if (rowIndex === fileListLength - 1) {
          newScrollTop = Math.max(0, rowOffsetTop - containerHeight + rowHeight + padding)
        } else if (rowRect.top < visibleTop) {
          newScrollTop = Math.max(0, rowOffsetTop - headerHeight - padding)
        } else {
          newScrollTop = Math.max(0, rowOffsetTop - containerHeight + rowHeight + padding)
        }

        container.scrollTo({
          top: newScrollTop,
          behavior: 'smooth'
        })
      }
    },
    [fileListLength, tableContainerRef]
  )

  useEffect(() => {
    if (selectedRowIndex >= 0) {
      const timeoutId = setTimeout(() => {
        scrollToSelectedRow(selectedRowIndex)
      }, 50)

      return () => clearTimeout(timeoutId)
    }

    return undefined
  }, [selectedRowIndex, scrollToSelectedRow])
}
