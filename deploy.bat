@echo off
:: Thin wrapper — all the real logic lives in the cross-platform CLI.
:: Equivalent anywhere: node devin-web.mjs deploy
setlocal
cd /d %~dp0
node devin-web.mjs deploy
