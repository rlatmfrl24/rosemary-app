import React, { RefObject } from 'react'
import { FileInfo } from '../types'
import { formatFileSize, getRelativePath, truncatePath } from '../utils/file'

interface FileTableProps {
  fileList: FileInfo[]
  selectedRowIndex: number
  selectedPath: string | null
  tableContainerRef: RefObject<HTMLDivElement>
  onRowClick: (index: number) => void
}

export const FileTable = ({
  fileList,
  selectedRowIndex,
  selectedPath,
  tableContainerRef,
  onRowClick
}: FileTableProps): React.JSX.Element => {
  return (
    <div className="card bg-base-100 shadow-lg flex-auto h-0 flex flex-col overflow-hidden">
      <div className="card-body p-4 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between mb-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-xl">📦</span>
            <span className="text-lg font-semibold">압축파일 목록</span>
            <div className="badge badge-neutral">{fileList.length}개</div>
          </div>
          <div className="text-xs text-base-content/60">↑↓ 이동 | Enter 정보 | Del 삭제</div>
        </div>

        <div className="flex-1 overflow-hidden rounded-box border border-base-content/5">
          <div ref={tableContainerRef} className="overflow-auto h-full">
            <table className="table table-pin-rows">
              <thead>
                <tr>
                  <th className="w-16">#</th>
                  <th className="min-w-48">파일명</th>
                  <th className="min-w-64">경로</th>
                  <th className="w-24">크기</th>
                </tr>
              </thead>
              <tbody>
                {fileList.map((file, index) => {
                  const relativePath = getRelativePath(file.path, selectedPath || '')
                  const truncatedPath = truncatePath(relativePath)
                  const showTooltip = relativePath !== truncatedPath
                  const isSelected = selectedRowIndex === index

                  return (
                    <tr
                      key={index}
                      className={`hover cursor-pointer ${isSelected ? 'bg-primary/20 hover:bg-primary/30' : ''}`}
                      onClick={() => onRowClick(index)}
                    >
                      <th className="text-base-content/60">{index + 1}</th>
                      <td>
                        <div className="font-semibold text-base-content break-all">{file.name}</div>
                      </td>
                      <td>
                        <div
                          className={`text-sm text-base-content/60 font-mono break-all ${
                            showTooltip ? 'tooltip tooltip-top' : ''
                          }`}
                          data-tip={showTooltip ? relativePath : undefined}
                        >
                          📁 {truncatedPath}
                        </div>
                      </td>
                      <td>
                        <div className="badge badge-outline whitespace-nowrap">
                          {formatFileSize(file.size)}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
