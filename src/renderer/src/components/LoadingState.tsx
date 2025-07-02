export const LoadingState = (): React.JSX.Element => {
  return (
    <div className="card bg-base-100 shadow-lg flex-1 flex items-center justify-center">
      <div className="card-body text-center py-12">
        <div className="flex flex-col items-center gap-4">
          <span className="loading loading-dots loading-lg text-primary"></span>
          <div>
            <h3 className="text-2xl font-bold text-primary mb-2">압축파일을 스캔하고 있습니다</h3>
            <p className="text-base-content/70">
              📦 ZIP, RAR, 7Z 등의 압축파일을 검색하고 있습니다.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
