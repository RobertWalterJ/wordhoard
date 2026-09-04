@echo off
title Check Wordhoard
cd /d "%~dp0"
echo.
echo   Checking the vocabulary estimator against simulated respondents
echo   of known ability. Bias and interval coverage should both read "ok".
echo.
set NODE="C:\Program Files\nodejs\node.exe"
if not exist %NODE% set NODE=node
%NODE% build\check_estimator.mjs
echo.
pause
