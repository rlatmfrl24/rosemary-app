import { useEffect, useCallback } from 'react'
import { FileInfo } from '../types'

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
            console.log('BandiView로 파일 열기:', selectedFile.name)

            // BandiView로 파일 열기
            window.electron.ipcRenderer
              .invoke('open-with-bandiview', selectedFile.path)
              .then((result) => {
                console.log('BandiView 실행 성공:', result.message)
              })
              .catch((error) => {
                console.error('BandiView 실행 실패:', error)
                alert(`BandiView로 파일을 열 수 없습니다:\n${error.message || error}`)
              })
          }
          break

        case 'Delete':
          event.preventDefault()
          if (selectedRowIndex >= 0 && selectedRowIndex < fileList.length) {
            const selectedFile = fileList[selectedRowIndex]

            // Shift+Delete: 실제 파일 삭제
            if (event.shiftKey) {
              const confirmDelete = confirm(
                `파일을 완전히 삭제하시겠습니까?\n\n파일명: ${selectedFile.name}\n\n이 작업은 되돌릴 수 없습니다.`
              )

              if (confirmDelete) {
                console.log('파일 완전 삭제:', selectedFile.name)

                // 실제 파일 삭제 시도
                window.electron.ipcRenderer
                  .invoke('delete-file', selectedFile.path)
                  .then(() => {
                    console.log('파일이 성공적으로 삭제되었습니다:', selectedFile.name)

                    // 목록에서도 제거
                    const newFileList = fileList.filter((_, index) => index !== selectedRowIndex)
                    setFileList(newFileList)

                    if (newFileList.length === 0) {
                      setSelectedRowIndex(-1)
                    } else if (selectedRowIndex >= newFileList.length) {
                      setSelectedRowIndex(newFileList.length - 1)
                    }
                  })
                  .catch((error) => {
                    console.error('파일 삭제 실패:', error)
                    alert(`파일 삭제에 실패했습니다:\n${error.message || error}`)
                  })
              }
            } else {
              // Delete: 목록에서만 제거
              console.log('목록에서 제거:', selectedFile.name)

              const newFileList = fileList.filter((_, index) => index !== selectedRowIndex)
              setFileList(newFileList)

              if (newFileList.length === 0) {
                setSelectedRowIndex(-1)
              } else if (selectedRowIndex >= newFileList.length) {
                setSelectedRowIndex(newFileList.length - 1)
              }
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
