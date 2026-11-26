@echo off
rem 家の PC の通訳プログラムを起動する（止まったら 10 秒後に起動し直す）
chcp 65001 > nul
set PYTHONUTF8=1
cd /d "%~dp0"
:loop
python interpret_worker.py
echo 通訳プログラムが終了しました。10 秒後に起動し直します…
timeout /t 10 /nobreak > nul
goto loop
