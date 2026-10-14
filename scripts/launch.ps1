<#
  启动排班软件。
  可以用 scripts\launch.ps1 -Data <目录> 指定另一份数据目录（测试用）。
#>
param(
  [string]$Data = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

# 某些自动化环境会带上这个变量，会让 electron 退化成纯 node，必须先清掉
if (Test-Path env:ELECTRON_RUN_AS_NODE) { Remove-Item env:ELECTRON_RUN_AS_NODE }

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path -LiteralPath $electron)) {
  Write-Host ''
  Write-Host '  还没安装依赖，需要先装一次（大约 250MB，需要联网）。' -ForegroundColor Yellow
  Write-Host ''
  $answer = Read-Host '  现在安装吗？(Y/N)'
  if ($answer -notmatch '^[Yy]') {
    Write-Host '  已取消。装好依赖后再双击本文件即可。' -ForegroundColor Yellow
    exit 1
  }
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) {
    Write-Host '  没找到 npm。请先安装 Node.js 16 以上版本：https://nodejs.org/' -ForegroundColor Red
    exit 1
  }
  $env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
  Write-Host '  正在安装依赖，请稍候…' -ForegroundColor Cyan
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host '  依赖安装失败，请检查网络后重试。' -ForegroundColor Red
    exit 1
  }
}

if ($Data) { $env:DSH_SCHEDULE_DATA = (Resolve-Path -LiteralPath $Data).Path }

Write-Host '  正在启动 门诊排班…' -ForegroundColor Green
$proc = Start-Process -FilePath $electron -ArgumentList @($root) -WorkingDirectory $root -PassThru
exit 0
