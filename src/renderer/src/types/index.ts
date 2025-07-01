export interface FileInfo {
  path: string
  name: string
  size: number
}

export interface AppState {
  selectedPath: string | null
  fileList: FileInfo[]
  isScanning: boolean
  scanComplete: boolean
  selectedRowIndex: number
}
