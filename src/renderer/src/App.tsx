import { useState } from 'react'

interface FileInfo {
  path: string
  name: string
  size: number
}

function App(): React.JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileList, setFileList] = useState<FileInfo[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [scanComplete, setScanComplete] = useState(false)

  const getPath = async (): Promise<void> => {
    try {
      const path = await window.electron.ipcRenderer.invoke('get-target-path')
      setSelectedPath(path)
      // 새 경로를 선택하면 이전 스캔 결과를 초기화
      setFileList([])
      setScanComplete(false)
    } catch (error) {
      console.error('폴더 선택 중 오류 발생:', error)
    }
  }

  const scanFiles = async (): Promise<void> => {
    if (!selectedPath) {
      alert('먼저 폴더를 선택해주세요.')
      return
    }

    setIsScanning(true)
    setScanComplete(false)
    setFileList([])

    try {
      const files = await window.electron.ipcRenderer.invoke('scan-files', selectedPath)
      setFileList(files)
      setScanComplete(true)
    } catch (error) {
      console.error('파일 스캔 중 오류 발생:', error)
      alert('파일 스캔 중 오류가 발생했습니다.')
    } finally {
      setIsScanning(false)
    }
  }

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  const getRelativePath = (fullPath: string): string => {
    if (!selectedPath) return fullPath

    // 선택된 경로를 기준으로 상대 경로 생성
    const normalizedSelectedPath = selectedPath.replace(/\\/g, '/')
    const normalizedFullPath = fullPath.replace(/\\/g, '/')

    if (normalizedFullPath.startsWith(normalizedSelectedPath)) {
      const relativePath = normalizedFullPath.substring(normalizedSelectedPath.length)
      return relativePath.startsWith('/') ? relativePath.substring(1) : relativePath
    }

    return fullPath
  }

  const truncatePath = (path: string, maxLength: number = 60): string => {
    if (path.length <= maxLength) return path

    const parts = path.split('/')
    if (parts.length <= 2) return path

    // 파일명은 유지하고 중간 경로를 생략
    const fileName = parts[parts.length - 1]
    const firstDir = parts[0]

    if (firstDir.length + fileName.length + 5 < maxLength) {
      return `${firstDir}/.../${fileName}`
    }

    return `.../${fileName}`
  }

  const getTotalSize = (): string => {
    const totalBytes = fileList.reduce((sum, file) => sum + file.size, 0)
    return formatFileSize(totalBytes)
  }

  return (
    <div className="min-h-screen bg-base-200 flex flex-col">
      {/* Header Card */}
      <div className="card bg-base-100 shadow-sm rounded-none border-b flex-shrink-0">
        <div className="card-body p-4">
          <div className="flex gap-4 items-center">
            <div className="flex-1">
              <input
                className="input input-bordered w-full"
                type="text"
                value={selectedPath ?? ''}
                placeholder="📁 선택된 폴더 경로가 여기에 표시됩니다"
                readOnly
              />
            </div>
            <button className="btn btn-primary gap-2" onClick={getPath}>
              <span>📂</span>
              폴더 선택
            </button>
            <button
              className="btn btn-secondary gap-2"
              onClick={scanFiles}
              disabled={!selectedPath || isScanning}
            >
              {isScanning ? (
                <>
                  <span className="loading loading-spinner loading-sm"></span>
                  스캔 중...
                </>
              ) : (
                <>
                  <span>🔍</span>
                  스캔 시작
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col p-4 overflow-hidden">
        {/* Loading State */}
        {isScanning && (
          <div className="card bg-base-100 shadow-lg flex-1 flex items-center justify-center">
            <div className="card-body text-center py-12">
              <div className="flex flex-col items-center gap-4">
                <span className="loading loading-dots loading-lg text-primary"></span>
                <div>
                  <h3 className="text-2xl font-bold text-primary mb-2">
                    압축파일을 스캔하고 있습니다
                  </h3>
                  <p className="text-base-content/70">
                    📦 ZIP, RAR, 7Z 등의 압축파일을 검색하고 있습니다.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!isScanning && !scanComplete && !selectedPath && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md">
              <h1 className="text-5xl font-bold">🌿 Rosemary</h1>
              <p className="py-6 text-lg">폴더를 선택하여 압축파일을 스캔해보세요.</p>
              <button className="btn btn-primary btn-lg gap-2" onClick={getPath}>
                <span>📂</span>
                시작하기
              </button>
            </div>
          </div>
        )}

        {/* No Results */}
        {scanComplete && fileList.length === 0 && (
          <div className="alert alert-info shadow-lg">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              className="stroke-current shrink-0 w-6 h-6"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <h3 className="font-bold">압축파일을 찾을 수 없습니다</h3>
              <div className="text-xs">해당 경로에서 압축파일을 찾을 수 없습니다.</div>
            </div>
          </div>
        )}

        {/* Results */}
        {scanComplete && fileList.length > 0 && (
          <div className="flex-1 flex flex-col gap-4 overflow-hidden">
            {/* Simple Stats */}
            <div className="card bg-base-100 shadow-lg flex-shrink-0">
              <div className="card-body p-4">
                <h2 className="card-title text-xl mb-4">
                  <span>📊</span>
                  스캔 결과
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="stat bg-base-200 rounded-box p-4">
                    <div className="stat-figure text-primary">
                      <span className="text-2xl">📦</span>
                    </div>
                    <div className="stat-title text-sm">압축파일 개수</div>
                    <div className="stat-value text-primary text-2xl">{fileList.length}</div>
                    <div className="stat-desc text-xs">개의 파일</div>
                  </div>

                  <div className="stat bg-base-200 rounded-box p-4">
                    <div className="stat-figure text-secondary">
                      <span className="text-2xl">💾</span>
                    </div>
                    <div className="stat-title text-sm">총 용량</div>
                    <div className="stat-value text-secondary text-2xl break-all">
                      {getTotalSize()}
                    </div>
                    <div className="stat-desc text-xs">압축파일 총 크기</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Archive Files Table */}
            <div className="card bg-base-100 shadow-lg flex-auto h-0 flex flex-col overflow-hidden">
              <div className="card-body p-4 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between mb-4 flex-shrink-0">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">📦</span>
                    <span className="text-lg font-semibold">압축파일 목록</span>
                    <div className="badge badge-neutral">{fileList.length}개</div>
                  </div>
                </div>

                <div className="flex-1 overflow-hidden rounded-box border border-base-content/5">
                  <div className="overflow-auto h-full">
                    <table className="table table-zebra table-pin-rows">
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
                          const relativePath = getRelativePath(file.path)
                          const truncatedPath = truncatePath(relativePath)
                          const showTooltip = relativePath !== truncatedPath

                          return (
                            <tr key={index} className="hover">
                              <th className="text-base-content/60">{index + 1}</th>
                              <td>
                                <div className="font-semibold text-base-content break-all">
                                  {file.name}
                                </div>
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
          </div>
        )}
      </div>
    </div>
  )
}

export default App
