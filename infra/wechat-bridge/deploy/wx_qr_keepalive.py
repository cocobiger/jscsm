#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信登录二维码保活守护（运行在 Linux 跳板机 226 上）

问题：用户扫的是【截图】，截图与扫描之间隔了几分钟 ⇒ 二维码已过期 ⇒ 反复"失效"。
目标：在【微信未登录】期间，让屏幕上永远有一张新鲜二维码可截取（码龄 <= FRONT_EVERY 秒），
      并在「画面连续静止超过 FREEZE_SEC」或「窗口长时间消失」时自动重启微信客户端。
      一旦检测到已登录，立即停止一切动作（只保留低频心跳确认）。

── 登录判据（2026-10-12 T1 实测定标）────────────────────────────────
  在 VM 上跑 wx_login_probe.py 采集"未登录态"基线，结论：
    * auto_detect_db_dir() 返回 null   ⇒ 未登录时**连微信数据库目录都不存在**
    * WeChatDB() 直接抛 RuntimeError   ⇒ 未登录时桥的 load_driver() 必然全败
    * 屏幕上唯一的 Qt/微信窗口 = 登录窗，尺寸 **296x388**
  另读源码确认：桥 `<wechat_bot_server.py>` 的 /health 里 driver/sessions/wechat_version
    **只在"某次推送成功之后"才会被填**（_refresh_cache() 全文件仅 1 处调用，在 :803），
    且 db.py:564 get_self_info() 永远返回 dict（取不到也是 dict）⇒ **不能拿它判断登录**。
  ⇒ P0 采用的判据 = **微信窗口几何**：
      found=0                     → 微信没起来/崩了（≠ 已登录！要尝试拉起）
      found=1 且尺寸 == 296x388   → 登录界面（未登录）→ 继续保活
      found=1 且尺寸 != 296x388   → 已登录（主界面）→ 转入静默 + 低频心跳

设计要点 / 取舍：
  * 不用「定时重启客户端」做主手段：微信对频繁的登录二维码请求有风控嫌疑，
    且重启会打断「已扫码、正在手机上确认」的窗口期。
  * 只把「窗口前置」当主手段：无副作用，且能让微信自身的过期自动换码机制正常工作。
  * 「重启」仅作兜底，且必须满足三重护栏：冷却 5 分钟 + 每小时 <= 6 次 + 已登录即停。

其它踩过的坑（都已修，改动前请先读）：
  * wx_front_out.txt 里同时列出了屏幕**其他**窗口的 rect ⇒ 必须只认 VERDICT 行。
  * 前置动作是异步的（计划任务）⇒ 触发前**先删掉输出文件**，否则会读到上一次的陈旧 VERDICT，
    导致"以为抢到前台了、其实没有"，进而按窗口 rect 截到压在上面的浏览器（静默错图）。
  * 截回来的图必须**验证内容真的是二维码**再用：只截「登录窗口内二维码那一小块」，
    以 PNG 体积做判据（实测：真二维码 ~4.1–6.9KB，截错的浏览器区域 0.3–1.2KB）。
  * **权限**：/data/HBJSC/wxb_qr 必须是 2770 root:jsc、文件 640 ——
    后端 jsc-backend.service 以 User=jsc 运行，要读 latest.png 给前端展示。
    以前这里写死 0700/0600，会把权限打回去、导致后端读不到。
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
# 手动刷新请求标志：后端（jsc 用户，靠 setgid 目录的组写权限）落一个文件，本守护消费并删除。
# 为什么用标志文件而不是让后端自己 taskkill：① 重置动作**只归守护一家**，避免两处并发杀微信；
# ② 后端跑在 User=jsc 下，杀 Windows 进程需要 SSH 凭据（在 /root，600），不该下放。
RESET_FLAG = os.path.join(OUTDIR, "reset.request")

# 权限：目录 2770（setgid，新建文件自动继承 jsc 组，后端能读）；对外发布的文件 640
DIR_MODE = 0o2770
FILE_MODE = 0o640


def _jsc_gid():
    """后端 jsc-backend.service 以 User=jsc 运行；发布的文件必须归 jsc 组才能被读走"""
    try:
        import grp
        return grp.getgrnam("jsc").gr_gid
    except Exception:
        return 0


JSC_GID = _jsc_gid()


