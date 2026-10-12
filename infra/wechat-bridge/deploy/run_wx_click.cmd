@echo off
rem One controlled mouse click on the WeChat login window (preset from click_preset.txt).
rem Must run in the INTERACTIVE desktop session so it can see / front the WeChat window.
cd /d C:/wxbridge/deploy
"C:/Program Files/Python311/python.exe" "C:/wxbridge/deploy/wx_click.py" > "C:/wxbridge/deploy/wx_click_console.txt" 2>&1
exit /b 0
