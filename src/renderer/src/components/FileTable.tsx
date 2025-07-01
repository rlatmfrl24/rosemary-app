import React, { RefObject } from 'react'
import { FileInfo } from '../types'
import { formatFileSize, getRelativePath, parseFileStructure } from '../utils/file'

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
            <span className="text-lg font-semibold">작품 목록</span>
            <div className="badge badge-neutral">{fileList.length}개</div>
          </div>
          <div className="text-xs text-base-content/60">↑↓ 이동 | Enter 정보 | Del 삭제</div>
        </div>

        <div className="flex-1 overflow-hidden rounded-box border border-base-content/5">
          <div ref={tableContainerRef} className="overflow-auto h-full">
            <table className="table table-pin-rows table-xs">
              <thead>
                <tr>
                  <th className="w-12">#</th>
                  <th className="w-20">코드</th>
                  <th className="w-16">유형</th>
                  <th className="w-28">오리진</th>
                  <th className="w-48">작가</th>
                  <th className="w-16">분류</th>
                  <th className="min-w-60">제목</th>
                  <th className="w-24">크기</th>
                </tr>
              </thead>
              <tbody>
                {fileList.map((file, index) => {
                  const relativePath = getRelativePath(file.path, selectedPath || '')
                  const parsedData = parseFileStructure(relativePath)
                  const isSelected = selectedRowIndex === index

                  return (
                    <tr
                      key={index}
                      className={`hover cursor-pointer ${isSelected ? 'bg-primary/20 hover:bg-primary/30' : ''}`}
                      onClick={() => onRowClick(index)}
                    >
                      <th className="text-base-content/60">{index + 1}</th>
                      <td>
                        <div className="text-xs font-mono text-base-content/60">
                          {parsedData.code || '-'}
                        </div>
                      </td>
                      <td>
                        <div className="badge badge-outline badge-xs">{parsedData.type || '-'}</div>
                      </td>
                      <td>
                        <div className="text-sm font-medium truncate" title={parsedData.origin}>
                          {parsedData.origin || '-'}
                        </div>
                      </td>
                      <td>
                        <div
                          className="text-sm font-semibold text-primary truncate"
                          title={parsedData.artist}
                        >
                          {parsedData.artist || '-'}
                        </div>
                      </td>
                      <td>
                        <div className="text-xs opacity-70">{parsedData.category || '-'}</div>
                      </td>
                      <td>
                        <div className="text-sm font-medium truncate" title={parsedData.title}>
                          {parsedData.title || file.name}
                        </div>
                      </td>
                      <td>
                        <div className="badge badge-ghost badge-xs">
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
