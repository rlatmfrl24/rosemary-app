Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$distPath = Join-Path $repoRoot "dist"

if (-not (Test-Path -LiteralPath $distPath)) {
	Write-Error "dist 폴더를 찾을 수 없습니다. 먼저 Windows 빌드를 완료해야 합니다."
	exit 1
}

$setupFile = Get-ChildItem -LiteralPath $distPath -File -Filter "*-setup.exe" |
	Sort-Object LastWriteTime -Descending |
	Select-Object -First 1

if (-not $setupFile) {
	Write-Error "dist 폴더에서 Windows 설치 파일(*-setup.exe)을 찾을 수 없습니다."
	exit 1
}

Write-Host "Windows 설치 파일 실행: $($setupFile.FullName)"
Start-Process -FilePath $setupFile.FullName