def publish(src, dst, mode=FILE_MODE, as_json=None):
    """
    把 src 发布成 dst（并保证权限/属组正确）。
    ⚠️ 不能直接 `cp -f` 覆盖已存在的文件 —— cp 是**原地截断**，会保留原有的 owner:group
    （此前是 root:root），于是即便 chmod 640，后端 jsc 仍然读不到（只有 root 组能读）。
    正解 = **先删再拷**：新文件在 setgid 目录下会继承 jsc 组；再兜底 chown/chmod。
    """
    try:
        if os.path.exists(dst):
            os.remove(dst)
    except Exception:
        pass
    if as_json is not None:
        # 自己写（避免 cp 的归属问题）：写临时文件 + 原子替换
        tmp = dst + ".tmp"
        with open(tmp, "w") as f:
            json.dump(as_json, f)
        os.replace(tmp, dst)
    else:
        subprocess.run(["cp", "-f", src, dst])
    try:
        os.chmod(dst, mode)
    except Exception:
        pass
    try:
        os.chown(dst, 0, JSC_GID)
    except Exception:
        pass

WIN_TXT = r"C:\wxbridge\deploy\wx_front_out.txt"
SCREEN_W, SCREEN_H = 1440, 900
DISPLAY = os.environ.get("DISPLAY", ":99")

# 微信登录窗口的几何（实测稳定）：整窗 296x388，其中二维码区在窗口内偏移 (80,85) 尺寸 135x135
LOGIN_WIN = (296, 388)
QR_REL = (80, 85, 135, 135)
# 二维码区 PNG 体积下限：真码实测 ~3.5–6.9KB；截到浏览器/空白时 0.3–1.2KB
QR_MIN_BYTES = 2500

FRONT_EVERY = 60        # 未登录时：每 60s 前置 + 抓一张新的 latest.png（= 码龄上限）
LOOP = 30               # 主循环间隔
LOGGEDIN_RECHECK = 300  # 已登录后：每 300s 做一次低频心跳确认（万一被登出要能恢复保活）
FREEZE_SEC = 360        # 画面连续静止超过 6 分钟 ⇒ 认为自刷新卡死 ⇒ 重启客户端
NO_WINDOW_ROUNDS = 5    # 连续 5 轮（≈5 分钟）找不到微信窗口 ⇒ 视为客户端挂了 ⇒ 重启拉起
RESTART_COOLDOWN = 300  # 两次重启最小间隔
RESTART_MAX_PER_HOUR = 6
GRAB_ROUND_MAX = 100    # 单轮内为拿到有效二维码最多花多少秒

