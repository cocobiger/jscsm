# -*- coding: utf-8 -*-
"""
wx_front.py —— 在 VM 的交互式会话里把微信窗口提到前台，并输出机器可读的判定行。

背景（为什么要这个脚本）：
  * bring_wx_front3.ps1 是 2026-08-31 为微信 4.0.5（旧类名）写的，微信 4.1.13.12 改用 Qt
    自绘（窗口类 = Qt51514QWindowIcon）⇒ 旧脚本找不到窗口。
  * 实测教训（2026-10-12）：光调 SetForegroundWindow 有时**不生效**（Windows 前台锁），
    此时按窗口 rect 去 scrot，会截到压在上面的浏览器 ⇒ 截图内容错位。
    本脚本改为 AttachThreadInput 抢输入队列 + 多次重试，并**明确报告是否真的抢到前台**。

输出：C:\\wxbridge\\deploy\\wx_front_out.txt（UTF-8，含诊断清单 + 末尾 VERDICT 行）
VERDICT 行格式（供 Linux 侧守护解析，勿改字段名/顺序）：
  VERDICT fronted=1 found=1 hwnd=852498 fg=852498 vis=1 rect=(572,240,868,628)

字段语义（Linux 侧据此判断登录态）：
  found=0  ⇒ 屏幕上**找不到**微信窗口（微信没起来/崩了）—— 与"已登录"是两回事，别混淆
  found=1 且 rect 尺寸 == 296x388  ⇒ 处在**登录界面**（未登录）
  found=1 且 rect 尺寸 != 296x388  ⇒ 大概率**已登录**（主界面）
"""
import ctypes
import sys
import time

import win32gui

OUT = r"C:\wxbridge\deploy\wx_front_out.txt"

SW_RESTORE, SW_SHOW = 9, 5
HWND_TOPMOST, HWND_NOTOPMOST = -1, -2
SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW = 0x0002, 0x0001, 0x0040

KEY = ("weixin", "wechat", "\u5fae\u4fe1")   # weixin / wechat / 微信

lines = []


def log(msg):
    s = str(msg)
    lines.append(s)
    try:
        print(s)
    except Exception:
        pass


def flush():
    try:
        with open(OUT, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    except Exception as e:
        try:
            print("write log failed:", e)
        except Exception:
            pass


def enum_all():
    out = []

    def cb(hwnd, _):
        try:
            if not win32gui.IsWindow(hwnd):
                return True
            out.append((
                hwnd,
                win32gui.GetClassName(hwnd),
                win32gui.GetWindowText(hwnd),
                win32gui.GetWindowRect(hwnd),
                bool(win32gui.IsWindowVisible(hwnd)),
            ))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(cb, None)
    return out


def front(user32, k32, hwnd, attempts=6):
    """把 hwnd 抢到前台；返回 (是否成功, 抢完后的前台句柄)"""
    for i in range(attempts):
        try:
            if win32gui.IsIconic(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)
            else:
                user32.ShowWindow(hwnd, SW_SHOW)
            time.sleep(0.25)

            # Windows 前台锁：直接 SetForegroundWindow 常被忽略。
            # 标准解法 = 把自己的线程输入队列 attach 到当前前台线程，再抢。
            fg = win32gui.GetForegroundWindow()
            t_fg = user32.GetWindowThreadProcessId(fg, None)
            t_me = k32.GetCurrentThreadId()
            attached = False
            if t_fg and t_fg != t_me:
                attached = bool(user32.AttachThreadInput(t_me, t_fg, True))

            user32.BringWindowToTop(hwnd)
            r = user32.SetForegroundWindow(hwnd)

            if attached:
                user32.AttachThreadInput(t_me, t_fg, False)
            time.sleep(0.35)

            # 置顶再取消置顶：把窗口从其它置顶窗口下面拽出来
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            time.sleep(0.2)
            user32.SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                                SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
            time.sleep(0.3)

            now_fg = win32gui.GetForegroundWindow()
            log("  第%d次: SetForegroundWindow=%s attach=%s -> fg=%s"
                % (i + 1, r, attached, now_fg))
            if now_fg == hwnd:
                return True, now_fg
        except Exception as e:
            log("  第%d次异常: %s %s" % (i + 1, type(e).__name__, e))
        time.sleep(0.6)

    return False, win32gui.GetForegroundWindow()


def main():
    user32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32

    log("=== wx_front 开始 ===")
    log("pid=%s" % k32.GetCurrentProcessId())
    # 先落一次盘（此时还没有 VERDICT 行）⇒ 若 Linux 侧在本次尚未结束时来读，
    # 只会读到"没有 VERDICT"，从而正确地重试，而不是误用上一次的陈旧判定。
    flush()

    wins = enum_all()
    log("窗口总数(EnumWindows) = %d" % len(wins))

    suspects = []
    log("--- 可见窗口（前 30）---")
    n = 0
    for hwnd, cls, txt, rect, vis in wins:
        low = (cls + " " + txt).lower()
        is_wx = any(k in low for k in KEY) or ("qt" in cls.lower() and txt.strip())
        if vis:
            n += 1
            if n <= 30:
                log("  hwnd=%s vis=%s cls=%r title=%r rect=%s" % (hwnd, vis, cls, txt, rect))
        if is_wx:
            suspects.append((hwnd, cls, txt, rect, vis))

    # 优先选：可见 + 类名含 Qt + 标题非空（= 微信主窗口/登录窗口）
    suspects.sort(key=lambda t: (not t[4], "qt" not in t[1].lower(), not t[2].strip()))

    log("--- 疑似微信窗口（按优先级排序）---")
    for hwnd, cls, txt, rect, vis in suspects:
        log("  * hwnd=%s vis=%s cls=%r title=%r rect=%s" % (hwnd, vis, cls, txt, rect))
    if not suspects:
        log("  （未匹配到任何微信窗口）")

    target = suspects[0][0] if suspects else 0
    ok, fg = False, 0
    if target:
        log("--- 前置 hwnd=%s ---" % target)
        ok, fg = front(user32, k32, target)

    # ── VERDICT：无论成功与否都报出"找到了没 + 真实 rect + 可见性" ──
    # 为什么失败时也要报 rect：否则 Linux 侧无法区分
    #   「没找到窗口」（微信没起来）与「找到了但抢不到前台」（内容可能被遮挡）——
    #   这两种情况的处置完全不同。
    if target:
        try:
            r = win32gui.GetWindowRect(target)
            vis = 1 if win32gui.IsWindowVisible(target) else 0
        except Exception:
            r, vis = (0, 0, 0, 0), 0
    else:
        r, vis = (0, 0, 0, 0), 0

    log("VERDICT fronted=%d found=%d hwnd=%d fg=%d vis=%d rect=(%d,%d,%d,%d)"
        % (1 if ok else 0, 1 if target else 0, target, fg, vis, r[0], r[1], r[2], r[3]))

    log("=== wx_front 结束 ===")
    flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
