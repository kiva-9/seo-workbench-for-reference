@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title SEO 项目管理系统
:: 双击启动脚本（Windows）——需要 Node.js 24.x
cd /d "%~dp0"

:: ---------- 找 Node.js ----------
set "NODE_BIN="
where node >nul 2>nul && set "NODE_BIN=node"
if not defined NODE_BIN if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_BIN if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_BIN=%ProgramFiles(x86)%\nodejs\node.exe"

if not defined NODE_BIN (
    echo 没有找到 Node.js。
    echo 请到 https://nodejs.org 安装 Node.js 24 后再双击本文件。
    echo.
    pause
    exit /b 1
)

:: ---------- 读取 Node 版本 ----------
"%NODE_BIN%" --version > "%TEMP%\seo_nv.tmp" 2>nul
set /p NODE_VER=<"%TEMP%\seo_nv.tmp"
del /q "%TEMP%\seo_nv.tmp" 2>nul
for /f "tokens=1 delims=v." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"

:: ---------- 检查版本：Node.js 24 ----------
if %NODE_MAJOR% neq 24 goto :unsupported_node

echo 使用 Node.js %NODE_VER% 启动 SEO 项目管理系统...
echo 服务地址: http://localhost:8477
echo 按 Ctrl+C 停止服务
echo.
"%NODE_BIN%" server.js
echo.
echo 服务已停止。
pause
exit /b 0

:unsupported_node
echo 当前 Node.js 版本为 %NODE_VER%，需要 Node.js 24.x。
echo 请到 https://nodejs.org 安装 Node.js 24 后重试。
echo.
pause
exit /b 1