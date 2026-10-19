@echo off
setlocal
cd /d D:\yotal\Documents\Projects\devin-workbench-local

echo [1/4] build
call npm run build
if errorlevel 1 (echo BUILD FAILED & pause & exit /b 1)

echo [2/4] free port 7791 (old server)
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 7791 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force }"

echo [3/4] kill orphaned devin acp processes (parent dead only)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='devin.exe'\" | Where-Object { $_.CommandLine -match 'acp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"

echo [4/4] start server
set DEVIN_REMOTE_ALLOWED_HOSTS=192.168.6.251:7791,devin.zalize.com,devin-local.zalize.com
node dist\server\index.js --host 0.0.0.0 --port 7791
