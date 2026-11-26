@echo off
rem WhatsApp の会話ログを取り込むプログラムを起動する（手動で起動したときだけ動く。閉じると止まる）
chcp 65001 > nul
set PYTHONUTF8=1
cd /d "%~dp0"
python whatsapp_importer.py
pause
