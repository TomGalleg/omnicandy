@echo off
rem Rebuilds OmniCandi from source, then launches it. Use this after code changes;
rem the desktop shortcut launches the last build directly.
cd /d "%~dp0creative-studio"
call npx electron-vite build || (echo Build failed. & pause & exit /b 1)
call node scripts/build-planner-mcp.mjs || (echo Planner connection build failed. & pause & exit /b 1)
start "" "%~dp0creative-studio\node_modules\electron\dist\electron.exe" "%~dp0creative-studio"
