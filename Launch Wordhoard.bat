@echo off
title Wordhoard
cd /d "%~dp0"
echo.
echo   Wordhoard - starting the local server.
echo   Keep this window open; closing it stops the app.
echo.
set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node
start "" http://localhost:8791
%NODE% server.mjs
echo.
echo   Server stopped. Press any key to close.
pause >nul
