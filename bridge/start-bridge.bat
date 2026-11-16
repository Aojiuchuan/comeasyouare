@echo off
chcp 65001 >nul
title DeepSeek PowerShell Bridge
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 node.exe，请先安装 Node.js 或把 node 加入 PATH。
  pause
  exit /b 1
)

node server.js

echo.
echo 桥已退出。按任意键关闭窗口...
pause >nul
