@echo off
rem Run the WeChat login-state probe inside the INTERACTIVE desktop session.
rem Must run in the same session as the WeChat client (WMI-spawned processes land
rem in session 0 and cannot see the interactive desktop / WeChat windows).
cd /d C:\wxbridge\deploy
"C:\Program Files\Python311\python.exe" "C:\wxbridge\deploy\wx_login_probe.py" > "C:\wxbridge\deploy\wx_login_probe_console.txt" 2>&1
exit /b 0
