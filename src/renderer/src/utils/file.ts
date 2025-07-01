export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

export const getRelativePath = (fullPath: string, selectedPath: string): string => {
  if (!selectedPath) return fullPath

  const normalizedSelectedPath = selectedPath.replace(/\\/g, '/')
  const normalizedFullPath = fullPath.replace(/\\/g, '/')

  if (normalizedFullPath.startsWith(normalizedSelectedPath)) {
    const relativePath = normalizedFullPath.substring(normalizedSelectedPath.length)
    return relativePath.startsWith('/') ? relativePath.substring(1) : relativePath
  }

  return fullPath
}

export const truncatePath = (path: string, maxLength: number = 60): string => {
  if (path.length <= maxLength) return path

  const parts = path.split('/')
  if (parts.length <= 2) return path

  const fileName = parts[parts.length - 1]
  const firstDir = parts[0]

  if (firstDir.length + fileName.length + 5 < maxLength) {
    return `${firstDir}/.../${fileName}`
  }

  return `.../${fileName}`
}