VERDICT_RE = re.compile(
    r"VERDICT\s+fronted=(\d+)\s+found=(\d+)\s+hwnd=(\d+)\s+fg=(\d+)\s+vis=(\d+)"
    r"\s+rect=\((-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\)"
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


def login_state():
    """
    向桥要一次登录态（P1 新增端点 GET /login-state）。

    ⚠️ 目前**只用于记录/交叉印证，不参与判定** —— 因为"已登录态"下的 /login-state 尚未实测定标
       （T1 后半待扫码）。等两边数据齐了再决定是否把它提升为主判据。
       超时给得宽（45s）：首次探测要 import 驱动 + 解 DB 密钥，可能要几秒到十几秒。
    """
    try:
        with urllib.request.urlopen(BRIDGE + "/login-state", timeout=45) as f:
            return json.loads(f.read().decode("utf-8", "ignore"))
    except Exception as e:
        return {"error": "bridge/login-state 不可达: %r" % e}


def _ls_summary(ls):
    """把 /login-state 压成一行日志用的短摘要"""
    if not ls:
        return "无"
    if ls.get("error") and not ls.get("logged_in"):
        return "logged_in=false err=%s" % str(ls["error"])[:70]
    return ("logged_in=%s via=%s driver=%s ver=%s sessions=%s groups=%s"
            % (ls.get("logged_in"), ls.get("via"), ls.get("driver"),
               ls.get("wechat_version"), ls.get("sessions_count"), ls.get("groups_count")))


def read_verdict():
    """读 wx_front.py 的 VERDICT 行（纯 ASCII，跨 wmiexec 的编码转换不受影响）"""
    out = vm("type " + WIN_TXT, timeout=60)
    m = None
    for mm in VERDICT_RE.finditer(out):
        m = mm
    if not m:
        return None
    fronted, found, hwnd, fg, vis = (int(m.group(i)) for i in range(1, 6))
    x0, y0, x1, y1 = (int(m.group(i)) for i in range(6, 10))
    x0 = max(0, min(x0, SCREEN_W))
    y0 = max(0, min(y0, SCREEN_H))
    x1 = max(0, min(x1, SCREEN_W))
    y1 = max(0, min(y1, SCREEN_H))
    return {
        "fronted": bool(fronted),
        "found": bool(found) and hwnd != 0,
        "hwnd": hwnd,
        "fg_ok": bool(fg) and fg == hwnd,
        "vis": bool(vis),
        "rect": (x0, y0, x1 - x0, y1 - y0),
    }


def probe_window(attempts=4, poll_each=10):
    """
    前置微信窗口并返回 VERDICT。
    触发前**先删掉 wx_front_out.txt**：前置是异步的，不删的话可能读到上一次运行残留的
    VERDICT（显示"成功了"），实际窗口还没抢到前台 ⇒ 后续会截到压在上面的浏览器。
    """
    for i in range(attempts):
        vm("del /F /Q " + WIN_TXT)
        vm("schtasks /Run /TN WxFront")
        for _ in range(poll_each):
            time.sleep(2)
            v = read_verdict()
            if v:
                return v
        log("  前置探测未出结果（第 %d/%d 次），重试" % (i + 1, attempts))
    return None


def is_login_window(rect):
    return (rect[2], rect[3]) == LOGIN_WIN


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
    截「登录窗口内的二维码区」并验证内容真是二维码。返回 (md5, 字节数) 或 None。
    为什么要截子区域而不是整窗：① 子区域 PNG 体积可当"是否真是二维码"的免费判据；
    ② 后续放大取码也只需要这一块。
    """
    qx, qy, qw, qh = rect[0] + QR_REL[0], rect[1] + QR_REL[1], QR_REL[2], QR_REL[3]
    data = scrot((qx, qy, qw, qh), QRPNG)
    if data is None:
        log("  scrot 失败")
        return None
    if len(data) < QR_MIN_BYTES:
        log("  二维码区体积仅 %dB < %dB ⇒ 内容不像二维码（截到别的窗口？），丢弃"
            % (len(data), QR_MIN_BYTES))
        return None
    scrot(rect, WINPNG)     # 顺带留整窗图便于人工排查
    return hashlib.md5(data).hexdigest(), len(data)


def consume_reset_request():
    """消费后端的"手动刷新二维码"请求（存在即取出并删除，返回 True）"""
    if not os.path.exists(RESET_FLAG):
        return False
    try:
        os.remove(RESET_FLAG)
    except Exception as e:
        log("删除 reset.request 失败: %r" % e)
    return True


def restart_weixin(reason):
    """兜底重置：杀掉微信客户端并在交互式会话里重新拉起"""
    log(">>> 重启微信客户端：%s" % reason)
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
        "logged_in_hint": False,
        "last_confirm": 0.0,
        "no_window_rounds": 0,
        "last_login_state": None,   # 桥 /login-state 的最近一次结果（交叉印证用）
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


def allow_restart(st, now):
    """重启的三重护栏：冷却 + 每小时上限（"已登录即停"由调用方保证）"""
    st["restarts"] = [t for t in st["restarts"] if now - t < 3600]
    return (now - st["last_restart"] >= RESTART_COOLDOWN
            and len(st["restarts"]) < RESTART_MAX_PER_HOUR)


def do_restart(st, now, reason):
    restart_weixin(reason)
    st["last_restart"] = time.time()
    st["restarts"].append(st["last_restart"])
    st["freeze_from"] = 0.0
    st["prev_md5"] = ""
    st["no_window_rounds"] = 0


def main():
    load_env()
    os.makedirs(OUTDIR, exist_ok=True)
    # ⚠️ 必须是 2770（setgid）+ 文件 640：后端 jsc-backend.service 以 User=jsc 运行，
    #    要读 latest.png 给前端展示。以前写死 0700/0600 会把权限打回去、后端读不到。
    try:
        os.chmod(OUTDIR, DIR_MODE)
    except Exception as e:
        log("chmod 目录失败: %r" % e)
    st = load_state()

    log("守护启动  loop=%ds  front_every=%ds  freeze=%ds  已登录心跳=%ds"
        % (LOOP, FRONT_EVERY, FREEZE_SEC, LOGGEDIN_RECHECK))

    while True:
        try:
            h = health()
            if not h:
                log("桥不可达 " + BRIDGE)
                time.sleep(LOOP)
                continue

            now = time.time()

            # ── 手动刷新请求（后端 /api/wechat/qr/refresh 落的标志）──
            # 必须放在"已登录即静默"分支**之前**，否则用户点了刷新页面却毫无反应。
            if consume_reset_request():
                log("收到手动刷新请求（reset.request）")
                st["logged_in_hint"] = False
                st["last_confirm"] = 0.0
                v = probe_window(attempts=1, poll_each=6)
                if v and v["found"] and not is_login_window(v["rect"]):
                    log("  当前窗口 %dx%d 非登录窗 ⇒ 判定已登录，忽略本次刷新请求"
                        % (v["rect"][2], v["rect"][3]))
                    st["logged_in_hint"] = True
                    st["last_confirm"] = time.time()
                    save_state(st)
                    time.sleep(LOOP)
                    continue
                # 人工动作允许绕过"每小时 ≤6 次"的自动护栏（后端已用 120s
                # alreadyPending 做防连点），但仍保留 60s 最小间隔，避免连续杀微信。
                if now - st["last_restart"] >= 60:
                    do_restart(st, now, "用户手动点击刷新二维码")
                    st["last_front"] = 0.0     # 让下一轮立刻抓新码
                else:
                    log("  距上次重置不足 60s，跳过（避免连续杀掉微信）")
                save_state(st)

            # ── 已登录：低频心跳确认，避免每 60s 抢一次前台 ──
            if st.get("logged_in_hint"):
                if now - st.get("last_confirm", 0) < LOGGEDIN_RECHECK:
                    time.sleep(LOOP)
                    continue
                st["last_confirm"] = now
                v = probe_window(attempts=1, poll_each=6)
                ls = login_state()
                st["last_login_state"] = ls
                if v and v["found"] and not is_login_window(v["rect"]):
                    log("心跳：仍是已登录态（窗口 %dx%d，非登录窗）｜ 桥 %s"
                        % (v["rect"][2], v["rect"][3], _ls_summary(ls)))
                    save_state(st)
                    time.sleep(LOOP)
                    continue
                log("心跳：已看不到登录后的主窗口 ⇒ 可能被登出/关闭，恢复保活｜ 桥 %s"
                    % _ls_summary(ls))
                st["logged_in_hint"] = False
                save_state(st)
                # 继续往下走本轮的保活流程

            if now - st["last_front"] < FRONT_EVERY:
                time.sleep(LOOP)
                continue
            st["last_front"] = now

            # ── 单轮：探测窗口 → 分流（已登录 / 未登录取码 / 找不到窗口） ──
            deadline = now + GRAB_ROUND_MAX
            got = None
            saw_other_window = False
            saw_window = False
            while time.time() < deadline:
                v = probe_window(attempts=2, poll_each=8)
                if not v or not v["found"]:
                    time.sleep(3)
                    continue
                saw_window = True
                if not is_login_window(v["rect"]):
                    saw_other_window = True
                    break
                # 抢到前台才允许截图（否则会截到压在上面的浏览器）
                if v["fronted"] and v["fg_ok"]:
                    got = grab_qr(v["rect"])
                    if got:
                        break
                time.sleep(4)

            if saw_other_window:
                ls = login_state()
                st["last_login_state"] = ls
                st["logged_in_hint"] = True
                st["last_confirm"] = time.time()
                st["no_window_rounds"] = 0
                log("检测到非登录尺寸的微信窗口 ⇒ 判定【已登录】，转入静默（每 %ds 心跳确认一次）"
                    "｜ 桥 %s" % (LOGGEDIN_RECHECK, _ls_summary(ls)))
                save_state(st)
                time.sleep(LOOP)
                continue

            if not got:
                if not saw_window:
                    st["no_window_rounds"] = st.get("no_window_rounds", 0) + 1
                    log("本轮看不到微信窗口（连续 %d/%d 轮）"
                        % (st["no_window_rounds"], NO_WINDOW_ROUNDS))
                    if st["no_window_rounds"] >= NO_WINDOW_ROUNDS and allow_restart(st, now):
                        do_restart(st, now, "微信窗口长时间不存在（客户端可能已退出）")
                else:
                    st["no_window_rounds"] = 0
                    log("本轮未取到有效二维码，下轮继续")
                save_state(st)
                time.sleep(LOOP)
                continue

            st["no_window_rounds"] = 0
            md5, nbytes = got
            changed = (md5 != st["prev_md5"])
            if changed:
                st["freeze_from"] = 0.0
            elif not st["freeze_from"]:
                st["freeze_from"] = now
            st["prev_md5"] = md5

            # 每次抓取都发布为 latest.png（用户/后端取到的永远是最近一份有效二维码）
            publish(QRPNG, LATEST)
            if changed:
                st["changed_at"] = now
            publish(None, META, as_json={
                "at": now, "rect": list(v["rect"]), "md5": md5, "bytes": nbytes,
                "changed_at": st.get("changed_at", 0.0),
            })

            frozen = (now - st["freeze_from"]) if st["freeze_from"] else 0.0
            log("二维码快照 rect=(%d,%d,%d,%d) %dB md5=%s %s 冻结=%.0fs"
                % (v["rect"][0], v["rect"][1], v["rect"][2], v["rect"][3],
                   nbytes, md5[:12], "已刷新" if changed else "未变", frozen))

            if frozen >= FREEZE_SEC and allow_restart(st, now):
                do_restart(st, now, "画面连续 %.0fs 未变化（自刷新可能卡死）" % frozen)

            save_state(st)
            time.sleep(LOOP)

        except Exception as e:
            log("异常: " + repr(e))
            time.sleep(LOOP)


if __name__ == "__main__":
    main()
