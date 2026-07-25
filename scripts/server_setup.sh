#!/bin/bash
# JSC 系统服务器环境准备脚本
# 在 Ubuntu 服务器上创建 jsc 用户并安装 Node.js 22 + pnpm

set -e

echo "=== JSC 系统服务器环境准备 ==="
echo ""

# 1. 创建 jsc 用户（如果不存在）
if id jsc &>/dev/null; then
    echo "✓ 用户 jsc 已存在"
else
    echo "→ 创建 jsc 用户..."
    adduser --disabled-password --gecos "JSC System User" jsc
    echo "✓ 用户 jsc 创建成功"
fi

# 2. 创建目录结构
echo ""
echo "→ 创建目录结构..."
mkdir -p /opt/jsc
mkdir -p /data/jsc
chown -R jsc:jsc /opt/jsc /data/jsc
echo "✓ 目录创建成功：/opt/jsc/, /data/jsc/"

# 3. 为 jsc 用户安装 nvm 和 Node.js 22
echo ""
echo "→ 为 jsc 用户安装 nvm 和 Node.js 22..."
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
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    
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
    
    # 验证
    echo ""
    echo "=== 安装验证 ==="
    node --version
    npm --version
    pnpm --version
'

echo ""
echo "=== 环境准备完成 ==="
echo "✓ jsc 用户已创建"
echo "✓ Node.js 22 已安装"
echo "✓ pnpm 已安装"
echo "✓ 目录结构已创建：/opt/jsc/, /data/jsc/"
