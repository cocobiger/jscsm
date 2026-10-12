# -*- coding: utf-8 -*-
"""
wx_login_probe.py —— 「微信是否已登录」判据定标探针（T1）

目的：在【同一个会话、同一套依赖】下，把一组候选信号一次性采集出来，
      供"未登录态"与"已登录态"两次运行做对照，找出真正稳定的判据。

背景：桥的 /health 用 STATE['driver']/['sessions']/['wechat_version'] 判断登录，
      但这三个字段只在发送成功后才被填（_refresh_cache 全文件仅 1 处调用），
      且 get_self_info() 永远返回 dict ⇒ 该判据不可用。
      本探针要回答的是：**到底哪个信号能可靠区分登录/未登录**。

候选信号：
  A. WeChatDB() 能否构造成功（含 _pick_account / _load_or_extract_keys 两步）
  B. get_self_info().nick_name 是否非空
  C. get_sessions() 条数
  D. get_groups() 条数
  E. 微信窗口几何（登录窗实测 296x388；登录后主窗口更大）
  F. guia / quick_send 是否可导入

输出：C:\\wxbridge\\deploy\\wx_login_probe.json （UTF-8，含每项耗时与完整错误串）
必须跑在【交互式会话】里（schtasks /IT），与桥的运行条件一致。
"""
import json
import os
import time
import traceback

OUT = r"C:\wxbridge\deploy\wx_login_probe.json"
WEIXIN_EXE = r"C:\Program Files\Tencent\Weixin\Weixin.exe"

result = {"started_at": time.strftime("%F %T"), "pid": os.getpid(),
          "signals": {}, "windows": [], "account_dirs": []}


def rec(name, fn):
    t0 = time.time()
    try:
        v = fn()
        result["signals"][name] = {"ok": True, "ms": int((time.time() - t0) * 1000), "value": v}
    except Exception as e:
        result["signals"][name] = {
            "ok": False, "ms": int((time.time() - t0) * 1000),
            "error": "%s: %s" % (type(e).__name__, e),
            "trace": traceback.format_exc(limit=3)[-600:],
        }


# ── 微信版本（纯读 exe 文件版本，与登录无关，作为"对照常量"） ──
def _version():
    import win32api
    info = win32api.GetFileVersionInfo(WEIXIN_EXE, "\\")
    ms, ls = info["FileVersionMS"], info["FileVersionLS"]
    return "%d.%d.%d.%d" % (ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF)


# ── A. 账号目录（磁盘上存在 ≠ 已登录，用来区分"从没登录过"和"登录过又退出了"） ──
def _account_dirs():
    from wechatauto.db import _find_account_dirs, auto_detect_db_dir
    d = auto_detect_db_dir()
    res = {"db_dir": d, "exists": bool(d and os.path.isdir(d)) if d else False, "accounts": []}
    if d and os.path.isdir(d):
        for a in _find_account_dirs(d):
            storage = os.path.join(a, "db_storage")
            n = 0
            newest = 0
            for root, _, files in os.walk(storage):
                for f in files:
                    if f.endswith(".db") and not f.endswith("-wal"):
                        n += 1
                        try:
                            newest = max(newest, os.path.getmtime(os.path.join(root, f)))
                        except Exception:
                            pass
            res["accounts"].append({
                "name": os.path.basename(a),
                "has_db_storage": os.path.isdir(storage),
                "db_count": n,
                "newest_db": time.strftime("%F %T", time.localtime(newest)) if newest else None,
            })
    return res


DB = {}


# ── B. WeChatDB() 构造（关键：_pick_account + _load_or_extract_keys 都在里面） ──
def _db_ctor():
    from wechatauto import WeChatDB
    db = WeChatDB()
    DB["db"] = db
    return {
        "account": db.account,
        "wxid": db.wxid,
        "db_files": len(getattr(db, "_db_files", [])),
        "keys_loaded": len(getattr(db, "_keys", {}) or {}),
        "master_key_present": bool(getattr(db, "master_key", None)),
        "workdir": getattr(db, "workdir", None),
    }


def _self_info():
    return DB["db"].get_self_info()


def _sessions():
    s = DB["db"].get_sessions(limit=100)
    return {"count": len(s), "sample": s[:3]}


def _groups():
    g = DB["db"].get_groups()
    return {"count": len(g), "names": [x.get("name") for x in g[:15]],
            "member_counts": [x.get("member_count") for x in g[:15]]}


def _search_contact():
    c = DB["db"].search_contact("a")
    return {"count": len(c), "sample": c[:3]}


def _guia_import():
    from wechatauto.guia import quick_send, quick_send_file
    return {"quick_send": callable(quick_send), "quick_send_file": callable(quick_send_file)}


# ── E. 窗口几何 ──
def _windows():
    import win32gui

    def cb(h, _):
        try:
            if not win32gui.IsWindowVisible(h):
                return True
            cls = win32gui.GetClassName(h)
            txt = win32gui.GetWindowText(h)
            if ("Qt" in cls) or ("微信" in txt) or ("Weixin" in txt) or ("WeChat" in txt):
                r = win32gui.GetWindowRect(h)
                result["windows"].append({
                    "hwnd": h, "cls": cls, "title": txt,
                    "rect": list(r), "size": [r[2] - r[0], r[3] - r[1]],
                    "is_login_size": (r[2] - r[0], r[3] - r[1]) == (296, 388),
                })
        except Exception:
            pass
        return True

    win32gui.EnumWindows(cb, None)
    return len(result["windows"])


rec("wechat_version", _version)
rec("account_dirs", _account_dirs)
rec("windows", _windows)
rec("db_ctor", _db_ctor)
if "db" in DB:
    rec("self_info", _self_info)
    rec("sessions", _sessions)
    rec("groups", _groups)
    rec("search_contact", _search_contact)
rec("guia_import", _guia_import)

result["finished_at"] = time.strftime("%F %T")

try:
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
except Exception as e:
    try:
        print("write failed:", e)
    except Exception:
        pass
