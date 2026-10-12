#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信登录二维码保活守护（运行在 Linux 跳板机 226 上）

问题：用户扫的是【截图】，截图与扫描之间隔了几分钟 ⇒ 二维码已过期 ⇒ 反复"失效"。
目标：在【微信未登录】期间，让屏幕上永远有一张新鲜二维码可截取（码龄 <= FRONT_EVERY 秒），
      并在「画面连续静止超过 FREEZE_SEC」时自动重启微信客户端重新出码（兜底重置）。
      一旦检测到已登录（/health 的 driver/wechat_version/sessions 非 null），立即停止一切动作。

设计要点 / 取舍：
  * 不用「定时重启客户端」做主手段：微信对频繁的登录二维码请求有风控嫌疑，
    且重启会打断「已扫码、正在手机上确认」的窗口期。
  * 只把「窗口前置」当主手段：无副作用，且能让微信自身的过期自动换码机制正常工作。
  * 「重启」仅作兜底，且必须满足「画面 6 分钟没变」+ 冷却 5 分钟 + 每小时 <= 6 次，三重护栏。

判据提醒（踩过的坑）：
  * /health 里的 wx:"connected" 是内存态假健康，不能判断登录；只有 driver/sessions/wechat_version
    这三项非 null 才代表驱动真的起来了。
  * wx_front_out.txt 里同时列出了屏幕**其他**窗口的 rect ⇒ 必须只认 VERDICT 行。
  * 前置动作是异步的（计划任务）⇒ 触发前**先删掉输出文件**，否则会读到上一次的陈旧 VERDICT，
    导致"以为抢到前台了、其实没有"，进而按窗口 rect 截到压在上面的浏览器（静默错图）。
  * 截回来的图必须**验证内容真的是二维码**再用：直接截「登录窗口内二维码那一小块」，
    以 PNG 体积做判据（实测：真二维码 ~4.1KB，截错的浏览器区域 0.3~1.2KB）。
    阈值 2500B 分离得很干净，且不需要在服务器上安装任何图像库。
