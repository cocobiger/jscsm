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

判据提醒（踩过的坑）：/health 里的 wx:"connected" 是内存态假健康，不能判断登录；
只有 driver / sessions / wechat_version 这三项非 null 才代表驱动真的起来了。
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
LATEST = os.path.join(OUTDIR, "latest.png")
WINPNG = os.path.join(OUTDIR, "win.png")
META = os.path.join(OUTDIR, "latest.json")
STATE = os.path.join(OUTDIR, "state.json")

WIN_TXT = r"C:\wxbridge\deploy\wx_front_out.txt"
SCREEN_W, SCREEN_H = 1440, 900
DISPLAY = os.environ.get("DISPLAY", ":99")

FRONT_EVERY = 60        # 每 60s 前置 + 抓一张新的 latest.png（= 码龄上限）
LOOP = 30               # 主循环间隔
FREEZE_SEC = 360        # 画面连续静止超过 6 分钟 ⇒ 认为自刷新卡死 ⇒ 重启客户端
RESTART_COOLDOWN = 300  # 两次重启最小间隔
RESTART_MAX_PER_HOUR = 6

RECT_RE = re.compile(r"rect=\((-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)")
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
    读 wx_front.py 的输出，取末尾那行机器可读的 VERDICT。
    为什么要它：实测过「SetForegroundWindow 没生效」的情况 —— 此时微信窗口不在前台，
    按它的 rect 去 scrot 会截到压在上面的浏览器（静默错图）。
    所以必须确认 fronted=1 且 fg==hwnd 才允许截图。
    文件是 UTF-8 且 VERDICT 行是纯 ASCII，跨 wmiexec 的编码转换不受影响。
    """
    out = vm("type " + WIN_TXT, timeout=60)
    m = None
    for mm in VERDICT_RE.finditer(out):
        m = mm
    if not m:
        return None
    fronted, hwnd, fg, vis = (int(m.group(i)) for i in range(1, 5))
    x0, y0, x1, y1 = (int(m.group(i)) for i in range(5, 9))
    if fronted and hwnd and fg == hwnd and vis:
        x0 = max(0, min(x0, SCREEN_W))
        y0 = max(0, min(y0, SCREEN_H))
        x1 = max(0, min(x1, SCREEN_W))
        y1 = max(0, min(y1, SCREEN_H))
        w, hh = x1 - x0, y1 - y0
        if w >= 80 and hh >= 80:
            return (x0, y0, w, hh)
    return None


def front_and_rect(attempts=3):
    """反复前置直到「确认抢到前台」为止；失败返回 None（宁可这轮不截，也不截错图）"""
    for i in range(attempts):
        vm("schtasks /Run /TN WxFront")
        time.sleep(8)
        rect = read_verdict()
        if rect:
            return rect
        log("  前置未生效（第 %d/%d 次），重试" % (i + 1, attempts))
        time.sleep(3)
    return None


def grab(rect):
    """截取窗口区域，返回 (md5, 字节数)"""
    env = dict(os.environ, DISPLAY=DISPLAY)
    try:
        subprocess.run(
            ["scrot", "-a", "%d,%d,%d,%d" % rect, "-o", WINPNG],
            capture_output=True, text=True, timeout=30, env=env,
        )
    except subprocess.TimeoutExpired:
        return None
    if not os.path.exists(WINPNG):
        return None
    data = open(WINPNG, "rb").read()
    return hashlib.md5(data).hexdigest(), len(data)


def restart_weixin():
    """兜底重置：杀掉微信客户端并在交互式会话里重新拉起 ⇒ 必然得到全新二维码"""
    log(">>> 画面长时间静止，重置二维码：重启微信客户端")
    vm("taskkill /F /IM Weixin.exe")
    time.sleep(5)
    vm("schtasks /Run /TN WxLaunchQr")
    time.sleep(30)          # 冷启动后登录窗口出现需要时间
    front_and_rect()        # 抢前台（失败也不影响主循环下一轮继续试）


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
                    log("★ 已登录：driver=%r ver=%r sessions 数量=%s"
                        % (h.get("driver"), h.get("wechat_version"),
                           len(h["sessions"]) if isinstance(h.get("sessions"), list) else h.get("sessions")))
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
            rect = front_and_rect()
            if not rect:
                log("前置失败（微信窗口未抢到前台），本轮不截图")
                save_state(st)
                time.sleep(LOOP)
                continue

            got = grab(rect)
            if not got:
                log("scrot 失败，跳过本轮")
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

            # 每次抓取都发布为 latest.png（用户取到的永远是最近一份截图）；
            # changed_at 单独记录，用来区分"码刷新了"和"画面冻住了"。
            subprocess.run(["cp", "-f", WINPNG, LATEST])
            os.chmod(LATEST, 0o600)
            if changed:
                st["changed_at"] = now
            with open(META, "w") as f:
                json.dump({"at": now, "rect": rect, "md5": md5, "bytes": nbytes,
                           "changed_at": st.get("changed_at", 0.0)}, f)

            frozen = (now - st["freeze_from"]) if st["freeze_from"] else 0.0
            log("快照 rect=%s md5=%s %s 冻结=%.0fs"
                % (rect, md5[:12], "已刷新" if changed else "未变", frozen))

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
