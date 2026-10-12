# 列出当前 Windows VM 微信登录后的所有会话名(群+好友)
# 用法: 在 PowerShell 里运行, 输出到 C:\wxbridge\wx_groups.txt
#   路径写法: powershell -ExecutionPolicy Bypass -File C:\wxbridge\deploy\list_groups.ps1
# 或者 RDP 自动化里 clipboard 粘贴执行

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms

# 优先 wxauto4, 退化 wxauto
$WeChatCls = $null
foreach ($mod in @('wxauto4', 'wxauto')) {
    try {
        $m = Import-Module $mod -PassThru -ErrorAction Stop
        $WeChatCls = [scriptblock]::Create("([$mod.WeChat])").InvokeReturnAsIs()
        Write-Host "使用模块: $mod"
        break
    } catch {
        Write-Host "import $mod 失败: $($_.Exception.Message)"
    }
}
if (-not $WeChatCls) { Write-Host "ERROR: 未找到 wxauto4/wxauto"; exit 1 }

try {
    $w = $WeChatCls.Invoke()
} catch {
    Write-Host "ERROR: 微信客户端未启动或未登录: $($_.Exception.Message)"
    exit 2
}

# 列出会话
try {
    $sessions = $w.GetSessionList()
} catch {
    Write-Host "ERROR: GetSessionList 失败: $($_.Exception.Message)"
    exit 3
}

$lines = @()
$lines += "# 微信会话列表 (生成于 $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))"
$lines += "# 共 $($sessions.Count) 个会话"
$lines += "# 格式: TYPE | NAME"
$lines += "TYPE | NAME"
$count = 0
foreach ($s in $sessions) {
    $name = if ($s -is [string]) { $s } elseif ($s.PSObject.Properties['name']) { $s.name } else { $s.ToString() }
    # wxauto 用特殊前缀标记群(★ 或 @ 符号等), 这里保守按"包含人名特征"判断
    $type = if ($name -match '[\u4e00-\u9fa5]群$' -or $name -match '^\@' -or $name -match '微信群') { 'GROUP' } else { 'PERSON' }
    $lines += "$type | $name"
    $count++
}
$lines += "# 实际列出: $count"

$out = "C:\wxbridge\wx_groups.txt"
$lines | Out-File -FilePath $out -Encoding utf8
Write-Host "已保存到 $out, 共 $count 个会话"

# 同时复制到 \\tsclient\WX 供 RDP 自动化读回
try {
    Copy-Item $out "\\tsclient\WX\wx_groups.txt" -Force
    Write-Host "已复制到 \\tsclient\WX\wx_groups.txt"
} catch {
    Write-Host "WARN: 复制到共享失败(不影响主输出): $($_.Exception.Message)"
}
