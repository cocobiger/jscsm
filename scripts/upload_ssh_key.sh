# 自动上传SSH公钥到Ubuntu服务器
# 需要安装 sshpass 工具

# 下载sshpass（Windows）
# 方法1：使用Chocolatey（需要先安装）
# choco install sshpass

# 方法2：使用Git Bash的sshpass
# https://github.com/keeyongchan/sshpass/releases
# 下载 sshpass-1.10-...-win.zip
# 解压后将 sshpass.exe 放到 Git Bash 的 bin 目录

# 使用方法：
# ./upload_ssh_key.sh

SERVER_HOST="111.10.220.226"
SERVER_PORT="22"
SERVER_USER="root"
SERVER_PASS="Chyy#3068"
KEY_PATH="$HOME/.ssh/id_ed25519.pub"

echo "=== 上传SSH公钥到服务器 ==="
echo "服务器: $SERVER_USER@$SERVER_HOST:$SERVER_PORT"
echo "公钥: $KEY_PATH"
echo ""

# 检查sshpass是否安装
if ! command -v sshpass &> /dev/null; then
    echo "✗ sshpass未安装"
    echo ""
    echo "请按以下步骤安装sshpass："
    echo "1. 下载：https://github.com/keeyongchan/sshpass/releases"
    echo "2. 解压sshpass.exe到 /mingw64/bin/ 目录"
    echo "3. 重新打开Git Bash，再次运行此脚本"
    exit 1
fi

# 检查公钥是否存在
if [ ! -f "$KEY_PATH" ]; then
    echo "✗ 公钥文件不存在: $KEY_PATH"
    echo "请先生成SSH密钥：ssh-keygen -t ed25519 -C 'jsc-server-key'"
    exit 1
fi

echo "开始上传..."

# 使用sshpass上传公钥
sshpass -p "$SERVER_PASS" ssh-copy-id -i "$KEY_PATH" -o StrictHostKeyChecking=no -p $SERVER_PORT $SERVER_USER@$SERVER_HOST

if [ $? -eq 0 ]; then
    echo ""
    echo "✓ 公钥上传成功"
    echo ""
    echo "=== 测试免密登录 ==="
    ssh -o StrictHostKeyChecking=no -p $SERVER_PORT $SERVER_USER@$SERVER_HOST "echo '免密登录成功！'; hostname; whoami"
else
    echo ""
    echo "✗ 上传失败"
    exit 1
fi
