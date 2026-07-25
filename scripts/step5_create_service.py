#!/usr/bin/env python3
"""
Step 5.1: 创建JSC后端systemd服务文件
"""

import paramiko
import sys

# 服务器配置
HOST = '111.10.220.226'
PORT = 22
USERNAME = 'root'
PASSWORD = 'Chyy#3068'

def create_ssh_client():
    """创建SSH连接"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, port=PORT, username=USERNAME, password=PASSWORD, timeout=10)
    return client

def execute_command(client, command):
    """执行命令并输出结果"""
    print(f"\n执行: {command}")
    
    stdin, stdout, stderr = client.exec_command(command, get_pty=True)
    
    # 实时输出
    while True:
        if stdout.channel.recv_ready():
            output = stdout.channel.recv(4096).decode('utf-8', errors='ignore')
            print(output, end='')
        if stderr.channel.recv_ready():
            error = stderr.channel.recv(4096).decode('utf-8', errors='ignore')
            print(error, end='', file=sys.stderr)
        if stdout.channel.exit_status_ready():
            break
    
    exit_status = stdout.channel.recv_exit_status()
    return exit_status

def main():
    """主函数"""
    print("Step 5.1: 创建systemd服务文件")
    
    try:
        # 创建SSH连接
        client = create_ssh_client()
        print("✓ SSH连接成功")
        
        # 创建systemd服务文件内容
        service_content = '''[Unit]
Description=JSC Backend Service
After=network.target

[Service]
Type=simple
User=jsc
WorkingDirectory=/opt/jsc/backend
ExecStart=/home/jsc/.nvm/versions/node/v22.22.3/bin/node index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
'''
        
        # 写入服务文件
        print("\n创建服务文件...")
        stdin, stdout, stderr = client.exec_command(f"cat > /tmp/jsc-backend.service << 'EOF'\n{service_content}EOF", get_pty=True)
        stdin.close()
        
        # 移动到systemd目录
        execute_command(client, "mv /tmp/jsc-backend.service /etc/systemd/system/")
        execute_command(client, "chmod 644 /etc/systemd/system/jsc-backend.service")
        
        # 重新加载systemd
        execute_command(client, "systemctl daemon-reload")
        
        # 验证服务文件
        print("\n验证服务文件:")
        execute_command(client, "ls -la /etc/systemd/system/jsc-backend.service")
        execute_command(client, "cat /etc/systemd/system/jsc-backend.service")
        
        print("\n✓ Step 5.1 完成: systemd服务文件已创建")
        
        client.close()
        
    except Exception as e:
        print(f"\n✗ 错误: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
