import { formatFileSize } from '../utils/file'
import { FileInfo } from '../types'

interface StatsProps {
  fileList: FileInfo[]
}

export const Stats = ({ fileList }: StatsProps): React.JSX.Element => {
  const getTotalSize = (): string => {
    const totalBytes = fileList.reduce((sum, file) => sum + file.size, 0)
    return formatFileSize(totalBytes)
  }

  return (
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
            <div className="stat-value text-secondary text-2xl break-all">{getTotalSize()}</div>
            <div className="stat-desc text-xs">압축파일 총 크기</div>
          </div>
        </div>
      </div>
    </div>
  )
}
