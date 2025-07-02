import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('get-target-path', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) {
      return null
    } else {
      return result.filePaths[0]
    }
  })

  // 파일 탐색 IPC 핸들러
  ipcMain.handle('scan-files', async (_, targetPath: string) => {
    if (!targetPath) {
      throw new Error('경로가 지정되지 않았습니다.')
    }

    // 압축파일 확장자
    const archiveExtensions = [
      '.zip',
      '.rar',
      '.7z',
      '.tar',
      '.gz',
      '.bz2',
      '.xz',
      '.tar.gz',
      '.tar.bz2',
      '.tar.xz',
      '.cab',
      '.iso',
      '.dmg',
      '.pkg',
      '.deb',
      '.rpm'
    ]

    // 명시적으로 제외할 확장자 (이미지, 동영상 등)
    const excludedExtensions = [
      // 이미지 파일
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.bmp',
      '.tiff',
      '.tif',
      '.webp',
      '.svg',
      '.ico',
      '.raw',
      '.cr2',
      '.nef',
      '.arw',
      '.dng',
      '.psd',
      '.ai',
      '.eps',
      // 동영상 파일
      '.mp4',
      '.avi',
      '.mkv',
      '.mov',
      '.wmv',
      '.flv',
      '.webm',
      '.m4v',
      '.3gp',
      '.mpg',
      '.mpeg',
      '.ts',
      '.vob',
      '.asf',
      '.rm',
      '.rmvb',
      '.m2ts',
      '.mts',
      // 음성 파일
      '.mp3',
      '.wav',
      '.flac',
      '.aac',
      '.ogg',
      '.wma',
      '.m4a',
      // 문서 파일
      '.txt',
      '.doc',
      '.docx',
      '.pdf',
      '.xls',
      '.xlsx',
      '.ppt',
      '.pptx',
      '.rtf',
      '.odt',
      '.ods',
      '.odp'
    ]

    const scanDirectory = (
      dirPath: string
    ): Promise<Array<{ path: string; name: string; size: number }>> => {
      return new Promise((resolve, reject) => {
        const results: Array<{
          path: string
          name: string
          size: number
        }> = []

        const processDirectory = async (currentPath: string): Promise<void> => {
          try {
            const items = await fs.promises.readdir(currentPath, { withFileTypes: true })

            for (const item of items) {
              const fullPath = path.join(currentPath, item.name)

              if (item.isDirectory()) {
                // 재귀적으로 하위 디렉토리 탐색
                await processDirectory(fullPath)
              } else if (item.isFile()) {
                const ext = path.extname(item.name).toLowerCase()

                // 먼저 제외할 확장자인지 확인
                if (excludedExtensions.includes(ext)) {
                  continue // 제외 대상이면 건너뛰기
                }

                // 압축파일 확장자인지 확인
                if (archiveExtensions.includes(ext)) {
                  try {
                    const stats = await fs.promises.stat(fullPath)
                    results.push({
                      path: fullPath,
                      name: item.name,
                      size: stats.size
                    })
                  } catch (statError) {
                    console.warn(`파일 정보 읽기 실패: ${fullPath}`, statError)
                  }
                }
              }
            }
          } catch (error) {
            console.warn(`디렉토리 읽기 실패: ${currentPath}`, error)
          }
        }

        processDirectory(dirPath)
          .then(() => resolve(results))
          .catch(reject)
      })
    }

    try {
      const files = await scanDirectory(targetPath)
      return files
    } catch (error) {
      console.error('파일 스캔 중 오류 발생:', error)
      throw error
    }
  })

  // 파일 삭제 IPC 핸들러
  ipcMain.handle('delete-file', async (_, filePath: string) => {
    try {
      // 파일 존재 여부 확인
      const exists = await fs.promises
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      if (!exists) {
        throw new Error('파일이 존재하지 않습니다.')
      }

      // 파일 삭제 실행
      await fs.promises.unlink(filePath)
      return { success: true, message: '파일이 성공적으로 삭제되었습니다.' }
    } catch (error) {
      console.error('파일 삭제 중 오류 발생:', error)
      throw error
    }
  })

  // BandiView로 파일 열기 IPC 핸들러
  ipcMain.handle('open-with-bandiview', async (_, filePath: string) => {
    const bandiViewPath = 'C:/Program Files/BandiView/BandiView.exe'

    try {
      // 파일 존재 여부 확인
      const fileExists = await fs.promises
        .access(filePath)
        .then(() => true)
        .catch(() => false)
      if (!fileExists) {
        throw new Error('파일이 존재하지 않습니다.')
      }

      // BandiView 실행 파일 존재 여부 확인
      const bandiViewExists = await fs.promises
        .access(bandiViewPath)
        .then(() => true)
        .catch(() => false)
      if (!bandiViewExists) {
        throw new Error('BandiView가 설치되어 있지 않거나 경로를 찾을 수 없습니다.')
      }

      // BandiView로 파일 열기
      const child = spawn(bandiViewPath, [filePath], {
        detached: true,
        stdio: 'ignore'
      })

      child.unref() // 부모 프로세스와 분리하여 독립 실행

      return { success: true, message: 'BandiView로 파일을 열었습니다.' }
    } catch (error) {
      console.error('BandiView로 파일 열기 실패:', error)
      throw error
    }
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
