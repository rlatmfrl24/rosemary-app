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

// 파일 경로 구조 파싱 함수
export const parseFileStructure = (
  relativePath: string
): {
  type?: string
  origin?: string
  artist?: string
  category?: string
  title?: string
  code?: string
} => {
  const pathParts = relativePath.split('/')
  const fileName = pathParts[pathParts.length - 1] // 파일명

  // 파일명에서 확장자 제거
  const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '')

  // 파일명에서 작가와 분류 정보 추출
  const parseFromFilename = (
    filename: string
  ): {
    artist?: string
    category?: string
    title?: string
    code?: string
  } => {
    // 정규표현식으로 파일명 구조 파싱
    // 패턴: [작가명][2차분류] 제목 (코드)
    const pattern = /^\[([^\]]+)\]\[([^\]]*)\]\s*(.+?)\s*\((\d+)\)$/
    const match = filename.match(pattern)

    if (match) {
      const [, artist, category, title, code] = match
      return {
        artist: artist.trim(),
        category: category.trim() || 'N/A',
        title: title.trim(),
        code
      }
    }

    // 작가만 있는 패턴: [작가명] 제목 (코드)
    const artistOnlyPattern = /^\[([^\]]+)\]\s*(.+?)\s*\((\d+)\)$/
    const artistMatch = filename.match(artistOnlyPattern)

    if (artistMatch) {
      const [, artist, title, code] = artistMatch
      return {
        artist: artist.trim(),
        title: title.trim(),
        code
      }
    }

    // 코드만 있는 패턴: 제목 (코드)
    const codeOnlyPattern = /^(.+?)\s*\((\d+)\)$/
    const codeMatch = filename.match(codeOnlyPattern)

    if (codeMatch) {
      const [, title, code] = codeMatch
      return {
        title: title.trim(),
        code
      }
    }

    // 패턴이 맞지 않는 경우 파일명을 제목으로 사용
    return {
      title: filename
    }
  }

  const fileData = parseFromFilename(nameWithoutExt)

  // 경로에서 type과 origin 추출 (있는 경우)
  const result: {
    type?: string
    origin?: string
    artist?: string
    category?: string
    title?: string
    code?: string
  } = {
    ...fileData
  }

  if (pathParts.length >= 2) {
    result.type = pathParts[0] // 유형 (예: Artistcg)
  }

  if (pathParts.length >= 3) {
    result.origin = pathParts[1] // 오리진 (예: Genshin Impact)
  }

  return result
}
