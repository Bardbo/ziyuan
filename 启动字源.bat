@echo off
chcp 65001 >nul 2>&1
title 字源 - 汉字溯源之旅
cd /d "%~dp0"

echo.
echo  ============================================
echo   字源 - 汉字溯源之旅
echo   十万汉字之美，尽在此处
echo  ============================================
echo.

if not exist node_modules (
  echo  [首次运行] 正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (
    echo  [错误] 依赖安装失败，请检查网络后重试
    pause
    exit /b 1
  )
)

echo  [启动] 正在开启本地服务 http://localhost:5173/
start "" http://localhost:5173/
call npx vite --host 0.0.0.0 --port 5173

echo.
echo  [关闭] 服务已停止
pause
