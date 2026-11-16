<#
  一键准备：
    1. 启动本地 PowerShell 桥（后台隐藏窗口）
    2. 打开扩展目录和 Edge 扩展管理页
    3. 打开 chat.deepseek.com
  用法（在本目录下右键“使用 PowerShell 运行”，或命令行）：
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -AutoStart   # 顺便设置开机自启
#>
param([switch]$AutoStart)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgeDir = Join-Path $Root 'bridge'
$ExtDir = Join-Path $Root 'extension'
$HealthUrl = 'http://127.0.0.1:8787/health'

function Test-Bridge {
  try {
    $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 -Headers @{ 'X-DS-Bridge' = '1' }
    return [bool]$r.ok
  } catch { return $false }
}

Write-Host '=== DeepSeek ⇄ PowerShell 安装助手 ===' -ForegroundColor Cyan

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '[错误] 找不到 node.exe，请先安装 Node.js（或把 node 加进 PATH）。' -ForegroundColor Red
  Read-Host '按回车退出'
  exit 1
}

if (Test-Bridge) {
  Write-Host '[1/3] 本地桥已在运行 (127.0.0.1:8787)' -ForegroundColor Green
} else {
  Write-Host '[1/3] 启动本地桥...' -ForegroundColor Yellow
  Start-Process -FilePath $node.Source -ArgumentList 'server.js' -WorkingDirectory $BridgeDir -WindowStyle Hidden
  Start-Sleep -Milliseconds 1200
  if (-not (Test-Bridge)) {
    Write-Host '[错误] 桥启动失败，请手动双击 bridge\start-bridge.bat 查看报错。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
  }
  Write-Host '      已启动：http://127.0.0.1:8787' -ForegroundColor Green
}

Write-Host '[2/3] 打开扩展目录和 Edge 扩展页...' -ForegroundColor Yellow
Start-Process explorer.exe $ExtDir

$edgeExe = $null
$edgeCmd = Get-Command msedge.exe -ErrorAction SilentlyContinue
if ($edgeCmd) { $edgeExe = $edgeCmd.Source }
if (-not $edgeExe) { $edgeExe = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }
if (Test-Path $edgeExe) {
  Start-Process -FilePath $edgeExe -ArgumentList 'edge://extensions/'
  Start-Sleep -Milliseconds 600
  Start-Process -FilePath $edgeExe -ArgumentList 'https://chat.deepseek.com/'
} else {
  Write-Host '      没找到 msedge.exe，请手动打开 Edge。' -ForegroundColor DarkYellow
}

if ($AutoStart) {
  Write-Host '[3/3] 设置开机自启...' -ForegroundColor Yellow
  $startup = [Environment]::GetFolderPath('Startup')
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut((Join-Path $startup 'DeepSeek-Pwsh-Bridge.lnk'))
  $lnk.TargetPath = 'wscript.exe'
  $lnk.Arguments = '"' + (Join-Path $BridgeDir 'start-bridge-hidden.vbs') + '"'
  $lnk.WorkingDirectory = $BridgeDir
  $lnk.Save()
  Write-Host '      已加入启动文件夹。' -ForegroundColor Green
} else {
  Write-Host '[3/3] 跳过开机自启（需要的话加 -AutoStart）' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '接下来在 Edge 扩展页里：' -ForegroundColor Cyan
Write-Host '  1. 打开右下角「开发人员模式」'
Write-Host '  2. 点「加载解压缩的扩展」，选择打开的 extension 文件夹'
Write-Host '  3. 回到 chat.deepseek.com，右下角会出现 DeepSeek ⇄ PowerShell 面板'
Write-Host '  4. 点面板里的「发送规则」，然后正常提问即可自动循环'
Write-Host ''
Read-Host '按回车关闭此窗口'
