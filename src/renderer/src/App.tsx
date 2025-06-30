import { useState } from 'react'

function App(): React.JSX.Element {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const getPath = async (): Promise<void> => {
    try {
      const path = await window.electron.ipcRenderer.invoke('get-target-path')
      setSelectedPath(path)
    } catch (error) {
      console.error('폴더 선택 중 오류 발생:', error)
    }
  }

  return (
    <>
      <div className="h-screen">
        <div className="flex gap-2 p-1 items-center">
          <input
            className="file-input flex-1 px-4"
            type="text"
            value={selectedPath ?? ''}
            placeholder="선택된 폴더 경로가 여기에 표시됩니다"
            readOnly
          />
          <button className="btn btn-primary" onClick={getPath}>
            폴더 선택
          </button>
          <button className="btn btn-secondary" onClick={getPath}>
            확인
          </button>
        </div>
      </div>
    </>
  )
}

export default App
