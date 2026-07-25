# 上传SSH公钥到Ubuntu服务器
# 用法：powershell -ExecutionPolicy Bypass -File upload_ssh_key.ps1

$keyPath = "$env:USERPROFILE\.ssh\id_ed25519.pub"
$serverHost = "111.10.220.226"
$serverPort = 22
$username = "root"
$password = "Chyy#3068"

# 读取公钥
$publicKey = Get-Content $keyPath
Write-Host "公钥内容: $publicKey" -ForegroundColor Cyan
Write-Host ""

# 创建SSH会话
Write-Host "正在连接到 $serverHost..." -ForegroundColor Yellow
$session = New-SSHSession -ComputerName $serverHost -Port $serverPort -Credential (New-Object PSCredential($username, (ConvertTo-SecureString $password -AsPlainText -Force)))

if ($session) {
    Write-Host "✓ 连接成功" -ForegroundColor Green

    # 创建.ssh目录
    Write-Host "创建.ssh目录..." -ForegroundColor Yellow
    Invoke-SSHCommand -SessionId $session.SessionId -Command "mkdir -p ~/.ssh && chmod 700 ~/.ssh"

    # 备份现有authorized_keys
    Write-Host "备份现有authorized_keys..." -ForegroundColor Yellow
    Invoke-SSHCommand -SessionId $session.SessionId -Command "cp ~/.ssh/authorized_keys ~/.ssh/authorized_keys.bak 2>/dev/null || true"

    # 检查密钥是否已存在
    $checkCmd = "grep -F '$publicKey' ~/.ssh/authorized_keys && echo 'EXISTS' || echo 'NOT_EXISTS'"
    $result = Invoke-SSHCommand -SessionId $session.SessionId -Command $checkCmd
    $output = $result.Output

    if ($output -match "EXISTS") {
        Write-Host "✓ 公钥已存在于服务器，跳过添加" -ForegroundColor Green
    } else {
        # 添加公钥
        Write-Host "添加公钥到服务器..." -ForegroundColor Yellow
        $addCmd = "echo '$publicKey' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
        Invoke-SSHCommand -SessionId $session.SessionId -Command $addCmd
        Write-Host "✓ 公钥添加成功" -ForegroundColor Green
    }

    # 验证
    Write-Host ""
    Write-Host "验证authorized_keys内容:" -ForegroundColor Yellow
    Invoke-SSHCommand -SessionId $session.SessionId -Command "cat ~/.ssh/authorized_keys"

    # 关闭会话
    Remove-SSHSession -SessionId $session.SessionId | Out-Null
    Write-Host ""
    Write-Host "✓ 完成" -ForegroundColor Green
} else {
    Write-Host "✗ 连接失败" -ForegroundColor Red
    exit 1
}
