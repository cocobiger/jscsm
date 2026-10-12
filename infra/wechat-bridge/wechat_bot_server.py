# -*- coding: utf-8 -*-
"""
普通微信群推送桥接服务（方案 B）— v2 多驱动版
================================================
作用：把 jsc 秸秆告警（企业微信群机器人格式）转发到「普通微信群」。

背景：微信官方只提供「企业微信群机器人」webhook，普通微信群没有官方推送接口。
本服务运行在一台常驻 Windows 机器上，通过 UIA/OCR 驱动本机微信 PC 客户端，
把后端发来的告警消息发送到指定的普通微信群。

驱动双路（自动选择，企微 webhook 协议不变）:
  - wechatauto-replica (1.2.0+): 微信 4.1.12+（UIA + OCR 混合驱动）
  - wxauto4 (AngeCoo 分支):      微信 4.0.5（UIA）
  - wxauto (原版):               微信 3.9.x（UIA）

协议兼容（后端 jsc 零改动）:
  POST /send?group=<群名>
    { "msgtype": "news",     "news": {"articles":[{title,description,picurl,url}]} }
    { "msgtype": "markdown", "markdown": {"content": "..."} }
  成功返回 {"errcode":0}（与企微一致，后端 pushInfo.pushed=true）

运行:
  pip install -r requirements.txt
  python wechat_bot_server.py --port 18888

环境要求:
  - Windows + 微信 PC 客户端（建议小号常驻登录，群需在微信「最近会话」出现过）
  - 驱动版本需与微信 PC 版本匹配（见 README.md）

健康检查:
  GET /health  → {"ok":true,"wx":"connected","driver":"wechatauto","sessions":N} 或错误详情
"""

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

from flask import Flask, jsonify, request

# ── 基础配置 ──────────────────────────────────────────────
LOG = logging.getLogger("wxbridge")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    encoding="utf-8",
    errors="replace",
)

SEND_MIN_INTERVAL = 2.0      # 两次发送最小间隔（秒），避免微信 UI 操作过快 + 风控
IMG_DOWNLOAD_TIMEOUT = 20    # 告警卡片图片下载超时（秒）
DEFAULT_PORT = 18888

# 驱动实例（延迟初始化，微信未登录时启动服务也不会崩）
DRIVER = None          # 实际驱动实例
DRIVER_NAME = None

# ══════════════════════════════════════════════════════════════════
# 全局运行状态（2026-09-25 新增）
# ⚠️ 这里的读取/写入**绝不调用 wxauto** —— 目的就是让 /health 与微信 UI 解耦：
#    实测原 /health 会调 list_session_names()/get_self_info()，wxauto 一卡它就跟着卡，
#    导致外部只看到「端口在但无响应」，无法判断到底是进程死了还是业务卡住。
# ══════════════════════════════════════════════════════════════════
import os as _os
STATE = {
    'started_at': time.time(),
    'last_ok_ts': time.time(),      # 上次成功与微信交互的时刻
    'last_req_ts': None,            # 上次收到 /send 的时刻
    'last_err': '',
    'last_warn': '',                # 非致命但需人知道的情况（如 worker 超时但消息可能已发）
    'stuck': False,                 # 有发送超时未返回 → 视为卡死
    'stuck_since': None,
    'inflight': 0,                  # 正在进行的发送数
    'send_ok': 0,                   # 累计成功
    'send_fail': 0,                 # 累计失败
    'send_timeout': 0,              # 累计超时
    'sessions': None,               # 缓存（由 worker 回报，仅展示用）
    'wechat_version': None,
    'driver': None,
    'worker_pid': None,             # 最近一次 worker 的 PID
    'worker_last_ms': None,         # 最近一次 worker 耗时（毫秒）
    'send_mode': None,              # worker | inproc
}
# 发送超时（秒）；超过即判卡死并熔断
SEND_TIMEOUT = float(_os.environ.get('WXBRIDGE_SEND_TIMEOUT', '30'))
# 判定「不健康」的空闲阈值（秒）：超过这么久没有一次成功交互 → 认为与微信失联
HEALTH_STALE_S = float(_os.environ.get('WXBRIDGE_HEALTH_STALE', '300'))
# stuck 自动衰减时长（秒）：超过则自动清除，避免永久锁死
STUCK_TTL = float(_os.environ.get('WXBRIDGE_STUCK_TTL', '600'))

