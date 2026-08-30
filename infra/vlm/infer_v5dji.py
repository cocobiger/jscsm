#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 AI 预标注：v5_smoke_v3 best.pt → 4 张 DJI 真烟照片初始框

- 模型: /video/xunlian/runs/detect/v5_smoke_v3/base/weights/best.pt
- IMGSZ=1280, conf=0.10, iou=0.5（低阈值保留全部候选，人工复核合并）
- 只取 cls=0 (smoke)；归一化 cx/cy/w/h（YOLO 格式）
- 输出: dji_ai_labels.json（原始框+conf）→ 回填 v3_spec.json frames[*].boxes
- 整框优先：AI 碎片小框仅为位置提示，用户复核时须合并为完整烟团框
  （细分多框是 v5-v3 召回 2.4% 的根因，一帧=一个完整烟框）

用法: /opt/jsc/straw-engine/venv/bin/python3 infer_v5dji.py
"""
import json, os, shutil, time
from ultralytics import YOLO

V3_PT = "/video/xunlian/runs/detect/v5_smoke_v3/base/weights/best.pt"
DJI   = "/video/llm_infer/v5_photos/dji_photo"
SPEC  = "/video/llm_infer/v3_spec.json"
OUT   = "/video/llm_infer/dji_ai_labels.json"
IMGSZ = 1280
CONF  = 0.10
IOU   = 0.5


def main():
    photos = sorted(f for f in os.listdir(DJI) if f.lower().endswith((".jpg", ".jpeg")))
    print(f"[info] 待预标照片: {len(photos)} 张", flush=True)
    model = YOLO(V3_PT)
    result = {}
    for name in photos:
        fp = os.path.join(DJI, name)
        r = model.predict(fp, imgsz=IMGSZ, conf=CONF, iou=IOU, verbose=False)[0]
        w, h = r.orig_shape[1], r.orig_shape[0]
        dets = []
        for box in r.boxes:
            if int(box.cls[0]) != 0:
                continue
            x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]
            dets.append({
                "cx":   round((x1 + x2) / 2 / w, 6),
                "cy":   round((y1 + y2) / 2 / h, 6),
                "w":    round((x2 - x1) / w, 6),
                "h":    round((y2 - y1) / h, 6),
                "conf": round(float(box.conf[0]), 4),
            })
        result[name] = {"wh": [w, h], "boxes": dets}
        print(f"[detect] {name}: {w}x{h} smoke={len(dets)}", flush=True)
        for d in dets:
            print(f"    conf={d['conf']:.3f}  cx={d['cx']:.4f} cy={d['cy']:.4f}  "
                  f"w={d['w']:.4f} h={d['h']:.4f}", flush=True)

    json.dump(result, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[saved] {OUT}", flush=True)

    # ---- 回填 v3_spec.json（仅 dji_photo 帧；先备份原 spec） ----
    bak = SPEC + f".bak_{time.strftime('%Y%m%d_%H%M%S')}"
    shutil.copy(SPEC, bak)
    print(f"[backup] {bak}", flush=True)

    spec = json.load(open(SPEC, encoding="utf-8"))
    n = 0
    for fr in spec["frames"]:
        if fr.get("src") != "dji_photo":
            continue
        name = os.path.basename(fr["rel"]) + ".jpg"
        if name not in result:
            continue
        boxes = [[0, d["cx"], d["cy"], d["w"], d["h"]] for d in result[name]["boxes"]]
        fr["boxes"] = boxes
        note = fr.get("note", "").rstrip(" |")
        fr["note"] = f"{note} | AI预标{len(boxes)}框待复核(整框优先)".strip(" |")
        n += 1
    json.dump(spec, open(SPEC, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"[backfilled] {n} 帧 -> v3_spec.json", flush=True)


if __name__ == "__main__":
    main()
