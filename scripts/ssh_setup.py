#!/usr/bin/env python3
"""
通过 SSH 在 Ubuntu 服务器上执行环境准备
"""
import paramiko
import sys

# 服务器信息
HOST = '111.10.220.226'
PORT = 22  # SSH 端口（根据您的要求使用 22）
USER = 'root'
PASS = 'Chyy#3068'

def run_setup_commands():
    """执行环境准备命令"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 要执行的命令
        commands = [
            # 1. 创建 jsc 用户
            ('创建 jsc 用户', '''
                if id jsc &>/dev/null; then
                    echo "✓ 用户 jsc 已存在"
                else
                    adduser --disabled-password --gecos "JSC System User" jsc
                    echo "✓ 用户 jsc 创建成功"
                fi
            '''),
            
            # 2. 创建目录结构
            ('创建目录结构', '''
                mkdir -p /opt/jsc
                mkdir -p /data/jsc
                chown -R jsc:jsc /opt/jsc /data/jsc
                echo "✓ 目录创建成功：/opt/jsc/, /data/jsc/"
            '''),
            
            # 3. 为 jsc 用户安装 nvm 和 Node.js 22
            ('安装 nvm 和 Node.js 22', '''
                su - jsc -c '
                    # 安装 nvm
                    if [ ! -d "$HOME/.nvm" ]; then
                        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
                        echo "✓ nvm 安装成功"
                    else
                        echo "✓ nvm 已安装"
                    fi
                    
                    # 加载 nvm
                    export NVM_DIR="$HOME/.nvm"
                    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
                    
                    # 安装 Node.js 22
                    if ! nvm which 22 &>/dev/null; then
                        echo "→ 安装 Node.js 22..."
                        nvm install 22
                        nvm alias default 22
                        echo "✓ Node.js 22 安装成功"
                    else
                        echo "✓ Node.js 22 已安装"
                    fi
                    
                    # 安装 pnpm
                    if ! command -v pnpm &>/dev/null; then
                        echo "→ 安装 pnpm..."
                        npm install -g pnpm
                        echo "✓ pnpm 安装成功"
                    else
                        echo "✓ pnpm 已安装"
                    fi
                '
            '''),
            
            # 4. 验证安装
            ('验证安装', '''
                su - jsc -c '
                    export NVM_DIR="$HOME/.nvm"
                    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
                    echo "=== 安装验证 ==="
                    echo "Node.js: $(node --version)"
                    echo "npm: $(npm --version)"
                    echo "pnpm: $(pnpm --version)"
                '
            '''),
        ]
        
        # 执行命令
        for desc, cmd in commands:
            print(f"\n{'='*60}")
            print(f"→ {desc}...")
            print(f"{'='*60}")
            
            stdin, stdout, stderr = client.exec_command(cmd, timeout=300)
            output = stdout.read().decode('utf-8')
            error = stderr.read().decode('utf-8')
            
            if output:
                print(output)
            if error and 'ERROR' not in error.upper():
                print(error)
            
            # 检查退出状态
            exit_status = stdout.channel.recv_exit_status()
            if exit_status != 0:
                print(f"⚠️  命令执行失败 (退出码: {exit_status})")
                if error:
                    print(f"错误: {error}")
        
        print(f"\n{'='*60}")
        print("✓ 环境准备完成")
        print(f"{'='*60}")
        
        # 最终验证
        print("\n→ 最终验证...")
        stdin, stdout, stderr = client.exec_command('''
            su - jsc -c '
                export NVM_DIR="$HOME/.nvm"
                [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
                echo "Node.js: $(node --version)"
                echo "npm: $(npm --version)"
                echo "pnpm: $(pnpm --version)"
                echo ""
                echo "目录结构:"
                ls -la /opt/jsc/
                ls -la /data/jsc/
            '
        ''', timeout=30)
        
        print(stdout.read().decode('utf-8'))
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        sys.exit(1)
    finally:
        client.close()
        print("\n→ SSH 连接已关闭")

if __name__ == '__main__':
    run_setup_commands()
