#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v5 扩源：从 9 段有烟视频抽出的 1258 帧中，VLM 预筛出"含烟"帧
输入: /video/shujuji/datasets/v5_live_frames/  9 个子目录
输出: /video/shujuji/datasets/v5_live_frames_smoke.json
模型: Qwen2.5-VL-3B-Instruct bf16（/video/llm_infer/model3b）
三态: smoke=明显烟柱/烟团, maybe=疑似（薄/远/模糊）, no=无烟
"""
import json, os, sys, time, glob
import torch
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

ROOT = "/video/shujuji/datasets/v5_live_frames"
OUT = "/video/shujuji/datasets/v5_live_frames_smoke.json"
MODEL_DIR = "/video/llm_infer/model3b"
VALID = {"smoke", "maybe", "no"}

PROMPT = (
    "这是一张无人机航拍照片。请判断画面中是否有烟雾（秸秆燃烧/柴火/工业烟/任何冒烟）。\n"
    "输出三态之一：\n"
    "- smoke：画面能清晰看到白色或灰色烟柱/烟团/烟雾（最常见是田里冒出的细长白烟柱）\n"
    "- maybe：疑似有烟（很淡、距离很远、模糊难辨）\n"
    "- no：画面无烟（建筑/道路/天空/水面/山丘等干净画面）\n"
    "只输出状态代码（小写英文），不要输出其他文字。"
)


def normalize(ans):
    ans = ans.strip().lower()
    for v in VALID:
        if v in ans:
            return v
    return "no"


def main():
    # 收集所有 jpg
    files = sorted(glob.glob(f"{ROOT}/**/f*.jpg", recursive=True))
    print(f"待预筛帧: {len(files)}", flush=True)

    # 加载已处理（断点续）
    out = []
    done_paths = set()
    if os.path.exists(OUT):
        out = json.load(open(OUT, encoding="utf-8"))
        done_paths = {x["path"] for x in out}
        print(f"已处理: {len(out)}, 续跑", flush=True)

    pending = [f for f in files if f not in done_paths]
    print(f"剩余: {len(pending)}", flush=True)
    if not pending:
        print("全部完成")
        return

    t0 = time.time()
    print("loading model 3B...", flush=True)
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL_DIR, torch_dtype=torch.bfloat16, device_map="cuda"
    )
    processor = AutoProcessor.from_pretrained(MODEL_DIR)
    print(f"model loaded in {time.time()-t0:.0f}s", flush=True)

    # 推理
    from PIL import Image
    t0 = time.time()
    for i, fp in enumerate(pending):
        try:
            img = Image.open(fp).convert("RGB")
            msgs = [{"role": "user", "content": [
                {"type": "image", "image": img},
                {"type": "text", "text": PROMPT}]}]
            text = processor.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
            inputs = processor(text=[text], images=[img], return_tensors="pt").to("cuda")
            with torch.no_grad():
                out_ids = model.generate(**inputs, max_new_tokens=16, do_sample=False)
            ans = processor.batch_decode(out_ids[:, inputs.input_ids.shape[1]:],
                                          skip_special_tokens=True)[0].strip()
            v = normalize(ans)
        except Exception as e:
            v = "no"
            ans = f"err:{e}"
        rel = fp.replace(ROOT + "/", "")
        out.append({"path": fp, "rel": rel, "verdict": v, "raw": ans})
        if (i + 1) % 50 == 0 or v == "smoke":
            n_smoke = sum(1 for x in out if x["verdict"] == "smoke")
            n_maybe = sum(1 for x in out if x["verdict"] == "maybe")
            print(f"  [{i+1}/{len(pending)}] {v} | smoke={n_smoke} maybe={n_maybe} "
                  f"| {time.time()-t0:.0f}s", flush=True)
            json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    n_smoke = sum(1 for x in out if x["verdict"] == "smoke")
    n_maybe = sum(1 for x in out if x["verdict"] == "maybe")
    n_no = len(out) - n_smoke - n_maybe
    print(f"\n[done] total={len(out)} smoke={n_smoke} maybe={n_maybe} no={n_no} | {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
