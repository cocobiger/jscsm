# -*- coding: utf-8 -*-
"""
wx_click.py —— 在微信登录窗上做**受控的单次鼠标点击**（只认预设名，不接受任意坐标）

为什么需要这个：
  微信 4.1.13.65 升级后，登录窗默认显示「上次登录的账号卡片」（头像 + 昵称 + 绿色「登录」按钮），
  **必须点一下「切换账号」才会出现二维码**。上一版停在这一屏，脚本抓到的"二维码"其实是头像。

🔒 安全边界（改动前必读）：
  * **只支持预设名**，坐标按目标窗口 rect 的**相对比例**算 ⇒ 窗口挪动了也不会点歪。
  * **只注入鼠标事件，绝不注入键盘** —— 历史事故是「xdotool 把整段命令敲进微信输入框并回车发出」，
    那类风险完全来自键盘注入；本脚本没有任何键盘事件。
  * 点之前三重校验：① 目标必须是**可见的小窗**（宽≤420 且 高≤460 ＝ 登录窗/提示弹窗）；
    ② 必须成功置于前台且 `GetForegroundWindow()` 等于它；③ 点完立刻把光标移回原处。
    任一条不满足 ⇒ **拒绝点击**并写日志。
  * 预设名从 `C:\\wxbridge\\deploy\\click_preset.txt` 读（避免 schtasks /TR 的引号地狱），**读完即删**，
    保证"一次请求点一次"，不会重复触发。

输出：C:\\wxbridge\\deploy\\wx_click_out.txt
"""
import ctypes
import os
import time

import win32gui

PRESET_FILE = r"C:\wxbridge\deploy\click_preset.txt"
OUT = r"C:\wxbridge\deploy\wx_click_out.txt"

# 预设：相对窗口的 (x 比例, y 比例)。全部来自实测截图（登录窗 296x388）。
PRESETS = {
    'switch_account': (0.298, 0.863),   # 「切换账号」→ 出二维码
    'login':          (0.467, 0.736),   # 「登录」→ 用记住的账号直接登录
    'acknowledge':    (0.500, 0.740),   # 「我知道了」→ 关掉"已在别处登录"提示弹窗
}
LOGIN_UI_MAX = (420, 460)               # 与桥/守护保持一致：小窗＝登录窗或提示弹窗
SW_RESTORE, SW_SHOW = 9, 5

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
    except Exception:
        pass


def main():
    log("=== wx_click 开始 ===")
    if not os.path.exists(PRESET_FILE):
        log("没有 %s ⇒ 无点击请求，直接退出（这是正常的）" % PRESET_FILE)
        flush()
        return 0
    preset = ""
    try:
        with open(PRESET_FILE, encoding="utf-8", errors="ignore") as f:
            raw = (f.read() or "").strip()
        if raw:
            preset = raw.splitlines()[0].strip()
    except Exception as e:
        log("读 preset 文件失败: %r" % e)
    try:
        os.remove(PRESET_FILE)
    except Exception as e:
        log("删除 preset 文件失败: %r" % e)
    preset = (preset or "").strip()
    log("预设 = %r" % preset)
    if preset not in PRESETS:
        log("!! 未知预设（只允许 %s）⇒ 拒绝点击" % " / ".join(PRESETS.keys()))
        flush()
        return 1
    rx, ry = PRESETS[preset]

    u32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32

    # ── 1) 找目标：可见的小窗（登录窗/弹窗）──
    cands = []

    def _cb(h, _l):
        try:
            if not win32gui.IsWindowVisible(h):
                return True
            cls = win32gui.GetClassName(h)
            txt = win32gui.GetWindowText(h)
            low = (cls + " " + txt).lower()
            if not (('qt' in cls.lower() and txt.strip()) or '微信' in txt or 'weixin' in low):
                return True
            r = win32gui.GetWindowRect(h)
            w, hh = r[2] - r[0], r[3] - r[1]
            if w <= LOGIN_UI_MAX[0] and hh <= LOGIN_UI_MAX[1]:
                cands.append((h, cls, txt, r, w, hh))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(_cb, None)
    for c in cands:
        log("  候选小窗 hwnd=%s cls=%r title=%r rect=%s size=%dx%d" % (c[0], c[1], c[2], c[3], c[4], c[5]))
    if not cands:
        log("!! 找不到可见的微信小窗（登录窗/弹窗）⇒ 拒绝点击")
        flush()
        return 1
    hwnd, cls, txt, rect, w, hh = cands[0]

    # ── 2) 置前台并确认 ──
    if win32gui.IsIconic(hwnd):
        u32.ShowWindow(hwnd, SW_RESTORE)
    else:
        u32.ShowWindow(hwnd, SW_SHOW)
    time.sleep(0.3)
    fg = win32gui.GetForegroundWindow()
    t_fg = u32.GetWindowThreadProcessId(fg, None)
    t_me = k32.GetCurrentThreadId()
    attached = False
    if t_fg and t_fg != t_me:
        attached = bool(u32.AttachThreadInput(t_me, t_fg, True))
    u32.BringWindowToTop(hwnd)
    u32.SetForegroundWindow(hwnd)
    if attached:
        u32.AttachThreadInput(t_me, t_fg, False)
    time.sleep(0.4)
    now_fg = win32gui.GetForegroundWindow()
    log("  置前台：target=%s  fg=%s  %s" % (hwnd, now_fg, "OK" if now_fg == hwnd else "失败"))
    if now_fg != hwnd:
        log("!! 无法把目标窗口置于前台 ⇒ 拒绝点击（避免点到别的窗口）")
        flush()
        return 1

    rect = win32gui.GetWindowRect(hwnd)      # 重新取一次（可能刚被恢复）
    x = int(rect[0] + (rect[2] - rect[0]) * rx)
    y = int(rect[1] + (rect[3] - rect[1]) * ry)
    log("  目标坐标 = (%d, %d)   窗口 rect=%s" % (x, y, rect))

    # ── 3) 单次左键点击（只动鼠标；点完把光标移回原处）──
    import ctypes.wintypes as wt
    old = wt.POINT()
    u32.GetCursorPos(ctypes.byref(old))
    u32.SetCursorPos(x, y)
    time.sleep(0.15)
    u32.mouse_event(0x0002, 0, 0, 0, 0)      # MOUSEEVENTF_LEFTDOWN
    time.sleep(0.08)
    u32.mouse_event(0x0004, 0, 0, 0, 0)      # MOUSEEVENTF_LEFTUP
    time.sleep(0.35)
    u32.SetCursorPos(old.x, old.y)           # 光标归位，减少对后续操作的影响
    log("CLICK preset=%s at=(%d,%d) window=%dx%d → 已发出单击" % (preset, x, y, rect[2] - rect[0], rect[3] - rect[1]))

    log("=== wx_click 结束 ===")
    flush()
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