# ══════════════════════════════════════════════════════════════════
# 发送执行模式（2026-09-27 v3 新增，本次核心改动）
# ══════════════════════════════════════════════════════════════════
# 【背景·实测定论】实际驱动是 wechatauto，发送走 wechatauto.guia.quick_send。
#   guia 把「微信窗口/渲染子窗口句柄」缓存在【进程全局】，第一次发送成功后缓存即失效
#   （日志铁证：[WARNING] [guia.py:394] 未找到微信渲染子窗口，回退用主窗口矩形定位坐标，
#    每次发送都出现；第二次操作落空 → 进程被硬杀，server_err.log 无任何 traceback）。
#   症状：**第 1 条发送必成功，第 2 条必崩**。
#
# 【方案】把「发送」这件事整个丢进**【一次性子进程】**：
#   每次发送都是全新进程 → 重新 import guia → 重新获取句柄 → **永远是"第 1 条"**。
#   服务本体从此【绝不触碰 wxauto】，也就不会因发送而损坏：
#   → 不需要"发完自杀再拉起" ⇒ 没有 2 分钟空窗、没有端口交接、没有与自愈脚本抢端口的竞态。
#
# 【回滚】设环境变量 WXBRIDGE_SEND_MODE=inproc 即回到旧的进程内发送（一行改动都不用）。
SEND_MODE = _os.environ.get('WXBRIDGE_SEND_MODE', 'worker').strip().lower()
# 单个 worker 的最长等待（秒）
WORKER_TIMEOUT = float(_os.environ.get('WXBRIDGE_WORKER_TIMEOUT', '60'))
# 一次只允许一个 worker 操作微信 UI（wxauto 不是并发安全的）
WORKER_LOCK = threading.Lock()
# worker 自己的日志（父进程读不到子进程控制台 → 必须落盘，否则崩溃无据可查）
WORKER_LOG = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), 'worker.log')
WORKER_LOG_MAX = 1000000
STATE['send_mode'] = SEND_MODE


def _mark_stuck(reason):
    """标记卡死（供看门狗识别并重启）"""
    if not STATE['stuck']:
        STATE['stuck_since'] = time.time()
    STATE['stuck'] = True
    STATE['last_err'] = str(reason)[:300]


def _clear_stuck():
    STATE['stuck'] = False
    STATE['stuck_since'] = None


def _refresh_cache():
    """尽力刷新缓存（可能卡，只在发送成功后的轻量路径调用，且失败不影响主流程）"""
    try:
        STATE['sessions'] = len(list_session_names())
    except Exception:
        pass
    try:
        STATE['wechat_version'] = detect_wechat_version()
    except Exception:
        pass
    STATE['driver'] = DRIVER_NAME
     # "wechatauto" | "wxauto4" | "wxauto"
WX_LOCK = threading.Lock()
SEND_LOCK = threading.Lock()
LAST_SEND_TS = 0.0


# ── 驱动加载（多路回退） ─────────────────────────────────
def detect_wechat_version():
    """从 Weixin.exe 的 FileVersion 读版本号。"""
    try:
        import win32api
        info = win32api.GetFileVersionInfo(r"C:\Program Files\Tencent\Weixin\Weixin.exe", "\\")
        ms = info['FileVersionMS']
        ls = info['FileVersionLS']
        return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"
    except Exception as e:
        LOG.debug("detect_wechat_version 失败: %s", e)
        return None


def load_driver():
    """按优先级尝试加载驱动: wechatauto → wxauto4 → wxauto。
    成功返回 (driver_instance, driver_name)。
    失败 raise RuntimeError。
    """
    global DRIVER, DRIVER_NAME
    if DRIVER is not None:
        return DRIVER, DRIVER_NAME

    with WX_LOCK:
        if DRIVER is not None:
            return DRIVER, DRIVER_NAME

        # 检测微信版本
        wx_ver = detect_wechat_version()
        LOG.info("检测到微信版本: %s", wx_ver or "未知")

        # 1) wechatauto (4.1.12+)
        try:
            from wechatauto import WeChatDB
            from wechatauto.guia import quick_send, quick_send_file
            db = WeChatDB()
            info = db.get_self_info()
            if info:
                LOG.info("使用 wechatauto 驱动, 账号=%s", info)
                DRIVER = {
                    "name": "wechatauto",
                    "db": db,
                    "quick_send": quick_send,
                    "quick_send_file": quick_send_file,
                }
                DRIVER_NAME = "wechatauto"
                return DRIVER, DRIVER_NAME
        except Exception as e:
            LOG.warning("wechatauto 不可用: %s", e)

        # 2) wxauto4 (4.0.5)
        try:
            import wxauto4
            wx = wxauto4.WeChat()
            LOG.info("使用 wxauto4 驱动")
            DRIVER = {"name": "wxauto4", "wx": wx}
            DRIVER_NAME = "wxauto4"
            return DRIVER, DRIVER_NAME
        except Exception as e:
            LOG.warning("wxauto4 不可用: %s", e)

        # 3) wxauto (3.9.x)
        try:
            import wxauto
            wx = wxauto.WeChat()
            LOG.info("使用 wxauto 驱动")
            DRIVER = {"name": "wxauto", "wx": wx}
            DRIVER_NAME = "wxauto"
            return DRIVER, DRIVER_NAME
        except Exception as e:
            LOG.warning("wxauto 不可用: %s", e)

        raise RuntimeError("无可用驱动: wechatauto / wxauto4 / wxauto 均初始化失败")


# ── 会话解析（按驱动分发） ───────────────────────────────
def list_session_names():
    """统一返回最近会话名列表。"""
    drv, name = load_driver()
    if name == "wechatauto":
        # wechatauto 用本地 DB 读会话
        try:
            sessions = drv["db"].get_sessions(limit=50) or []
            names = []
            for s in sessions:
                if isinstance(s, dict):
                    uname = s.get("username") or s.get("wxid") or ""
                    if uname:
                        # 用 nickname 替换 wxid, 方便按关键字匹配
                        try:
                            nick = drv["db"].get_nickname(uname) or uname
                            names.append(nick)
                        except Exception:
                            names.append(uname)
                elif isinstance(s, str):
                    names.append(s)
            return names
        except Exception as e:
            LOG.warning("wechatauto get_sessions 失败: %s", e)
            return []
    else:
        # wxauto4 / wxauto
        try:
            sessions = drv["wx"].GetSessionList() or []
        except Exception as e:
            LOG.warning("GetSessionList 失败: %s", e)
            return []
        names = []
        for s in sessions:
            if isinstance(s, str):
                names.append(s)
            else:
                name = getattr(s, "name", None) or getattr(s, "remark", None) or str(s)
                if name:
                    names.append(name)
        return names


