# -*- coding: utf-8 -*-
"""
wx_front.py —— 在 VM 的交互式会话里把微信窗口提到前台（并输出窗口清单供诊断）

为什么不能用旧脚本：bring_wx_front3.ps1 是 2026-08-31 为微信 4.0.5（旧类名）写的，
微信 4.1.13.12 改用 Qt 自绘，类名/层级都变了 ⇒ 旧脚本找不到窗口。
本脚本不改旧文件，另起一份：先枚举，再按"类名含 Qt / 标题含 微信|Weixin|WeChat"匹配，
然后 SW_RESTORE + SetForegroundWindow + SetWindowPos(TOPMOST→NOTOPMOST) 三步提权。

输出：C:\\wxbridge\\deploy\\wx_front_out.txt（UTF-8）
"""
import ctypes
import sys
import time
from ctypes import wintypes

import win32con
import win32gui

OUT = r"C:\wxbridge\deploy\wx_front_out.txt"
lines = []


def log(msg):
    lines.append(str(msg))
    print(msg)


def flush():
    try:
        with open(OUT, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    except Exception as e:
        print("写入日志失败:", e)


def enum_visible():
    out = []

    def cb(hwnd, _):
        try:
            if not win32gui.IsWindow(hwnd):
                return True
            vis = win32gui.IsWindowVisible(hwnd)
            cls = win32gui.GetClassName(hwnd)
            txt = win32gui.GetWindowText(hwnd)
            rect = win32gui.GetWindowRect(hwnd)
            # 也记录不可见的（微信可能最小化到托盘）
            out.append((hwnd, cls, txt, rect, vis))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(cb, None)
    return out


def main():
    log("=== wx_front 开始 ===")
    log(f"pid={ctypes.windll.kernel32.GetCurrentProcessId()}")
    try:
        log("会话 id = %s" % ctypes.windll.kernel32.WTSGetActiveConsoleSessionId())
    except Exception:
        pass

    wins = enum_visible()
    log(f"窗口总数(EnumWindows) = {len(wins)}")

    KEY = ("weixin", "wechat", "\u5fae\u4fe1")  # 微信 / weixin / wechat
    suspects = []
    log("--- 可见窗口（前 30）---")
    n = 0
    for hwnd, cls, txt, rect, vis in wins:
        low = (cls + " " + txt).lower()
        is_wx = any(k in low for k in KEY) or ("qt" in cls.lower() and txt.strip())
        if vis:
            n += 1
            if n <= 30:
                log(f"  hwnd={hwnd} vis={vis} cls={cls!r} title={txt!r} rect={rect}")
        if is_wx:
            suspects.append((hwnd, cls, txt, rect, vis))

    log("--- 疑似微信窗口 ---")
    if not suspects:
        log("  （未匹配到；下面列出全部标题非空的窗口，含不可见）")
        for hwnd, cls, txt, rect, vis in wins:
            if txt.strip():
                log(f"  hwnd={hwnd} vis={vis} cls={cls!r} title={txt!r} rect={rect}")
    for hwnd, cls, txt, rect, vis in suspects:
        log(f"  ★ hwnd={hwnd} vis={vis} cls={cls!r} title={txt!r} rect={rect}")

    # ── 前置策略 ──
    user32 = ctypes.windll.user32
    SW_RESTORE, SW_SHOW = 9, 5
    HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW = 0x0002, 0x0001, 0x0040

    done = False
    for hwnd, cls, txt, rect, vis in suspects:
        log(f"--- 尝试前置 hwnd={hwnd} title={txt!r} ---")
        try:
            if not vis:
                log("  窗口不可见 → ShowWindow(SW_SHOW)")
                user32.ShowWindow(hwnd, SW_SHOW)
                time.sleep(0.5)
            log("  ShowWindow(SW_RESTORE)")
            user32.ShowWindow(hwnd, SW_RESTORE)
            time.sleep(0.5)
            log("  SetForegroundWindow")
            r1 = user32.SetForegroundWindow(hwnd)
            log(f"    -> {r1}")
            log("  SetWindowPos(TOPMOST→NOTOPMOST)")
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            time.sleep(0.3)
            user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            time.sleep(0.5)
            log(f"  前置后 GetForegroundWindow = {win32gui.GetForegroundWindow()}  (目标 {hwnd})")
            done = True
        except Exception as e:
            log(f"  失败: {type(e).__name__} {e}")

    if not done:
        log("❌ 未能前置任何微信窗口")
    log("=== wx_front 结束 ===")
    flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
