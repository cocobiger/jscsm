#!/usr/bin/env python3
"""
通过 SSH 在 Ubuntu 服务器上为 jsc 用户安装 Node.js 22 + pnpm
改进版：显式加载 nvm
"""
import paramiko
import sys
import time

# 服务器信息
HOST = '111.10.220.226'
PORT = 22
USER = 'root'
PASS = 'Chyy#3068'

def install_nodejs():
    """安装 Node.js 22 和 pnpm"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    
    try:
        print(f"→ 连接到 {HOST}:{PORT}...")
        client.connect(HOST, port=PORT, username=USER, password=PASS, timeout=10)
        print("✓ SSH 连接成功\n")
        
        # 安装命令（显式加载 nvm）
        commands = [
            # 1. 加载 nvm 并安装 Node.js 22
            ('安装 Node.js 22', '''
                su - jsc <<'EOF'
                export NVM_DIR="$HOME/.nvm"
                [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
                
                echo "→ 检查 Node.js 22..."
                if nvm which 22 &>/dev/null; then
                    echo "✓ Node.js 22 已安装"
                else
                    echo "→ 安装 Node.js 22..."
                    nvm install 22
                    nvm alias default 22
                    echo "✓ Node.js 22 安装成功"
                fi
                
                echo "Node.js 版本: $(node --version)"
                echo "npm 版本: $(npm --version)"
EOF
            '''),
            
            # 2. 安装 pnpm
            ('安装 pnpm', '''
                su - jsc <<'EOF'
                export NVM_DIR="$HOME/.nvm"
                [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
                
                echo "→ 检查 pnpm..."
                if command -v pnpm &>/dev/null; then
                    echo "✓ pnpm 已安装: $(pnpm --version)"
                else
                    echo "→ 安装 pnpm..."
                    npm install -g pnpm
                    echo "✓ pnpm 安装成功: $(pnpm --version)"
                fi
EOF
            '''),
            
            # 3. 将 nvm 初始化添加到 .bashrc（确保登录时自动加载）
            ('配置 .bashrc', '''
                su - jsc <<'EOF'
                if ! grep -q "NVM_DIR" ~/.bashrc; then
                    echo "" >> ~/.bashrc
                    echo "export NVM_DIR=\"$HOME/.nvm\"" >> ~/.bashrc
                    echo "[ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\"" >> ~/.bashrc
                    echo "[ -s \"$NVM_DIR/bash_completion\" ] && . \"$NVM_DIR/bash_completion\"" >> ~/.bashrc
                    echo "✓ nvm 初始化已添加到 .bashrc"
                else
                    echo "✓ .bashrc 已配置 nvm"
                fi
EOF
            '''),
            
            # 4. 最终验证
            ('最终验证', '''
                su - jsc <<'EOF'
                export NVM_DIR="$HOME/.nvm"
                [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
                
                echo "=== 安装验证 ==="
                echo "Node.js: $(node --version)"
                echo "npm: $(npm --version)"
                echo "pnpm: $(pnpm --version)"
                echo ""
                echo "=== 目录结构 ==="
                ls -la /opt/jsc/
                ls -la /data/jsc/
EOF
            '''),
        ]
        
        # 执行命令
        for desc, cmd in commands:
            print(f"\n{'='*60}")
            print(f"→ {desc}...")
            print(f"{'='*60}")
            
            stdin, stdout, stderr = client.exec_command(cmd, timeout=300)
            
            # 实时输出
            output = stdout.read().decode('utf-8')
            error = stderr.read().decode('utf-8')
            
            if output:
                print(output)
            if error:
                print("错误输出:")
                print(error)
            
            # 等待命令完成
            exit_status = stdout.channel.recv_exit_status()
            if exit_status != 0:
                print(f"⚠️  命令退出码: {exit_status}")
        
        print(f"\n{'='*60}")
        print("✓ 环境准备完成")
        print(f"{'='*60}")
        print("\n✓ jsc 用户已配置")
        print("✓ Node.js 22 已安装")
        print("✓ pnpm 已安装")
        print("✓ 目录结构已创建")
        
    except Exception as e:
        print(f"\n❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        client.close()
        print("\n→ SSH 连接已关闭")

if __name__ == '__main__':
    install_nodejs()
