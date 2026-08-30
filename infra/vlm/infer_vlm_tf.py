import base64, json, glob, os, sys, time
import torch
from transformers import Qwen2_5_VLForConditionalGeneration, AutoProcessor

CAND = "/video/shujuji/datasets/v5_candidates/record"
OUT = "/video/shujuji/datasets/v5_candidates/vlm_results.json"
# 默认 3B（显存 24GB 被 straw-engine+驻留进程占 6GB，7B bf16 ~20GB 会 OOM；3B 仅 ~10GB 稳跑）
MODEL_DIR = "/video/llm_infer/model3b"
PROMPT = ("这是一张无人机航拍照片。请仔细判断画面中是否有烟雾："
          "注意区分——远处的细微白烟/烟柱/烟团是烟雾；云、雾霾、炊烟、房屋、晾晒物不是烟雾。"
          "请只回答两个字：有烟 或 无烟。")

def main(start, end):
    print("loading model...", flush=True)
    model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        MODEL_DIR, torch_dtype=torch.bfloat16, device_map="cuda:0")
    processor = AutoProcessor.from_pretrained(MODEL_DIR)
    frames = sorted(glob.glob(CAND + "/*/f*.jpg"))[start:end]
    results = {}
    t0 = time.time()
    for i, fp in enumerate(frames):
        try:
            msgs = [{"role": "user", "content": [
                {"type": "image", "image": fp},
                {"type": "text", "text": PROMPT}]}]
            text = processor.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
            inputs = processor(text=[text], images=[fp], return_tensors="pt").to("cuda:0")
            with torch.inference_mode():
                out = model.generate(**inputs, max_new_tokens=16, do_sample=False)
                ans = processor.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
            results[fp] = ans
            print(f"[{i+1}/{len(frames)}] {os.path.basename(os.path.dirname(fp))} -> {ans}", flush=True)
        except Exception as e:
            results[fp] = "ERR:" + str(e)[:60]
            print(f"[{i+1}/{len(frames)}] {fp} ERR {e}", flush=True)
        if (i + 1) % 20 == 0:
            prev = {}
            if os.path.exists(OUT):
                try:
                    prev = json.load(open(OUT))
                except Exception:
                    pass
            prev.update(results)
            json.dump(prev, open(OUT, "w"), ensure_ascii=False, indent=1)
            print(f"  checkpoint saved ({len(prev)} total)", flush=True)
    prev = {}
    if os.path.exists(OUT):
        try:
            prev = json.load(open(OUT))
        except Exception:
            pass
    prev.update(results)
    json.dump(prev, open(OUT, "w"), ensure_ascii=False, indent=1)
    print(f"done {len(frames)} frames in {time.time()-t0:.0f}s -> {OUT}", flush=True)

if __name__ == "__main__":
    s = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    e = int(sys.argv[2]) if len(sys.argv) > 2 else 9999
    main(s, e)
