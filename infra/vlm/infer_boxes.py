#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 Qwen2.5-VL-3B 给 41 帧有烟帧画烟框（grounding）
- 复用 /video/llm_infer/{model3b,venv}，不重新加载模型
- 输出 boxes.json: { "frame_path": [[x1,y1,x2,y2]_0_1000, ...], ... }
- 坐标为 0-1000 相对值（Qwen2.5-VL 标准输出格式）
"""
import os, sys, json, re
import torch
from PIL import Image
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

MODEL_DIR = "/video/llm_infer/model3b"
CAND = "/video/shujuji/datasets/v5_candidates"
REC = f"{CAND}/record"
RES_FILE = f"{CAND}/vlm_results.json"
OUT = "/video/llm_infer/boxes.json"

PROMPT = ("这是一张无人机航拍照片。如果画面中存在秸秆燃烧产生的烟雾"
          "（灰白或淡蓝色烟柱、烟团，常出现在山坳、农田、路边，边缘柔和、缓慢飘散），"
          "请用 JSON 数组格式输出每个烟雾区域的边界框 [[x1,y1,x2,y2]]，"
          "坐标为相对值（0-1000，左上角原点，x 向右、y 向下）。"
          "如果没有烟，输出 []。"
          "重要：云、雾、炊烟、房屋白顶、夜间灯火、远山轮廓线不是秸秆烟，不要标。")


def parse_boxes(text):
    """从模型输出文本中提取所有 [[x1,y1,x2,y2],...]"""
    text = text.strip()
    # 尝试直接 JSON 解析
    try:
        arr = json.loads(text)
        if isinstance(arr, list):
            return [[float(v) for v in box] if len(box) == 4 else None for box in arr]
    except Exception:
        pass
    # 退而求其次：用正则匹配所有 4 元组
    out = []
    for m in re.finditer(r"\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]", text):
        out.append([float(m.group(i)) for i in (1, 2, 3, 4)])
    return [b for b in out if b]


def main():
    res = json.load(open(RES_FILE, encoding="utf-8"))
    smoke = sorted(k for k, v in res.items() if "烟" in v and "无烟" not in v)
    print(f"目标 {len(smoke)} 帧")

    boxes = {}
    if os.path.exists(OUT):
        try:
            boxes = json.load(open(OUT, encoding="utf-8"))
            print(f"续跑：已有 {len(boxes)} 帧结果")
        except Exception:
            boxes = {}

    print("加载模型...")
    proc = AutoProcessor.from_pretrained(MODEL_DIR, trust_remote_code=True)
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL_DIR, torch_dtype=torch.bfloat16, device_map="cuda:0", trust_remote_code=True
    ).eval()

    for i, path in enumerate(smoke, 1):
        if path in boxes:
            continue
        try:
            im = Image.open(path).convert("RGB")
            w, h = im.size
            # 限制最大像素避免显存爆炸
            max_pix = 1280 * 720
            if w * h > max_pix:
                scale = (max_pix / (w * h)) ** 0.5
                im = im.resize((int(w * scale), int(h * scale)))
            messages = [{"role": "user", "content": [
                {"type": "image", "image": im},
                {"type": "text", "text": PROMPT},
            ]}]
            text = proc.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = proc(text=[text], images=[im], return_tensors="pt").to("cuda:0")
            with torch.no_grad():
                gen = model.generate(**inputs, max_new_tokens=128, do_sample=False)
            out_text = proc.batch_decode(gen[:, inputs.input_ids.shape[1]:], skip_special_tokens=True)[0]
            b = parse_boxes(out_text)
            boxes[path] = b
            tag = ("box x" + str(len(b))) if b else "no box"
            print(f"[{i}/{len(smoke)}] {os.path.basename(os.path.dirname(path))}/{os.path.basename(path)} -> {tag} | raw: {out_text[:80]!r}")
        except Exception as e:
            print(f"[{i}/{len(smoke)}] ERR {path}: {e}")
            boxes[path] = []
        if i % 5 == 0:
            json.dump(boxes, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)

    json.dump(boxes, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
    total = sum(len(v) for v in boxes.values())
    print(f"\n完成：{len(boxes)} 帧，共 {total} 框 -> {OUT}")


if __name__ == "__main__":
    main()
