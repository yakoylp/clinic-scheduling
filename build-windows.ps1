<#
  打包成独立 exe（对方电脑不需要装 Node.js / Python）。
  产物在 dist/ 下：一个便携版 exe，可直接拷走双击运行。

  ★ 用户数据不在 exe 里，重新打包不会动它。
    打包版把数据存在 %APPDATA%\门诊排班\data\，本脚本只替换 dist/ 里的程序文件，
    完全不碰那个目录；而且打包前会先把用户数据整份备份到 data.bak-<时间>\，
    万一出意外还能还原。

  用法：pwsh -ExecutionPolicy Bypass -File build-windows.ps1
       加 -SkipBackup 可跳过打包前的用户数据备份
#>
param(
  [switch]$SkipPython,
  [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (Test-Path env:ELECTRON_RUN_AS_NODE) { Remove-Item env:ELECTRON_RUN_AS_NODE }

# 打包版实际使用的用户数据目录（与 electron/main.js 里的 app.setPath('userData') 一致）
$userData = Join-Path $env:APPDATA '门诊排班'
$userDataData = Join-Path $userData 'data'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $PSScriptRoot "data.bak-$stamp"

Write-Host '== 0/4 备份用户数据（重新打包不会动它，这里只是多一层保险） ==' -ForegroundColor Cyan
if ($SkipBackup) {
  Write-Host '  已跳过（-SkipBackup）' -ForegroundColor Yellow
} elseif (Test-Path $userDataData) {
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Copy-Item -Path (Join-Path $userDataData '*') -Destination $backupDir -Recurse -Force
  $docs = 0
  $doctorsFile = Join-Path $backupDir 'doctors.json'
  if (Test-Path $doctorsFile) {
    try { $docs = @((Get-Content $doctorsFile -Raw -Encoding UTF8 | ConvertFrom-Json).doctors).Count } catch { $docs = '?' }
  }
  Write-Host "  已备份到 $backupDir" -ForegroundColor Green
  Write-Host "  里面有 $docs 位医生等设置；这个备份不会被自动删除。"
} else {
  Write-Host "  $userDataData 还不存在（软件还没用过），跳过" -ForegroundColor Yellow
}

Write-Host '== 1/4 检查依赖 ==' -ForegroundColor Cyan
if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
  $env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
  & npm install --no-audit --no-fund
}
if (-not (Test-Path 'node_modules\electron-builder')) {
  Write-Host '  安装 electron-builder…' -ForegroundColor Cyan
  $env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
  & npm install --no-audit --no-fund --save-dev electron-builder
}

Write-Host '== 2/4 准备便携版 Python（导出保样式用） ==' -ForegroundColor Cyan
if ($SkipPython) {
  Write-Host '  已跳过（导出会退回默认样式）' -ForegroundColor Yellow
} elseif (Test-Path 'runtime\python\python.exe') {
  Write-Host '  已存在，跳过' -ForegroundColor Green
} else {
  & pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\fetch-python.ps1
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  Python 准备失败，打包继续，但导出文件的样式会退成 Excel 默认。' -ForegroundColor Yellow
  }
}

Write-Host '== 3/4 打包 ==' -ForegroundColor Cyan
$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
& node_modules\.bin\electron-builder.cmd --win --x64
if ($LASTEXITCODE -ne 0) {
  Write-Host '  打包失败，请把上面的报错发出来。' -ForegroundColor Red
  exit 1
}

Write-Host '== 4/4 完成 ==' -ForegroundColor Cyan
Write-Host '产物在 dist\ 目录：' -ForegroundColor Green
Get-ChildItem -LiteralPath 'dist' -Filter '*.exe' | ForEach-Object {
  $mb = [math]::Round($_.Length / 1MB, 1)
  $full = $_.FullName
  Write-Host "  $full  ($mb MB)"
}
Write-Host ''
Write-Host "用户数据在：$userDataData" -ForegroundColor Green
Write-Host '  换新版 exe / 重新打包都只替换程序，这个目录不会被动到。'
Write-Host '  想备份就是拷走 data\ 那两个 json；想换电脑用，把 data\ 一起拷过去即可。'
if (-not $SkipBackup -and (Test-Path $backupDir)) {
  Write-Host "  本次打包前的备份：$backupDir"
}
