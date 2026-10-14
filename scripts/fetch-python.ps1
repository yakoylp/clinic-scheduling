<#
  下载一份便携版 Python + openpyxl 到 runtime/python。
  只有在打包 exe 给别人用（对方电脑可能没装 Python）时才需要跑这一步。
  导出 Excel 时优先用它，这样导出文件能保留模板的字体、居中、列宽。
  用法：pwsh -ExecutionPolicy Bypass -File scripts/fetch-python.ps1
#>
param(
  [string]$Version = '3.12.8'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'runtime\python'

if (Test-Path -LiteralPath (Join-Path $target 'python.exe')) {
  Write-Host "  已经存在：$target" -ForegroundColor Green
  Write-Host '  如需重新下载，先删掉这个目录。'
  exit 0
}

New-Item -ItemType Directory -Force -Path $target | Out-Null
$tmp = Join-Path $env:TEMP ("derm-python-" + $Version)
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

$short = ($Version -split '\.')[0..1] -join '.'
$mirrors = @(
  "https://mirrors.huaweicloud.com/python/$Version/python-$Version-embed-amd64.zip",
  "https://registry.npmmirror.com/-/binary/python/$Version/python-$Version-embed-amd64.zip",
  "https://www.python.org/ftp/python/$Version/python-$Version-embed-amd64.zip"
)

$zip = Join-Path $tmp 'python-embed.zip'
$ok = $false
foreach ($url in $mirrors) {
  try {
    Write-Host "  下载 $url" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 180
    $ok = $true
    break
  } catch {
    Write-Host "  这个源不行，换下一个：$($_.Exception.Message)" -ForegroundColor Yellow
  }
}
if (-not $ok) {
  Write-Host '  所有下载源都失败了。可以手动下载 python-<版本>-embed-amd64.zip 解压到 runtime\python。' -ForegroundColor Red
  exit 1
}

Expand-Archive -LiteralPath $zip -DestinationPath $target -Force

# 便携版默认不加载 site-packages，也不认 pip，需要放开
$pth = Get-ChildItem -LiteralPath $target -Filter 'python*._pth' | Select-Object -First 1
if ($pth) {
  $lines = Get-Content -LiteralPath $pth.FullName
  $lines = $lines | ForEach-Object { if ($_ -eq '#import site') { 'import site' } else { $_ } }
  if ($lines -notcontains 'import site') { $lines += 'import site' }
  if ($lines -notcontains 'Lib\site-packages') { $lines += 'Lib\site-packages' }
  Set-Content -LiteralPath $pth.FullName -Value $lines -Encoding ASCII
  Write-Host "  已放开 site-packages：$($pth.Name)"
}

# 直接把 openpyxl 的 wheel 解到 site-packages，省掉联网装 pip 这一步
$sitePackages = Join-Path $target 'Lib\site-packages'
New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
$wheels = @(
  @{ name = 'openpyxl'; url = 'https://pypi.org/pypi/openpyxl/json' },
  @{ name = 'et_xmlfile'; url = 'https://pypi.org/pypi/et_xmlfile/json' }
)
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($pkg in $wheels) {
  Write-Host "  取 $($pkg.name) 的 wheel…" -ForegroundColor Cyan
  $meta = Invoke-RestMethod -Uri $pkg.url -TimeoutSec 60
  $file = $meta.urls | Where-Object { $_.packagetype -eq 'bdist_wheel' -and $_.filename -notmatch 'macos|manylinux|musllinux|aarch64|win32' } | Select-Object -First 1
  if (-not $file) { throw "找不到 $($pkg.name) 的通用 wheel" }
  $whl = Join-Path $tmp $file.filename
  Invoke-WebRequest -Uri $file.url -OutFile $whl -TimeoutSec 120
  [System.IO.Compression.ZipFile]::ExtractToDirectory($whl, $sitePackages, $true)
}

$python = Join-Path $target 'python.exe'
$version = & $python -c "import openpyxl,sys;print(sys.version.split()[0], openpyxl.__version__)"
Write-Host "  完成：$python" -ForegroundColor Green
Write-Host "  自检：Python $version"
