@echo off
rem start_bridge.cmd —— 桥服务启动包装（给计划任务用，避免 /TR 里塞复杂引号）
set WXBRIDGE_SEND_MODE=worker
set PYTHONIOENCODING=utf-8
cd /d C:\wxbridge
start "" /b "C:\Program Files\Python311\python.exe" "C:\wxbridge\wechat_bot_server.py" --port 18888
exit /b 0
