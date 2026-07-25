#!/usr/bin/env python3
"""
通过 SSH 检查 Ubuntu 服务器上的 jsc 用户环境
"""
import paramiko
import sys

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

def check_server_status():
    """检查服务器状态"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 检查命令
        checks = [
            ('检查 jsc 用户', 'id jsc'),
            ('检查 /opt/jsc 目录', 'ls -la /opt/jsc/'),
            ('检查 /data/jsc 目录', 'ls -la /data/jsc/'),
            ('检查 jsc 用户的 Node.js', 'su - jsc -c "which node && node --version"'),
            ('检查 jsc 用户的 npm', 'su - jsc -c "which npm && npm --version"'),
            ('检查 jsc 用户的 pnpm', 'su - jsc -c "which pnpm && pnpm --version"'),
            ('检查 jsc 用户的 nvm', 'su - jsc -c "ls -la ~/.nvm/"'),
        ]
        
        for desc, cmd in checks:
            print(f"→ {desc}...")
            stdin, stdout, stderr = client.exec_command(cmd, timeout=30)
            output = stdout.read().decode('utf-8').strip()
            error = stderr.read().decode('utf-8').strip()
            
            if output:
                print(f"  {output}")
            if error:
                print(f"  ⚠️  {error}")
            
            if not output and not error:
                print("  ✗ 未安装或不存在")
            print()
        
        print("=== 检查完成 ===")
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        sys.exit(1)
    finally:
        client.close()

if __name__ == '__main__':
    check_server_status()
