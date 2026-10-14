<#
  打包成独立 exe（对方电脑不需要装 Node.js / Python）。
  产物在 dist/ 下：一个便携版 exe，可直接拷走双击运行。
  用法：pwsh -ExecutionPolicy Bypass -File build-windows.ps1
#>
param(
  [switch]$SkipPython
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (Test-Path env:ELECTRON_RUN_AS_NODE) { Remove-Item env:ELECTRON_RUN_AS_NODE }

Write-Host '== 1/3 检查依赖 ==' -ForegroundColor Cyan
if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) {
  $env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
  & npm install --no-audit --no-fund
}
if (-not (Test-Path 'node_modules\electron-builder')) {
  Write-Host '  安装 electron-builder…' -ForegroundColor Cyan
  $env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
  & npm install --no-audit --no-fund --save-dev electron-builder
}

Write-Host '== 2/3 准备便携版 Python（导出保样式用） ==' -ForegroundColor Cyan
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

Write-Host '== 3/3 打包 ==' -ForegroundColor Cyan
$env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
& node_modules\.bin\electron-builder.cmd --win --x64
if ($LASTEXITCODE -ne 0) {
  Write-Host '  打包失败，请把上面的报错发出来。' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host '打包完成，产物在 dist\ 目录：' -ForegroundColor Green
Get-ChildItem -LiteralPath 'dist' -Filter '*.exe' | ForEach-Object {
  $mb = [math]::Round($_.Length / 1MB, 1)
  Write-Host "  $($_.Name)  ($mb MB)"
}
Write-Host ''
Write-Host '注意：便携版 exe 会把自己解压到临时目录运行，数据会写在解压出来的目录里。'
Write-Host '想要「数据和 exe 放一起」的绿色版，用 dist\win-unpacked\ 那个文件夹。'
