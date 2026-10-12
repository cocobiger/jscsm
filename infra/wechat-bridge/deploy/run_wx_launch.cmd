@echo off
rem Launch the WeChat client inside the INTERACTIVE desktop session.
rem Used as a fallback to reset the login QR code when the UI freezes.
rem Why a separate .cmd wrapper: complex quoted commands inside
rem schtasks /TR get mangled by cmd.exe parsing.
start "" "C:\Program Files\Tencent\Weixin\Weixin.exe"
exit /b 0
