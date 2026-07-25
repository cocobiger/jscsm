#!/usr/bin/env python3
"""
Step 5: 启动JSC后端服务
- 创建systemd服务文件
- 启动后端服务
- 验证服务状态
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

def execute_command(client, command, get_output=False):
    """执行命令"""
    print(f"\n{'='*60}")
    print(f"执行命令: {command}")
    print('='*60)
    
    stdin, stdout, stderr = client.exec_command(command, get_pty=True)
    
    if get_output:
        output = stdout.read().decode('utf-8')
        error = stderr.read().decode('utf-8')
        return output, error
    
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
    print(f"\n退出状态: {exit_status}")
    return exit_status

def create_systemd_service(client):
    """创建systemd服务文件"""
    print("\n步骤 5.1: 创建systemd服务文件")
    
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
    command = f"cat > /tmp/jsc-backend.service << 'EOF'\n{service_content}EOF"
    stdin, stdout, stderr = client.exec_command(command, get_pty=True)
    stdin.close()
    
    # 移动到systemd目录
    execute_command(client, "mv /tmp/jsc-backend.service /etc/systemd/system/")
    execute_command(client, "chmod 644 /etc/systemd/system/jsc-backend.service")
    
    # 重新加载systemd
    execute_command(client, "systemctl daemon-reload")
    
    print("\n✓ systemd服务文件已创建")
    return True

def start_backend_service(client):
    """启动后端服务"""
    print("\n步骤 5.2: 启动后端服务")
    
    # 启用服务
    execute_command(client, "systemctl enable jsc-backend")
    
    # 启动服务
    execute_command(client, "systemctl start jsc-backend")
    
    print("\n✓ 后端服务已启动")
    return True

def check_service_status(client):
    """检查服务状态"""
    print("\n步骤 5.3: 检查服务状态")
    
    output, error = execute_command(client, "systemctl status jsc-backend --no-pager", get_output=True)
    print(output)
    
    if error:
        print("错误输出:", error)
    
    # 检查服务是否活跃
    if "active (running)" in output:
        print("\n✓ 后端服务运行正常")
        return True
    else:
        print("\n✗ 后端服务未正常运行")
        return False

def check_backend_health(client):
    """检查后端健康检查"""
    print("\n步骤 5.4: 检查后端健康检查端点")
    
    # 等待服务启动
    import time
    time.sleep(2)
    
    # 使用curl检查健康检查端点
    output, error = execute_command(client, "curl -s http://127.0.0.1:7170/api/health || echo '无法连接'", get_output=True)
    print(f"健康检查响应: {output}")
    
    if "ok" in output.lower() or "healthy" in output.lower():
        print("\n✓ 后端健康检查通过")
        return True
    else:
        print("\n⚠ 后端健康检查未通过，但服务可能正在启动中")
        return False

def main():
    """主函数"""
    print("JSC系统迁移 - Step 5: 启动后端服务")
    print("="*60)
    
    try:
        # 创建SSH连接
        print("\n连接 to Ubuntu服务器...")
        client = create_ssh_client()
        print("✓ SSH连接成功")
        
        # 步骤5.1: 创建systemd服务文件
        create_systemd_service(client)
        
        # 步骤5.2: 启动后端服务
        start_backend_service(client)
        
        # 步骤5.3: 检查服务状态
        check_service_status(client)
        
        # 步骤5.4: 检查后端健康检查
        check_backend_health(client)
        
        # 关闭连接
        client.close()
        
        print("\n" + "="*60)
        print("Step 5 执行完成")
        print("="*60)
        
    except Exception as e:
        print(f"\n✗ 错误: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
