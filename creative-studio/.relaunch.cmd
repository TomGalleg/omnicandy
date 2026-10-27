@echo off
ping -n 3 127.0.0.1 >nul
start /wait "" "E:\ClaudeCraft\creative-studio\node_modules\electron\dist\electron.exe" "E:\ClaudeCraft\creative-studio"
if not exist "E:\ClaudeCraft\creative-studio\.started-ok" start "" "E:\ClaudeCraft\creative-studio\node_modules\electron\dist\electron.exe" "E:\ClaudeCraft\creative-studio"
