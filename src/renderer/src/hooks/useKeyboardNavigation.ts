import { useEffect, useCallback } from 'react'
import { FileInfo } from '../types'
import { formatFileSize } from '../utils/file'

interface UseKeyboardNavigationProps {
  scanComplete: boolean
  fileList: FileInfo[]
  selectedRowIndex: number
  setSelectedRowIndex: (index: number) => void
  setFileList: (files: FileInfo[]) => void
}

export const useKeyboardNavigation = ({
  scanComplete,
  fileList,
  selectedRowIndex,
  setSelectedRowIndex,
  setFileList
}: UseKeyboardNavigationProps): void => {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (!scanComplete || fileList.length === 0) return

      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault()
          setSelectedRowIndex(Math.max(0, selectedRowIndex - 1))
          break

        case 'ArrowDown':
          event.preventDefault()
          setSelectedRowIndex(Math.min(fileList.length - 1, selectedRowIndex + 1))
          break

        case 'Enter':
          event.preventDefault()
          if (selectedRowIndex >= 0 && selectedRowIndex < fileList.length) {
            const selectedFile = fileList[selectedRowIndex]
            console.log('선택된 파일 정보:', {
              index: selectedRowIndex + 1,
              name: selectedFile.name,
              path: selectedFile.path,
              size: formatFileSize(selectedFile.size),
              sizeBytes: selectedFile.size
            })
          }
          break

        case 'Delete':
          event.preventDefault()
          if (selectedRowIndex >= 0 && selectedRowIndex < fileList.length) {
            const selectedFile = fileList[selectedRowIndex]
            console.log('파일 삭제:', selectedFile.name)

            const newFileList = fileList.filter((_, index) => index !== selectedRowIndex)
            setFileList(newFileList)

            if (newFileList.length === 0) {
              setSelectedRowIndex(-1)
            } else if (selectedRowIndex >= newFileList.length) {
              setSelectedRowIndex(newFileList.length - 1)
            }
          }
          break
      }
    },
    [scanComplete, fileList, selectedRowIndex, setSelectedRowIndex, setFileList]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleKeyDown])
}