"""

import hashlib
import json
import os
import re
import subprocess
import time
import urllib.request

# ── 配置 ────────────────────────────────────────────────────────────────
BRIDGE = os.environ.get("WXB_BRIDGE", "http://172.16.8.16:18888")
HOST = os.environ.get("RDP_VM_IP", "172.16.8.16")
USER = os.environ.get("RDP_USER", "KCW5ngfxteFx")
PASS = os.environ.get("RDP_PASS", "")
WMIEXEC = "/usr/local/bin/wmiexec.py"
ENV_FILE = "/root/.wxbridge.env"     # 凭据来源（600，不入仓库）

OUTDIR = "/data/HBJSC/wxb_qr"
LATEST = os.path.join(OUTDIR, "latest.png")     # 已发布的二维码（135x135）
QRPNG = os.path.join(OUTDIR, "qr.png")          # 本轮二维码区截图
WINPNG = os.path.join(OUTDIR, "win.png")        # 本轮整窗截图（诊断用）
META = os.path.join(OUTDIR, "latest.json")
STATE = os.path.join(OUTDIR, "state.json")

WIN_TXT = r"C:\wxbridge\deploy\wx_front_out.txt"
SCREEN_W, SCREEN_H = 1440, 900
DISPLAY = os.environ.get("DISPLAY", ":99")

# 微信登录窗口的几何（实测稳定）：整窗 296x388，其中二维码区在窗口内偏移 (80,85) 尺寸 135x135
LOGIN_WIN = (296, 388)
QR_REL = (80, 85, 135, 135)
# 二维码区 PNG 体积下限：真码实测 ~3.5–5KB；截到浏览器/空白时 0.3–1.2KB
QR_MIN_BYTES = 2500

FRONT_EVERY = 60        # 每 60s 前置 + 抓一张新的 latest.png（= 码龄上限）
LOOP = 30               # 主循环间隔
FREEZE_SEC = 360        # 画面连续静止超过 6 分钟 ⇒ 认为自刷新卡死 ⇒ 重启客户端
RESTART_COOLDOWN = 300  # 两次重启最小间隔
RESTART_MAX_PER_HOUR = 6
GRAB_ROUND_MAX = 100    # 单轮内为拿到有效二维码最多花多少秒

VERDICT_RE = re.compile(
    r"VERDICT\s+fronted=(\d+)\s+hwnd=(\d+)\s+fg=(\d+)\s+vis=(\d+)\s+rect=\((-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)"
)


def log(msg):
    print(time.strftime("%F %T") + "  " + msg, flush=True)


def load_env():
    """
    自己解析 /root/.wxbridge.env 取凭据。
    为什么不用 systemd 的 EnvironmentFile：systemd 249 对值里单引号/特殊字符（本密码以 ')' 开头）
    的处理行为不稳，交给 Python 解析是确定性的。
    """
    global HOST, USER, PASS
    if not os.path.exists(ENV_FILE):
        return
    try:
        txt = open(ENV_FILE, encoding="utf-8", errors="ignore").read()
    except Exception as e:
        log("读 " + ENV_FILE + " 失败: " + repr(e))
        return
    for key, name in (("RDP_VM_IP", "HOST"), ("RDP_USER", "USER"), ("RDP_PASS", "PASS")):
        m = re.search(r"^\s*" + key + r"\s*=(.*)$", txt, re.M)
        if not m:
            continue
        v = m.group(1).strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        if name == "HOST":
            HOST = v
        elif name == "USER":
            USER = v
        else:
            PASS = v
    log("凭据就绪 host=%s user=%s passlen=%d" % (HOST, USER, len(PASS)))


def vm(cmd, timeout=90):
    """在 Windows VM 上执行命令（WMI over SMB，无 GUI、无按键注入）"""
    full = WMIEXEC + " -share 'C$' '" + USER + ":" + PASS + "@" + HOST + "' '" + cmd + "'"
    try:
        r = subprocess.run(full, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.stdout or ""
    except subprocess.TimeoutExpired:
        log("vm() 超时: " + cmd)
        return ""


def health():
    try:
        with urllib.request.urlopen(BRIDGE + "/health", timeout=8) as f:
            return json.loads(f.read().decode("utf-8", "ignore"))
    except Exception:
        return {}


def is_logged_in(h):
    return bool(h.get("driver") or h.get("wechat_version") or h.get("sessions"))


def read_verdict():
    """
    读 wx_front.py 的输出，取末尾那行机器可读的 VERDICT；只有「真的抢到前台」才返回窗口 rect。
    返回 (x, y, w, h) 或 None。
    """
    out = vm("type " + WIN_TXT, timeout=60)
    m = None
    for mm in VERDICT_RE.finditer(out):
        m = mm
    if not m:
        return None
    fronted, hwnd, fg, vis = (int(m.group(i)) for i in range(1, 5))
    x0, y0, x1, y1 = (int(m.group(i)) for i in range(5, 9))
    if not (fronted and hwnd and vis and fg == hwnd):
        return None
    x0 = max(0, min(x0, SCREEN_W))
    y0 = max(0, min(y0, SCREEN_H))
    x1 = max(0, min(x1, SCREEN_W))
    y1 = max(0, min(y1, SCREEN_H))
    w, hh = x1 - x0, y1 - y0
    if w < 80 or hh < 80:
        return None
    return (x0, y0, w, hh)


def front_and_rect(attempts=4, poll_each=10):
    """
    前置微信窗口，直到**确认**抢到前台为止。
    关键：触发计划任务前先删掉 wx_front_out.txt —— 前置是异步的，不删的话可能读到
    上一次运行残留的 VERDICT（显示"成功了"），实际窗口还没抢到前台 ⇒ 截到压在上面的浏览器。
    """
    for i in range(attempts):
        vm("del /F /Q " + WIN_TXT)
        vm("schtasks /Run /TN WxFront")
        for _ in range(poll_each):
            time.sleep(2)
            rect = read_verdict()
            if rect:
                return rect
        log("  前置未生效（第 %d/%d 次），重试" % (i + 1, attempts))
    return None


def scrot(region, out_path):
    env = dict(os.environ, DISPLAY=DISPLAY)
    try:
        subprocess.run(
            ["scrot", "-a", "%d,%d,%d,%d" % region, "-o", out_path],
            capture_output=True, text=True, timeout=30, env=env,
        )
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(out_path):
        return None
    return open(out_path, "rb").read()


def grab_qr(rect):
    """
    截「登录窗口内的二维码区」并验证内容真是二维码。
    为什么要截子区域而不是整窗：① 子区域的 PNG 体积可以当"是否真是二维码"的免费判据；
    ② 后续放大取码也只需要这一块。返回 (md5, 字节数) 或 None。
    """
    x, y, w, h = rect
    if (w, h) != LOGIN_WIN:
        log("  窗口 %dx%d 不是登录窗口 %dx%d（可能已换界面），跳过" % (w, h, LOGIN_WIN[0], LOGIN_WIN[1]))
        return None

    qx, qy, qw, qh = x + QR_REL[0], y + QR_REL[1], QR_REL[2], QR_REL[3]
    data = scrot((qx, qy, qw, qh), QRPNG)
    if data is None:
        log("  scrot 失败")
        return None
    if len(data) < QR_MIN_BYTES:
        log("  二维码区体积仅 %dB < %dB ⇒ 内容不像二维码（截到别的窗口？），丢弃"
            % (len(data), QR_MIN_BYTES))
        return None

    # 顺带留一张整窗图，便于人工排查
    scrot((x, y, w, h), WINPNG)
    return hashlib.md5(data).hexdigest(), len(data)


def restart_weixin():
    """兜底重置：杀掉微信客户端并在交互式会话里重新拉起 ⇒ 必然得到全新二维码"""
    log(">>> 画面长时间静止，重置二维码：重启微信客户端")
    vm("taskkill /F /IM Weixin.exe")
    time.sleep(5)
    vm("schtasks /Run /TN WxLaunchQr")
    time.sleep(25)          # 冷启动后登录窗口出现需要时间


def load_state():
    st = {
        "last_front": 0.0,
        "last_restart": 0.0,
        "prev_md5": "",
        "freeze_from": 0.0,
        "changed_at": 0.0,
        "restarts": [],
    }
    if os.path.exists(STATE):
        try:
            with open(STATE) as f:
                st.update(json.load(f))
        except Exception:
            pass
    return st


def save_state(st):
    try:
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(st, f)
        os.replace(tmp, STATE)
    except Exception as e:
        log("状态写入失败: " + repr(e))


def main():
    load_env()
    os.makedirs(OUTDIR, exist_ok=True)
    os.chmod(OUTDIR, 0o700)          # 二维码是登录令牌 ⇒ 目录仅 root 可读
    st = load_state()

    log("守护启动  loop=%ds  front_every=%ds  freeze=%ds" % (LOOP, FRONT_EVERY, FREEZE_SEC))

    logged = None
    while True:
        try:
            h = health()
            if not h:
                log("桥不可达 " + BRIDGE)
                time.sleep(LOOP)
                continue

            if is_logged_in(h):
                if logged is not True:
                    log("★ 已登录：driver=%r ver=%r sessions=%r"
                        % (h.get("driver"), h.get("wechat_version"), h.get("sessions")))
                    logged = True
                    st["freeze_from"] = 0.0
                    st["prev_md5"] = ""
                    save_state(st)
                time.sleep(LOOP)     # 已登录 ⇒ 什么都不做，静默守候
                continue

            if logged is True:
                log("回到未登录态（可能被踢下线）⇒ 恢复保活")
                logged = False

            now = time.time()
            if now - st["last_front"] < FRONT_EVERY:
                time.sleep(LOOP)
                continue
            st["last_front"] = now

            # ── 单轮：反复前置+截图，直到拿到一张验证通过的二维码（或超时） ──
            deadline = now + GRAB_ROUND_MAX
            got = None
            while time.time() < deadline:
                rect = front_and_rect(attempts=2, poll_each=8)
                if not rect:
                    time.sleep(3)
                    continue
                got = grab_qr(rect)
                if got:
                    break
                time.sleep(4)

            if not got:
                log("本轮多次尝试仍未取到有效二维码，下轮继续")
                save_state(st)
                time.sleep(LOOP)
                continue

            md5, nbytes = got
            changed = (md5 != st["prev_md5"])
            if changed:
                st["freeze_from"] = 0.0
            elif not st["freeze_from"]:
                st["freeze_from"] = now
            st["prev_md5"] = md5

            # 每次抓取都发布为 latest.png（用户取到的永远是最近一份有效二维码）
            subprocess.run(["cp", "-f", QRPNG, LATEST])
            os.chmod(LATEST, 0o600)
            if changed:
                st["changed_at"] = now
            with open(META, "w") as f:
                json.dump({"at": now, "rect": rect, "md5": md5, "bytes": nbytes,
                           "changed_at": st.get("changed_at", 0.0)}, f)

            frozen = (now - st["freeze_from"]) if st["freeze_from"] else 0.0
            log("二维码快照 rect=%s %dB md5=%s %s 冻结=%.0fs"
                % (rect, nbytes, md5[:12], "已刷新" if changed else "未变", frozen))

            st["restarts"] = [t for t in st["restarts"] if now - t < 3600]
            if (frozen >= FREEZE_SEC
                    and now - st["last_restart"] >= RESTART_COOLDOWN
                    and len(st["restarts"]) < RESTART_MAX_PER_HOUR):
                restart_weixin()
                st["last_restart"] = time.time()
                st["restarts"].append(st["last_restart"])
                st["freeze_from"] = 0.0
                st["prev_md5"] = ""

            save_state(st)
            time.sleep(LOOP)

        except Exception as e:
            log("异常: " + repr(e))
            time.sleep(LOOP)


if __name__ == "__main__":
    main()
