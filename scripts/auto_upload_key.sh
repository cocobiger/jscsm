#!/bin/bash
# SSH自动登录脚本 - 使用sshpass

SSHPASS="/c/Users/Administrator/AppData/Local/Microsoft/WinGet/Links/sshpass.exe"
PASSWORD_FILE="/tmp/sshpass_pwd.txt"
SERVER="root@111.10.220.226"

# 检查密码文件
if [ ! -f "$PASSWORD_FILE" ]; then
    printf 'Chyy#3068' > "$PASSWORD_FILE"
    echo "密码文件已创建"
fi

echo "=== 步骤1: 测试登录 ==="
"$SSHPASS" -f "$PASSWORD_FILE" -k -v ssh -o StrictHostKeyChecking=no -o PubkeyAuthentication=no "$SERVER" "echo '登录成功' && whoami && hostname" 2>&1 | tail -10

echo ""
echo "=== 步骤2: 上传公钥 ==="
PUBKEY=$(cat /c/Users/Administrator/.ssh/id_ed25519.pub)
echo "公钥: $PUBKEY"
echo ""

# 使用heredoc方式执行多条命令
"$SSHPASS" -f "$PASSWORD_FILE" -k ssh -o StrictHostKeyChecking=no -o PubkeyAuthentication=no "$SERVER" "
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo '$PUBKEY' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
echo '=== 验证 ==='
ls -la ~/.ssh/
cat ~/.ssh/authorized_keys
" 2>&1 | tail -30
