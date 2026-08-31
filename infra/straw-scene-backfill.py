#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
秸秆检测场景标签回填脚本（P2-①）
==================================
作用：为 straw_detections 历史记录回填 scene 场景标签：
  - dock   机场期（Dock 机场流 sikong_8UUXN*，画面=机库/停机坪，无秸秆判定意义）
  - sim    模拟流（jgfs_sim / straw-sim* / test* / picall 截图采集流）
  - night  夜间（帧灰度均值 <25 判夜；图片缺失时按 ts 时间窗 19:00-05:00 兜底）
  - day    白天（其余）

用法（服务器执行，用 straw-engine venv 才有 cv2）：
  /opt/jsc/straw-engine/venv/bin/python /tmp/straw-scene-backfill.py [--batch 200] [--dry-run]

安全：
  - 先备份整表（CREATE TABLE straw_detections_bak_p2 AS SELECT *）
  - 按 id 分批 UPDATE，可随时中断续跑（跳过已回填的 id）
"""
import argparse
import json
import os
import sqlite3
import sys
import time

DB = "/opt/jsc/backend/data/jsc.db"
EVIDENCE_ROOT = "/opt/jsc/straw-engine"
NIGHT_BRIGHT = 25          # 与引擎 nightBright 一致
NIGHT_TIME_WIN = (19, 5)   # 19:00 - 05:00 兜底时间窗
DOCK_PREFIX = "sikong_8UUXN"

# 模拟/采集流判定：stream_id 含这些关键字 或 source 属于采集类
SIM_STREAM_KEYS = ("jgfs_sim", "straw-sim", "test", "picall")
SIM_SOURCES = ("picall", "picall_random")

try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
    print("[warn] 无 cv2，夜间判定仅用时间窗兜底", file=sys.stderr)


def frame_brightness(frame_path):
    """读证据图灰度均值；失败返回 None（调用方走时间窗兜底）"""
    if not HAS_CV2 or not frame_path:
        return None
    rel = str(frame_path).replace("/api/evidence/", "")
    cands = []
    if rel.startswith("evidence") or rel.startswith("evidence/"):
        cands.append(os.path.join(EVIDENCE_ROOT, rel))
    else:
        cands.append(os.path.join(EVIDENCE_ROOT, "evidence", rel))
        cands.append(os.path.join(EVIDENCE_ROOT, rel))
    for p in cands:
        if os.path.exists(p):
            try:
                img = cv2.imread(p)
                if img is None:
                    return None
                return float(img.mean())
            except Exception:
                return None
    return None


def ts_is_night(ts):
    """时间窗判定：19:00-05:00"""
    if not ts or len(ts) < 13:
        return False
    try:
        h = int(ts[11:13])
    except (ValueError, IndexError):
        return False
    return h >= NIGHT_TIME_WIN[0] or h < NIGHT_TIME_WIN[1]


def classify(row):
    """按优先级返回 scene：dock > sim > night/day；row 为 dict 或 sqlite3.Row"""
    if hasattr(row, "keys"):
        row = dict(row)
    sid = str(row.get("stream_id") or "")
    src = str(row.get("source") or "")
    # 1. 机场期
    if sid.startswith(DOCK_PREFIX):
        return "dock"
    # 2. 模拟/采集流
    if any(k in sid for k in SIM_STREAM_KEYS) or src in SIM_SOURCES:
        return "sim"
    # 3. 夜间：亮度 <25 与 时间窗 19:00-05:00 双条件取或（报告口径：亮度为主 + 时间窗兜底）
    #    注意：晚上 21 点无人机图亮度可能 70+（路灯/夜景模式），但时间窗已命中 → 判 night
    if not sid.startswith("sikong_"):
        return "day"  # 非司空流但非模拟 → 按白天（无更多信息）
    b = frame_brightness(row.get("frame_path"))
    if (b is not None and b < NIGHT_BRIGHT) or ts_is_night(row.get("ts")):
        return "night"
    return "day"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=int, default=200)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    # 0. 备份（仅首次）
    try:
        conn.execute("SELECT 1 FROM straw_detections_bak_p2 LIMIT 1").fetchone()
        print("[info] 备份表 straw_detections_bak_p2 已存在，跳过备份")
    except sqlite3.OperationalError:
        if args.dry_run:
            print("[dry-run] 将创建备份表 straw_detections_bak_p2")
        else:
            print("[backup] 创建备份表 straw_detections_bak_p2 ...")
            conn.execute("CREATE TABLE straw_detections_bak_p2 AS SELECT * FROM straw_detections")
            conn.commit()
            print("[backup] 完成")

    # 1. 加 scene 列（幂等）
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(straw_detections)")]
    if "scene" not in cols:
        if args.dry_run:
            print("[dry-run] 将 ALTER TABLE ADD COLUMN scene")
        else:
            conn.execute("ALTER TABLE straw_detections ADD COLUMN scene TEXT DEFAULT ''")
            conn.commit()
            print("[migrate] scene 列已加")
    else:
        print("[info] scene 列已存在")

    # 2. 分批回填
    pending = conn.execute(
        "SELECT id FROM straw_detections WHERE scene IS NULL OR scene = '' ORDER BY id"
    ).fetchall()
    total = len(pending)
    print(f"[fill] 待回填 {total} 条（含无 scene 历史记录）")
    if args.dry_run:
        # 展示抽样分类结果
        sample = conn.execute("SELECT * FROM straw_detections ORDER BY id DESC LIMIT 10").fetchall()
        for r in sample:
            print(f"  id={r['id']} {r['stream_id']} -> {classify(r)}")
        print("[dry-run] 未写库")
        return

    done = 0
    t0 = time.time()
    for i in range(0, len(pending), args.batch):
        batch_ids = [r["id"] for r in pending[i:i + args.batch]]
        marks = ",".join("?" * len(batch_ids))
        rows = conn.execute(
            f"SELECT id, stream_id, ts, frame_path, source FROM straw_detections WHERE id IN ({marks})",
            batch_ids,
        ).fetchall()
        for row in rows:
            scene = classify(row)
            conn.execute("UPDATE straw_detections SET scene = ? WHERE id = ?", (scene, row["id"]))
        conn.commit()
        done += len(rows)
        el = time.time() - t0
        print(f"  [{done}/{total}] 批次完成，耗时 {el:.1f}s", flush=True)

    # 3. 结果统计
    dist = conn.execute("SELECT scene, COUNT(*) c FROM straw_detections GROUP BY scene ORDER BY c DESC").fetchall()
    print("\n[result] scene 分布:")
    for r in dist:
        print(f"  {r['scene'] or '(空)'}: {r['c']}")
    conn.close()
    print(f"\n完成，总耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