def resolve_group(keyword):
    """按关键字在最近会话中查找群, 返回精确显示名。

    wechatauto 的 quick_send(who=...) 中 who 接受「会话名称」——内部 open_chat()
    按名称匹配侧栏/搜索，而不是 wxid。list_session_names() 返回的正是
    get_nickname() 的显示名（remark→nick_name），直接返回即可。
    """
    keyword = (keyword or "").strip()
    if not keyword:
        raise ValueError("group 参数为空")
    load_driver()
    sessions = list_session_names()
    for s in sessions:
        if keyword.lower() in s.lower():
            return s
    hint = "、".join(sessions[:20]) or "（空）"
    raise LookupError(f"未找到群「{keyword}」，最近会话: {hint}")


def _resp_desc(r):
    """把驱动返回对象里的失败原因全部抖出来。

    ⚠️ 原来这里只写 `if not ok: raise RuntimeError("文本发送失败")` —— 把 WxResponse 里的
    具体原因（如「发送失败：多次重试未完成」/「微信窗口不可见」）**整个丢掉了**，导致排障时
    只看到一句无信息量的"发送失败"，根本不知道卡在哪一步。

    ⚠️ 注意：wechatauto 的 `WxResponse` 是 **dict 子类**（键：status/message/data，
    属性只有 is_success / 类方法 success/failure/error）→ **必须按键读，getattr 读不到**。
    """
    if r is None:
        return "resp=None"
    try:
        if isinstance(r, dict):
            return "status=%r message=%r data=%r" % (
                r.get('status'), r.get('message'), r.get('data'))
    except Exception:
        pass
    try:
        return "repr=%r" % (r,)
    except Exception:
        return "<不可读>"


def _resp_ok(r):
    """判断 WxResponse 是否成功（兼容 __bool__ / success 字段两种实现）。"""
    if r is None:
        return False
    try:
        return bool(r)
    except Exception:
        pass
    for attr in ('success', 'ok'):
        v = getattr(r, attr, None)
        if isinstance(v, bool):
            return v
    return True


# ── 发送（按驱动分发） ──────────────────────────────────
def send_to_group(keyword, text=None, img_path=None):
    """按当前驱动发送, 先图后文。"""
    global LAST_SEND_TS
    drv, name = load_driver()
    target = resolve_group(keyword)
    with SEND_LOCK:
        # 限速
        wait = SEND_MIN_INTERVAL - (time.time() - LAST_SEND_TS)
        if wait > 0:
            time.sleep(wait)

        if name == "wechatauto":
            # wechatauto.quick_send: DB+OCR 混合, verify=True 在微信 4.1.12 上
            # 会误报失败(消息实际已写入文件传输助手/群聊 DB,但 verify 回读对比失败,
            # 推断为 DB 锁/同步延迟)。改 verify=False 以 errcode 0 上报后端;
            # 真实送达以微信群端收到为准(已 e2e 截图验证 2026-08-31)。
            if img_path:
                r = drv["quick_send_file"](img_path, target, verify=False)
                if not _resp_ok(r):
                    raise RuntimeError(f"图片发送失败: target={target} | {_resp_desc(r)}")
                time.sleep(0.5)
            if text:
                r = drv["quick_send"](text, target, verify=False)
                if not _resp_ok(r):
                    raise RuntimeError(f"文本发送失败: target={target} | {_resp_desc(r)}")
                _worker_log("驱动返回: %s" % _resp_desc(r))
        else:
            # wxauto4 / wxauto: UIA 操作
            wx = drv["wx"]
            wx.ChatWith(target)
            time.sleep(0.6)
            if img_path:
                wx.SendImage(img_path)
                time.sleep(0.5)
            if text:
                wx.SendMsg(text)

        LAST_SEND_TS = time.time()
    return target


# ── 消息格式转换 ──────────────────────────────────────────
def md_to_text(md):
    """企业微信 markdown → 普通微信纯文本：去掉 **、> 前缀，链接改为 文字（URL）。"""
    t = md or ""
    t = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", t)                    # 图片语法
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1（\2）", t)             # 链接
    t = t.replace("**", "")
    lines = [re.sub(r"^>\s*", "", ln) for ln in t.split("\n")]
    return "\n".join(lines).strip()


