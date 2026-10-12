# bring_wx_front3.ps1 — 激活微信窗口 + 截图（单行 Add-Type，无 here-string，日志写本地）
$ErrorActionPreference = 'Continue'
$LogFile = 'C:\wxbridge\bring3.log'
"" | Set-Content -Path $LogFile
function W($msg) { Add-Content -Path $LogFile -Value $msg }

W "=== $(Get-Date -Format 'HH:mm:ss') bring_wx_front3 ==="

# 1) 加载 Win32 API（单行 MemberDefinition，逐个加载）
Add-Type -Name Sfw -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' -ErrorAction SilentlyContinue
Add-Type -Name Sw  -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -ErrorAction SilentlyContinue
Add-Type -Name Gr  -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out N.R r);' -ErrorAction SilentlyContinue
Add-Type -Name R   -Namespace N -TypeDefinition 'public struct R { public int L; public int T; public int Rt; public int B; }' -ErrorAction SilentlyContinue
W "win32 api loaded"

# 2) 找微信主窗口
$wx = Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $wx) {
    W "NO_WEIXIN_WINDOW"
    exit 1
}
W "Weixin pid=$($wx.Id) hwnd=$($wx.MainWindowHandle) title='$($wx.MainWindowTitle)'"

# 3) 恢复 + 前置
[N.Sw]::ShowWindow($wx.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
Start-Sleep -Milliseconds 800
[N.Sw]::ShowWindow($wx.MainWindowHandle, 5) | Out-Null   # SW_SHOW
Start-Sleep -Milliseconds 300
[N.Sfw]::SetForegroundWindow($wx.MainWindowHandle) | Out-Null
Start-Sleep -Seconds 1

# 4) 窗口矩形
$r = New-Object N.R
try {
    [N.Gr]::GetWindowRect($wx.MainWindowHandle, [ref]$r) | Out-Null
    $ww = $r.Rt - $r.L; $wh = $r.B - $r.T
    W "window_rect L=$($r.L) T=$($r.T) R=$($r.Rt) B=$($r.B) WxH=$($ww)x$($wh)"
} catch {
    W "GET_RECT_FAIL $($_.Exception.Message)"
}

# 5) 截图（全屏）
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $out = '\\tsclient\WX\wx_front3_full.png'
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    W "SAVED_FULL path=$out size=$((Get-Item $out).Length)"
} catch {
    W "SAVE_FULL_FAIL $($_.Exception.Message)"
}

# 6) 仅窗口截图
if ($r.L -ne 0 -or $r.T -ne 0 -or $r.Rt -gt $r.L) {
    $ww = $r.Rt - $r.L; $wh = $r.B - $r.T
    if ($ww -gt 50 -and $wh -gt 50) {
        try {
            $bmp2 = New-Object System.Drawing.Bitmap $ww, $wh
            $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
            $g2.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $ww, $wh))
            $out2 = '\\tsclient\WX\wx_front3_window.png'
            $bmp2.Save($out2, [System.Drawing.Imaging.ImageFormat]::Png)
            $g2.Dispose(); $bmp2.Dispose()
            W "SAVED_WINDOW path=$out2 size=$((Get-Item $out2).Length)"
        } catch {
            W "SAVE_WIN_FAIL $($_.Exception.Message)"
        }
    }
}

# 7) 前台窗口检查（用 GetForegroundWindow 单行）
Add-Type -Name Gfw -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' -ErrorAction SilentlyContinue
$fg = [N.Gfw]::GetForegroundWindow()
W "foreground_hwnd=$fg weixin_hwnd=$($wx.MainWindowHandle) match=$($fg -eq [IntPtr]$wx.MainWindowHandle)"

W "=== END ==="