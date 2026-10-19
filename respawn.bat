@echo off
rem Thin shim for the previous build's spawn (cmd /c respawn.bat) — all real
rem logic lives in scripts/respawn.mjs (pure node: wait port, clean orphan acp,
rem start detached, log everything to <dataDir>/). New builds spawn the .mjs
rem directly; this file only keeps the old entry point working.
cd /d "%~dp0"
node scripts\respawn.mjs "%~dp0." 7791