def download_image(url, timeout=IMG_DOWNLOAD_TIMEOUT):
    """下载告警卡片图到临时目录，返回本地路径。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    ext = ".png"
    m = re.search(r"\.(png|jpe?g|gif|webp)(\?|$)", url, re.I)
    if m:
        ext = "." + m.group(1).lower()
    fd, path = tempfile.mkstemp(suffix=ext, prefix="wxcard_")
    with urllib.request.urlopen(req, timeout=timeout) as resp, os.fdopen(fd, "wb") as f:
        f.write(resp.read())
    return path


# ══════════════════════════════════════════════════════════════════
# 一次性 worker：真正干「发送」这件事的子进程（2026-09-27 v3）
# ══════════════════════════════════════════════════════════════════
def _worker_log(msg):
    """worker 日志落盘。⚠️ 子进程若用 CREATE_NEW_CONSOLE，控制台一关输出就没了 → 必须写文件。"""
    try:
        if os.path.exists(WORKER_LOG) and os.path.getsize(WORKER_LOG) > WORKER_LOG_MAX:
            os.replace(WORKER_LOG, WORKER_LOG + '.1')
    except Exception:
        pass
    try:
        with open(WORKER_LOG, 'a', encoding='utf-8', errors='replace') as f:
            f.write("%s [pid=%d] %s\n" % (time.strftime('%Y-%m-%d %H:%M:%S'), os.getpid(), msg))
    except Exception:
        pass


def _count_visible_top_level_windows():
    """本进程能看到的「可见顶层窗口」数量（诊断用）。

    判据价值：正常交互式桌面应有几十个（实测 82）。若 worker 报出接近 0，
    就说明该子进程与交互式会话**不在同一个桌面/窗口站** —— 这才是"枚举不到微信窗口"
    的真因，而不是微信窗口本身有问题。区分这两种可能必须靠这个数字。
    """
    if os.name != 'nt':
        return -1
    try:
        import ctypes
        from ctypes import wintypes
        u32 = ctypes.windll.user32
        n = [0]
        CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        def _cb(h, _l):
            try:
                if u32.IsWindowVisible(h):
                    n[0] += 1
            except Exception:
                pass
            return True

        u32.EnumWindows(CB(_cb), 0)
        return n[0]
    except Exception:
        return -2


def _bring_wechat_front():
    """确保微信主窗口可见且在前台（best-effort，仅 Windows）。

    ⚠️ 刻意**不再自己手搓 ctypes 打分** —— 直接复用 guia 自己的权威实现：
      `WeChatGUI._find_main_window()` 多特征打分定位 + `guia._restore_keep_maximize()` 恢复。
      自己重写一遍只会引入偏差（先前那版就因依赖 tasklist 取 PID 而误报"无可见顶层窗口"）。

    【为什么需要】实测微信窗口不可见 / 不在前台时，guia 构造 WeChatGUI 会直接抛
      `RuntimeError: 未找到微信主窗口，请确认微信已登录并运行` → 发送当场失败。

    【顺带诊断】打印本进程可见顶层窗口数：与 guia 定位结果一起写进 worker.log，
      用于区分「看不到窗口（桌面/窗口站不对）」与「能看到但打分不够」。
    """
    if os.name != 'nt':
        return False
    try:
        import ctypes
        from ctypes import wintypes
        from wechatauto import guia as G
    except Exception as e:                            # noqa: BLE001
        _worker_log("bring_wechat_front: 依赖导入失败 %r" % (e,))
        return False

    try:
        # 不跑 __init__（避免触发布局校准/OCR），只借用定位能力
        probe = G.WeChatGUI.__new__(G.WeChatGUI)
        probe._input = G.WinInput()
        hwnd = probe._find_main_window(getattr(G, 'WX_MAIN_WIN_TITLE', '微信'))
        vis = _count_visible_top_level_windows()
        _worker_log("诊断: 本进程可见顶层窗口数=%s, guia 定位主窗口 hwnd=%s" % (vis, hwnd))
        if not hwnd:
            return False

        u32 = ctypes.windll.user32
        k32 = ctypes.windll.kernel32
        try:
            G._restore_keep_maximize(u32, hwnd)        # guia 自己的恢复（含保持最大化）
        except Exception:
            u32.ShowWindow(hwnd, 9)                    # 退回 SW_RESTORE

        # ── 尺寸唤醒 ────────────────────────────────────────────────
        # 实测微信主窗口会出现「完全不绘制」的状态（抓屏得均匀灰、白像素≈0），此时
        # minimize→restore、RedrawWindow、bring_to_front **全部无效**，
        # 唯一见效的是「微调窗口尺寸触发重排」（实测白像素 1→152、暗像素 59→2964）。
        # 这也是 guia 的 desktop_available()（要求近白像素 >5%）能否通过的前提。
        try:
            rr = wintypes.RECT()
            u32.GetWindowRect(hwnd, ctypes.byref(rr))
            w0 = rr.right - rr.left
            h0 = rr.bottom - rr.top
            if w0 > 100 and h0 > 100:
                SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010
                u32.SetWindowPos(hwnd, 0, rr.left, rr.top, w0, h0 - 1,
                                 SWP_NOZORDER | SWP_NOACTIVATE)
                time.sleep(0.6)
                u32.SetWindowPos(hwnd, 0, rr.left, rr.top, w0, h0,
                                 SWP_NOZORDER | SWP_NOACTIVATE)
                time.sleep(0.6)
                _worker_log("已做尺寸唤醒（%dx%d → 还原 %dx%d）" % (w0, h0 - 1, w0, h0))
        except Exception as e:                        # noqa: BLE001
            _worker_log("尺寸唤醒失败: %r" % (e,))

        # AttachThreadInput 绕过 Windows 前台锁定（否则后台进程 SetForegroundWindow 会被静默忽略）
        fg = u32.GetForegroundWindow()
        t_fg = u32.GetWindowThreadProcessId(fg, None) if fg else 0
        t_me = k32.GetCurrentThreadId()
        attached = False
        if t_fg and t_fg != t_me:
            try:
                attached = bool(u32.AttachThreadInput(t_fg, t_me, True))
            except Exception:
                attached = False
        try:
            u32.BringWindowToTop(hwnd)
            ok = bool(u32.SetForegroundWindow(hwnd))
        except Exception:
            ok = False
        if attached:
            try:
                u32.AttachThreadInput(t_fg, t_me, False)
            except Exception:
                pass
        if not ok:
            try:
                u32.SwitchToThisWindow(hwnd, True)
                ok = True
            except Exception:
                pass
        time.sleep(0.5)
        _worker_log("bring_wechat_front: hwnd=%s setfg=%s" % (hwnd, ok))
        return True
    except Exception as e:                            # noqa: BLE001
        _worker_log("bring_wechat_front 异常: %r" % (e,))
        return False
def _dump_wxauto_log_tail(n=60):
    """把 wechatauto 自身日志末尾追加进 worker.log。

    发送失败时唯一能说明「卡在哪一步」的内部线索都在这个日志里
    （open_chat / input_text / click_send 的 DEBUG 行）。一条命令就能拿到，不必再单开取证。
    """
    try:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wechatauto_logs')
        if not os.path.isdir(d):
            d = r'C:\wxbridge\wechatauto_logs'
        name = 'app_%s.log' % time.strftime('%Y%m%d')
        p = os.path.join(d, name)
        if not os.path.isfile(p):
            _worker_log("wxauto 日志不存在: %s" % p)
            return
        with open(p, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
        _worker_log("──── wechatauto 日志末尾 %d 行（%s）────" % (n, name))
        for ln in lines[-n:]:
            _worker_log("    " + ln.rstrip('\n'))
        _worker_log("──── 取证结束 ────")
    except Exception as e:                            # noqa: BLE001
        _worker_log("dump wxauto 日志失败: %r" % (e,))


def run_send_once():
    """`--send-once` 入口：在【全新进程】里完成一次发送，结果写 JSON 文件后硬退出。

    本函数不会返回（末尾 os._exit）——刻意如此：Windows 上 GUI/UIA 句柄可能让
    解释器正常退出时卡住，硬退出最干净。
    """
    ap = argparse.ArgumentParser(prog="wechat_bot_server.py --send-once")
    ap.add_argument('--send-once', action='store_true')
    ap.add_argument('--group', required=True, help='目标群名关键字')
    ap.add_argument('--text-file', default=None, help='消息正文（UTF-8 文件；避免命令行中文编码问题）')
    ap.add_argument('--img', default=None, help='图片本地路径（可选）')
    ap.add_argument('--result', required=True, help='结果 JSON 输出路径')
    args = ap.parse_args()

    text = None
    if args.text_file and os.path.exists(args.text_file):
        try:
            with open(args.text_file, 'r', encoding='utf-8', errors='replace') as f:
                text = f.read()
        except Exception as e:
            _worker_log("读正文失败: %s" % e)

    t0 = time.time()
    res = {'ok': False, 'pid': os.getpid()}

    # ⚠️ 会话数/微信版本必须在【发送之前】采集：
    #   发送后 guia 的窗口句柄已失效，此时再碰 wxauto 极易卡死 → 结果文件写不出来
    #   → 父进程会把"其实已发出"误报成失败。所以发送后只做纯粹的本地文件 I/O。
    try:
        res['sessions'] = len(list_session_names())
    except Exception:
        pass
    try:
        res['wechat_version'] = detect_wechat_version()
    except Exception:
        pass

    try:
        # 心跳行：用于区分「worker 根本没起来」与「起来了但发送失败」（借鉴 selfheal 的教训）
        _worker_log("[hb] worker 启动 group=%s text_len=%d img=%s" % (args.group, len(text or ''), bool(args.img)))
        # ⚠️ 必须先确保微信在前台，否则 guia 报「未找到微信主窗口」直接失败
        _bring_wechat_front()
        target = send_to_group(args.group, text=text, img_path=args.img)
        res.update(ok=True, target=target, driver=DRIVER_NAME)
        _worker_log("✅ 发送成功 target=%s 耗时=%.1fs" % (target, time.time() - t0))
    except BaseException as e:                       # noqa: BLE001 含 SystemExit
        res.update(ok=False, err=("%s: %s" % (type(e).__name__, e))[:400])
        _worker_log("❌ 发送失败 %s" % res['err'])
        _dump_wxauto_log_tail(60)
    res['ms'] = int((time.time() - t0) * 1000)

    try:
        tmp = args.result + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False)
        os.replace(tmp, args.result)     # 原子落地：父进程绝不会读到半截 JSON
    except Exception as e:
        _worker_log("写结果失败: %s" % e)

    _worker_log("worker 退出 ok=%s" % res.get('ok'))
    os._exit(0 if res.get('ok') else 1)


def _kill_worker(proc):
    """超时后强杀 worker（含其子进程）。杀进程是本项目既有做法（selfheal 一直这么干）。"""
    try:
        if os.name == 'nt' and proc.poll() is None:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                           capture_output=True, timeout=20)
        else:
            proc.kill()
    except Exception as e:
        _worker_log("kill worker 失败: %s" % e)
    try:
        proc.wait(timeout=10)
    except Exception:
        pass


def _send_via_worker(group, text=None, img_path=None):
    """父进程侧：spawn 一次性 worker 并等结果。返回 (target, err, http_code)。"""
    # 串行化：wxauto 不是并发安全的，同时两个 worker 会互相搅乱微信窗口
    if not WORKER_LOCK.acquire(timeout=WORKER_TIMEOUT + 20):
        STATE['send_fail'] += 1
        STATE['last_err'] = '已有发送在进行中（worker 忙）'
        return None, STATE['last_err'], 503

    tmpdir = None
    proc = None
    try:
        tmpdir = tempfile.mkdtemp(prefix='wxworker_')
        result_path = os.path.join(tmpdir, 'result.json')
        cmd = [sys.executable, os.path.abspath(__file__), '--send-once',
               '--group', str(group), '--result', result_path]
        if text is not None:
            text_path = os.path.join(tmpdir, 'text.txt')
            with open(text_path, 'w', encoding='utf-8') as f:
                f.write(text)
            cmd += ['--text-file', text_path]
        if img_path:
            cmd += ['--img', img_path]

        # ⚠️ 用 CREATE_NO_WINDOW 而【不是】CREATE_NEW_CONSOLE。选型过程（9/27 实测）：
        #    · 先前按「无可见窗口启动的进程会在 1~2 分钟内被硬杀」的铁律选了新控制台；
        #    · 但实测发现 worker 每次弹控制台会【抢走前台焦点】→ 微信被挤到后面 →
        #      guia 随即报「未找到微信主窗口」→ 发送失败（连发 4 条全废）。
        #    · worker 只活几秒，不适用"长驻进程被硬杀"那条规律；不给窗口既能避免抢焦点，
        #      也不影响它对交互式桌面的访问（窗口站/桌面由会话决定，与有无控制台无关）。
        #      配合 worker 内先 _bring_wechat_front()，发送链路可自给自足。
        creationflags = int(getattr(subprocess, 'CREATE_NO_WINDOW', 0)) if os.name == 'nt' else 0
        _worker_log("父进程 spawn worker: group=%s text_len=%d img=%s" %
                    (group, len(text or ''), bool(img_path)))
        proc = subprocess.Popen(cmd, cwd=os.path.dirname(os.path.abspath(__file__)),
                                close_fds=True, creationflags=creationflags)
        STATE['worker_pid'] = proc.pid

        deadline = time.time() + WORKER_TIMEOUT
        while time.time() < deadline and proc.poll() is None:
            time.sleep(0.4)

        if proc.poll() is None:
            # 超时。⚠️ wxauto「发送后不返回」是常态，而消息通常【已经发出】→
            #    按「可能已送达」上报 errcode=0，避免上层重试产生重复消息；
            #    但写入 STATE['last_warn'] 并在 /health 暴露，不掩盖事实。
            STATE['send_timeout'] += 1
            _kill_worker(proc)
            STATE['last_err'] = 'worker 超时 >%gs，已强杀；消息可能已送达' % WORKER_TIMEOUT
            STATE['last_warn'] = STATE['last_err']
            _mark_stuck(STATE['last_err'])
            _worker_log("⚠️ worker 超时，已强杀 pid=%s" % (proc.pid,))
            return group, None, None

        # 读结果（worker 是原子落地，通常一次就读到）
        res = None
        for _ in range(6):
            if os.path.exists(result_path):
                try:
                    with open(result_path, 'r', encoding='utf-8') as f:
                        res = json.load(f)
                    break
                except Exception:
                    res = None
            time.sleep(0.3)

        if not res:
            STATE['send_fail'] += 1
            STATE['last_err'] = 'worker 退出但无结果文件（rc=%s）' % proc.returncode
            _mark_stuck(STATE['last_err'])
            return None, STATE['last_err'], 502

        # worker 回报的展示性字段
        if res.get('sessions') is not None:
            STATE['sessions'] = res['sessions']
        if res.get('wechat_version'):
            STATE['wechat_version'] = res['wechat_version']
        if res.get('driver'):
            STATE['driver'] = res['driver']
        STATE['worker_last_ms'] = res.get('ms')

        if res.get('ok'):
            STATE['send_ok'] += 1
            STATE['last_ok_ts'] = time.time()
            STATE['last_err'] = ''
            STATE['last_warn'] = ''
            _clear_stuck()
            return res.get('target') or group, None, None

        STATE['send_fail'] += 1
        STATE['last_err'] = res.get('err') or 'unknown'
        _mark_stuck('worker 发送失败: ' + STATE['last_err'])
        return None, STATE['last_err'], 502

    except Exception as e:                            # noqa: BLE001
        STATE['send_fail'] += 1
        STATE['last_err'] = 'worker 调度异常: %s' % str(e)[:300]
        _mark_stuck(STATE['last_err'])
        return None, STATE['last_err'], 502
    finally:
        try:
            if proc is not None and proc.poll() is None:
                _kill_worker(proc)
        except Exception:
            pass
        try:
            if tmpdir:
                import shutil
                shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass
        WORKER_LOCK.release()


# ── HTTP 接口 ─────────────────────────────────────────────
app = Flask(__name__)


def _run_send_with_timeout(group, text=None, img_path=None):
    """发送总入口。默认走【一次性 worker 子进程】（见文件头 SEND_MODE 说明）。

    v3（2026-09-27）：默认不再在服务进程内调用 wxauto。原因见 SEND_MODE 注释——
    guia 的窗口句柄是进程全局缓存，同进程第二次发送必崩（"第 1 条成功、第 2 条必崩"）。
    设 WXBRIDGE_SEND_MODE=inproc 可退回下面原有的进程内发送实现。
    """
    if SEND_MODE == 'worker':
        return _send_via_worker(group, text=text, img_path=img_path)

    # ── 以下为旧的进程内发送实现（inproc 模式 / 应急回滚用）──
    # 在子线程里执行发送 + 超时熔断。
    #
    # 为什么必须这样做（实测）：wxauto 的 COM/UIA 调用一旦卡住，**无法从外部中断**；
    # 若不设超时，Flask 请求会一直挂着 → 调用方只看到 timeout → 也无法判断服务是否还可用。
    # 超时后：① 立刻返回错误给调用方（快速失败）② 标记 stuck → /health 如实上报
    import threading as _th
    box = {}

    def _work():
        try:
            box['target'] = send_to_group(group, text=text, img_path=img_path)
            box['ok'] = True
        except Exception as e:                      # noqa: BLE001
            box['ok'] = False
            box['err'] = str(e)[:300]

    STATE['inflight'] += 1
    t = _th.Thread(target=_work, daemon=True)
    t.start()
    t.join(SEND_TIMEOUT)

    if t.is_alive():
        STATE['inflight'] -= 1
        STATE['send_timeout'] += 1
        _mark_stuck('发送超时 >%gs（wxauto 卡死，可能是微信窗口不在前台/UI 变更）' % SEND_TIMEOUT)
        return None, ('发送超时 >%gs，已熔断（/health 的 stuck=true）' % SEND_TIMEOUT), 504

    STATE['inflight'] -= 1
    if box.get('ok'):
        STATE['send_ok'] += 1
        STATE['last_ok_ts'] = time.time()
        _clear_stuck()
        STATE['last_err'] = ''
        _refresh_cache()
        return box.get('target'), None, None
    STATE['send_fail'] += 1
    STATE['last_err'] = box.get('err', 'unknown')
    _mark_stuck('发送失败: ' + STATE['last_err'])
    return None, STATE['last_err'], None


@app.route("/send", methods=["POST"])
def send():
    group = request.args.get("group") or request.args.get("群名")
    payload = request.get_json(silent=True) or {}
    msgtype = payload.get("msgtype")
    STATE['last_req_ts'] = time.time()
    LOG.info("收到推送 → 群[%s] msgtype=%s mode=%s driver=%s stuck=%s",
             group, msgtype, SEND_MODE, STATE['driver'] or DRIVER_NAME, STATE['stuck'])

    # ⚠️ v2 修正：**stuck 不再拒绝请求**（v1 的 503 会造成"白丢推送"）
    # 依据：实测桥"卡住"时消息其实仍能发出（微信端可见），拒绝请求只会让通知丢失。
    # 此处仅记录一行告警，照常尝试发送；stuck 作为观测标记由 /health 暴露。
    if STATE['stuck']:
        LOG.warning("服务处于 stuck 状态，仍继续尝试发送（上次错误: %s）", STATE['last_err'])

    if msgtype == "news":
        try:
            articles = (payload.get("news") or {}).get("articles") or []
            if not articles:
                raise ValueError("news.articles 为空")
            art = articles[0]
            text = "\n".join(t for t in [art.get("title", ""), art.get("description", "")] if t)
            url = art.get("url") or ""
            if url:
                text = f"{text}\n点击查看地图: {url}" if text else f"点击查看地图: {url}"
            img_path = None
            picurl = art.get("picurl") or ""
            if picurl:
                try:
                    img_path = download_image(picurl)
                    LOG.info("卡片图已下载: %s", picurl)
                except Exception as e:
                    LOG.warning("卡片图下载失败(忽略): %s", e)
                    img_path = None
            sent_target, err, code = _run_send_with_timeout(group, text=text, img_path=img_path)
            if err:
                LOG.error("news 发送失败: %s", err)
                return jsonify({"errcode": -1, "errmsg": err}), (code or 502)
            return jsonify({"errcode": 0, "errmsg": "ok", "group": sent_target,
                            "driver": STATE['driver'] or DRIVER_NAME,
                            "mode": SEND_MODE,
                            "warn": STATE['last_warn'] or None})
        except Exception as e:
            LOG.error("news 发送异常: %s", e)
            _mark_stuck('news 异常: ' + str(e)[:200])
            return jsonify({"errcode": -1, "errmsg": str(e)[:200]}), 502

    if msgtype == "markdown":
        try:
            content = (payload.get("markdown") or {}).get("content") or ""
            text = md_to_text(content)
            sent_target, err, code = _run_send_with_timeout(group, text=text)
            if err:
                LOG.error("markdown 发送失败: %s", err)
                return jsonify({"errcode": -1, "errmsg": err}), (code or 502)
            return jsonify({"errcode": 0, "errmsg": "ok", "group": sent_target,
                            "driver": STATE['driver'] or DRIVER_NAME,
                            "mode": SEND_MODE,
                            "warn": STATE['last_warn'] or None})
        except Exception as e:
            LOG.error("markdown 发送异常: %s", e)
            _mark_stuck('markdown 异常: ' + str(e)[:200])
            return jsonify({"errcode": -1, "errmsg": str(e)[:200]}), 502

    return jsonify({"errcode": -1, "errmsg": f"不支持的 msgtype: {msgtype}"})


@app.route("/ping", methods=["GET"])
def ping():
    """最轻量存活探针（毫秒级，绝不触碰微信）—— 仅证明「进程还在」"""
    return jsonify({"pong": True, "uptime_s": round(time.time() - STATE["started_at"], 1)})


@app.route("/health", methods=["GET"])
def health():
    """健康检查（纯内存，绝不触碰微信）

    返回值语义：
      ok            : 综合健康（未卡死 且 最近有成功交互）
      stuck         : 有发送超时未返回 → 需要外部重启
      inflight      : 正在进行的发送数
      last_ok_s     : 距上次成功与微信交互的秒数（过大=与微信失联）
      last_err      : 最近一次错误
      sessions/wechat_version: 缓存值（可能为 null，仅供展示，不保证实时）
      send_mode/worker : 发送执行方式与最近一次 worker 的 PID/耗时（v3）
      last_warn        : 非致命但需人知道的情况（如 worker 超时、消息可能已送达）
    """
    now = time.time()
    age = now - STATE["last_ok_ts"]
    # ③ stuck 自动衰减：长时间无请求时不应永久锁死
    if STATE["stuck"] and STATE["stuck_since"] and (now - STATE["stuck_since"]) > STUCK_TTL:
        _clear_stuck()
        STATE["last_ok_ts"] = now
        STATE["last_err"] = ""
    stuck = STATE["stuck"]
    # ⚠️ v2 修正：新鲜度只在「收到过请求之后」才生效 —— 桥空闲（无飞行）本就是正常状态，
    #    旧逻辑会让凌晨无任务时一直报 ok=false，反而掩盖真实问题。
    has_req = STATE["last_req_ts"] is not None
    ok = (not stuck) and ((not has_req) or age < HEALTH_STALE_S)
    d = {
        "ok": ok,
        "stuck": stuck,
        "stuck_s": (round(now - STATE["stuck_since"], 1) if STATE["stuck_since"] else None),
        "inflight": STATE["inflight"],
        "last_ok_s": round(age, 1),
        "last_err": STATE["last_err"][:300],
        "driver": STATE["driver"] or DRIVER_NAME,
        "sessions": STATE["sessions"],
        "wechat_version": STATE["wechat_version"],
        "uptime_s": round(now - STATE["started_at"], 1),
        "send": {"ok": STATE["send_ok"], "fail": STATE["send_fail"], "timeout": STATE["send_timeout"]},
        "send_timeout_s": SEND_TIMEOUT,
        "send_mode": SEND_MODE,
        "worker": {"pid": STATE["worker_pid"], "last_ms": STATE["worker_last_ms"], "timeout_s": WORKER_TIMEOUT},
        "last_warn": (STATE["last_warn"] or "")[:300],
        "idle": (not has_req),          # true = 从未收到过推送请求（空闲，正常）
        "stuck_ttl_s": STUCK_TTL,
    }
    # 兼容旧调用方：旧版依赖 ok/wx/"connected" 判断可用性
    d["wx"] = "connected" if ok else ("stuck" if stuck else "stale")
    return jsonify(d)


@app.route("/status", methods=["GET"])
def status():
    """人工排查用：完整状态"""
    return jsonify({k: (v if not isinstance(v, float) else round(v, 2)) for k, v in STATE.items()})


@app.route("/reset-stuck", methods=["POST"])
def reset_stuck():
    """人工确认后清除卡死标记（重启桥后一般不需要）"""
    _clear_stuck()
    STATE["last_ok_ts"] = time.time()
    return jsonify({"errcode": 0, "errmsg": "stuck 已清除"})

if __name__ == "__main__":
    # 一次性 worker 模式（由父进程 spawn）：不启 Flask，做完一次发送就硬退出
    if '--send-once' in sys.argv:
        run_send_once()          # 内部 os._exit，正常不会返回
        raise SystemExit(0)

    ap = argparse.ArgumentParser(description="普通微信群推送桥接服务 (多驱动)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口(默认 18888)")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址(默认 0.0.0.0)")
    args = ap.parse_args()

    LOG.info("=" * 60)
    LOG.info("普通微信群推送桥接服务 v3 启动: http://%s:%d", args.host, args.port)
    LOG.info("发送模式 SEND_MODE=%s（worker=每次发送用一次性子进程；inproc=进程内发送）", SEND_MODE)
    LOG.info("worker 超时 %gs；worker 日志 %s", WORKER_TIMEOUT, WORKER_LOG)
    LOG.info("请确保微信 PC 客户端已登录（建议小号常驻）。健康检查: GET /health")
    LOG.info("=" * 60)
    app.run(host=args.host, port=args.port, threaded=True)
