interface EmptyStateProps {
  onSelectPath: () => void
}

export const EmptyState = ({ onSelectPath }: EmptyStateProps): React.JSX.Element => {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center max-w-md">
        <h1 className="text-5xl font-bold">🌿 Rosemary</h1>
        <p className="py-6 text-lg">폴더를 선택하여 압축파일을 스캔해보세요.</p>
        <button className="btn btn-primary btn-lg gap-2" onClick={onSelectPath}>
          <span>📂</span>
          시작하기
        </button>
      </div>
    </div>
  )
}
