# 上传SSH公钥到Ubuntu服务器
# 使用PowerShell原生SSH功能

# 读取公钥
$keyPath = "$env:USERPROFILE\.ssh\id_ed25519.pub"
$publicKey = Get-Content $keyPath -Raw
$publicKey = $publicKey.Trim()

Write-Host "=== SSH公钥上传工具 ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "公钥内容: $publicKey" -ForegroundColor Yellow
Write-Host ""

# 方法1: 尝试使用SSH客户端
$server = "root@111.10.220.226"
$password = "Chyy#3068"

Write-Host "请手动复制以下命令到PowerShell中执行（交互式输入密码）：" -ForegroundColor Green
Write-Host ""
Write-Host "ssh $server" -ForegroundColor White
Write-Host "  密码: $password" -ForegroundColor Gray
Write-Host ""
Write-Host "登录后执行：" -ForegroundColor Green
Write-Host ""
Write-Host "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$publicKey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo '公钥上传完成' && exit" -ForegroundColor White
Write-Host ""

# 方法2: 尝试使用Windows的ssh.exe（如果PATH中有）
Write-Host "=== 方法2: 使用Windows ssh.exe ===" -ForegroundColor Cyan
$winSsh = (Get-Command ssh.exe -ErrorAction SilentlyContinue).Source
if ($winSsh) {
    Write-Host "找到ssh.exe: $winSsh" -ForegroundColor Green

    # 创建一个临时脚本，通过expect-like方式处理
    $scriptContent = @"
`$pubkey = Get-Content '$keyPath' -Raw
`$pubkey = `$pubkey.Trim()

# 使用ssh.exe执行远程命令（需要交互式输入密码）
# 我们用一个简单的方法：直接在服务器上添加公钥
Write-Host "请在弹出的SSH窗口中输入密码: $password" -ForegroundColor Yellow
ssh $server "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '`$pubkey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
"@

    Write-Host $scriptContent -ForegroundColor Gray
} else {
    Write-Host "未找到ssh.exe" -ForegroundColor Red
}

Write-Host ""
Write-Host "=== 一键脚本（复制到PowerShell中执行） ===" -ForegroundColor Cyan
Write-Host @"

`$pubkey = Get-Content '$keyPath' -Raw
`$pubkey = `$pubkey.Trim()
Write-Host "公钥: `$pubkey"

# 提示用户输入密码（安全性考虑）
`$securePwd = Read-Host "请输入服务器密码" -AsSecureString
`$cred = New-Object PSCredential('root', `$securePwd)

# 远程执行命令
`$session = New-SSHSession -ComputerName '111.10.220.226' -Port 22 -Credential `$cred -AcceptKey `$true
if (`$session) {
    Invoke-SSHCommand -SessionId `$session.SessionId -Command "mkdir -p ~/.ssh && chmod 700 ~/.ssh"
    Invoke-SSHCommand -SessionId `$session.SessionId -Command "echo '`$pubkey' >> ~/.ssh/authorized_keys"
    Invoke-SSHCommand -SessionId `$session.SessionId -Command "chmod 600 ~/.ssh/authorized_keys"
    Invoke-SSHCommand -SessionId `$session.SessionId -Command "cat ~/.ssh/authorized_keys"
    Remove-SSHSession -SessionId `$session.SessionId
    Write-Host "✓ 公钥上传成功" -ForegroundColor Green
} else {
    Write-Host "✗ SSH连接失败" -ForegroundColor Red
}

"@ -ForegroundColor White
