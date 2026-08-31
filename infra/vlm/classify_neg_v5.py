#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P3-2a: 负样本 5 类干扰物 VLM 预分类（2026-09-01 + 2026-09-01 reflection 追加）— transformers 路线

输入: /video/shujuji/datasets/v5_candidates/neg_list.json （359 帧无烟负样本）
输出: /video/shujuji/datasets/v5_candidates/neg_classified.json
类别:
  pole       电线杆/电线塔/通信塔
  concrete   水泥地/硬化地面/道路/广场/屋顶平台
  cloud      云彩/云朵/雾霭
  building   民居/建筑物/房屋/厂房
  reflection 江面/湖泊/水面倒影（平静水面反射的天空与岸物轮廓）
  none       画面干净无典型干扰物
  other      其他干扰物（raw 记录说明）

用法: python classify_neg_v5.py [start] [end]（增量断点续跑）
模型: Qwen2.5-VL-3B-Instruct bf16（/video/llm_infer/model3b）
背景: ollama 二进制残缺（llama-server 缺失）不可用，走 transformers 路线（已验证）
"""
import json, os, sys, time
import torch
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

NEG_LIST = "/video/shujuji/datasets/v5_candidates/neg_list.json"
OUT = "/video/shujuji/datasets/v5_candidates/neg_classified.json"
MODEL_DIR = "/video/llm_infer/model3b"
VALID = {"pole", "concrete", "cloud", "building", "reflection", "none", "other"}

PROMPT = (
    "这是一张无人机航拍照片。请判断画面中最明显的干扰物类型（这些都不是烟雾，只是常见背景物）。\n"
    "可选类别：\n"
    "- pole：电线杆/电线塔/通信塔/高架杆塔\n"
    "- concrete：水泥地/硬化地面/道路/广场/屋顶平台\n"
    "- cloud：云彩/云朵/雾霭\n"
    "- building：民居/建筑物/房屋/厂房\n"
    "- none：画面干净，无上述典型干扰物\n"
    "- other：其他干扰物（请注明是什么）\n"
    "如果画面同时有多个干扰物，按明显程度列出最多 2 个，用英文逗号分隔（如 pole,concrete）。\n"
    "只输出类别代码，不要输出其他文字。\n"
    "（注：reflection 江面倒影暂未启用，v6 数据集出现真实水面场景时再开放）"
)


def normalize(ans):
    parts = [p.strip() for p in ans.replace("，", ",").replace("、", ",").split(",") if p.strip()]
    cats = [p for p in parts if p in VALID][:2]
    return cats


def main(start, end):
    print("loading model 3B...", flush=True)
    t_load = time.time()
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL_DIR, torch_dtype=torch.bfloat16, device_map="cuda:0")
    processor = AutoProcessor.from_pretrained(MODEL_DIR)
    print(f"model loaded in {time.time()-t_load:.0f}s", flush=True)

    data = json.load(open(NEG_LIST, encoding="utf-8"))
    frames = [d["frame"] for d in data]
    print(f"总帧数: {len(frames)}  本次分段: [{start}, {end})", flush=True)
    results = {}
    if os.path.exists(OUT):
        try:
            results = json.load(open(OUT, encoding="utf-8"))
            print(f"已存在 {len(results)} 条结果，跳过已分类帧", flush=True)
        except Exception:
            pass
    t0 = time.time()
    done = 0
    for i in range(start, min(end, len(frames))):
        fp = frames[i]
        if fp in results and results[fp].get("cats"):
            continue
        try:
            msgs = [{"role": "user", "content": [
                {"type": "image", "image": fp},
                {"type": "text", "text": PROMPT}]}]
            text = processor.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
            inputs = processor(text=[text], images=[fp], return_tensors="pt").to("cuda:0")
            with torch.inference_mode():
                out = model.generate(**inputs, max_new_tokens=32, do_sample=False)
                ans = processor.decode(out[0][inputs.input_ids.shape[1]:],
                                       skip_special_tokens=True).strip().lower()
            cats = normalize(ans)
            results[fp] = {"cats": cats, "raw": ans[:60],
                           "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
            print(f"[{i+1}/{len(frames)}] {os.path.basename(os.path.dirname(fp))}/{os.path.basename(fp)} -> {cats} ({ans[:40]})", flush=True)
        except Exception as e:
            results[fp] = {"cats": [], "raw": "ERR:" + str(e)[:50],
                           "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
            print(f"[{i+1}/{len(frames)}] {fp} ERR {e}", flush=True)
        done += 1
        if done % 20 == 0 or i == min(end, len(frames)) - 1:
            json.dump(results, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            print(f"  checkpoint {len(results)}/{len(frames)}", flush=True)
    json.dump(results, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"done {done} frames in {time.time()-t0:.0f}s -> {OUT}", flush=True)


if __name__ == "__main__":
    s = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    e = int(sys.argv[2]) if len(sys.argv) > 2 else 9999
    main(s, e)
