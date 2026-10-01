#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""prescreen.py —— VLM 批量预筛：过帧 → 出「候选正样本清单 + 难负池」→ 生成复核台

在标注流水线里的位置
    录制/抽帧 → **本步（VLM 预筛）** → 人工复核准入 → 协议 v1.2 五档整框标注 → 入训练集
                 ├─ VLM 判「有」 → **候选正样本**（人工只需在"真有烟"的图上整框，省掉大批无烟帧）
                 └─ VLM 判「无」 → **候选难负池**（尤其"模型报了但 VLM 判无烟"的 = hard negative）

⚠️ 定位提醒（别再走弯路）：VLM **只做二分类预筛/难负挖掘**，**不做**出框、**不做**文字提示驱动 YOLO
（已论证：普通 YOLO 不接受文字提示；grounding VLM 对小目标定位精度不足）。

性能（2026-10-01 实测，RTX 3090 + qwen2.5vl:7b，**热态**）
```
裸回答(只答 有/无)            0.10 s/帧
schema 仅 has_smoke           0.26 s/帧
schema + reason（默认）       0.37 s/帧   ⇒ 1000 帧 ≈ 6 分钟
```
⚠️ **冷启动另计 ~30 s**（模型被 `OLLAMA_KEEP_ALIVE` 卸载后首次调用）⇒ 本脚本在请求里带
`keep_alive`（默认 30m），批跑期间模型常驻，避免反复重载。

用法
  # 1) 批量预筛（可中断，续跑自动跳过已完成）
  prescreen.py run    --dir /data/video/shujuji/datasets/v5_live_frames/<tag> [--limit 100] [--pattern '*.jpg'] [--no-reason]
  # 2) 生成复核台（单文件 HTML，缩略图内嵌，打开即可标注/导出）
  prescreen.py review --dir <同上> [--max-embed 600]
  # 3) 看汇总
  prescreen.py summary --dir <同上>
  # 4) 单图调试
  prescreen.py one    --image /path/x.jpg
"""
from __future__ import annotations

import argparse
import base64
import glob
import io
import json
import os
import re
import sys
import time
import urllib.request

OLLAMA = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
MODEL = os.environ.get('VLM_MODEL', 'qwen2.5vl:7b')
SUB = '_prescreen'

PROMPT_BASE = ('你是秸秆焚烧监控的画面复核员。只判断这张画面里有没有【烟雾】或【明火】。\n'
               '判为「无」的情况：云雾、水汽、扬尘、工业排气/蒸汽、车灯或水面反光、晚霞。\n'
               '判为「不确定」的情况：疑似但看不清、目标太小无法判断。\n')
# ⚠️ 两个提示词必须分开：用 schema 时可以说"只输出 JSON"；不用 schema 时**绝不能说**，
#    否则 qwen2.5vl 会把结果包成 ```json 围栏，解析要额外清洗（实测踩过）。
PROMPT_JSON = PROMPT_BASE + '只输出 JSON。'
PROMPT_BARE = PROMPT_BASE + '只回答一个词：有 或 无 或 不确定。'

SCHEMA = {
    'type': 'object',
    'properties': {
        'has_smoke': {'type': 'string', 'enum': ['有', '无', '不确定']},
        'reason': {'type': 'string'},
    },
    'required': ['has_smoke'],
}
SCHEMA_MIN = {
    'type': 'object',
    'properties': {'has_smoke': {'type': 'string', 'enum': ['有', '无', '不确定']}},
    'required': ['has_smoke'],
}

_VERDICT_MAP = {'有': '有', '是': '有', 'yes': '有', '有烟': '有',
                '无': '无', '否': '无', 'no': '无', '没有': '无', '无烟': '无',
                '不确定': '不确定', '疑似': '不确定', 'unknown': '不确定'}


def log(*a):
    print(*a, flush=True)


def sub_dir(d):
    p = os.path.join(d, SUB)
    os.makedirs(p, exist_ok=True)
    return p


def _post(path, body, timeout=300):
    req = urllib.request.Request(OLLAMA + path, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def ask_vlm(image_path, use_schema=True, with_reason=True, keep_alive='30m', timeout=300):
    """返回 (verdict, reason, raw, elapsed)"""
    b64 = base64.b64encode(open(image_path, 'rb').read()).decode()
    body = {'model': MODEL, 'prompt': PROMPT_JSON if use_schema else PROMPT_BARE,
            'images': [b64], 'stream': False,
            'keep_alive': keep_alive,                     # 批跑期间常驻，避免反复冷启动(~30s)
            'options': {'temperature': 0, 'num_predict': 96 if with_reason else 32}}
    if use_schema:
        body['format'] = SCHEMA if with_reason else SCHEMA_MIN
    t0 = time.time()
    d = _post('/api/generate', body, timeout=timeout)
    raw = (d.get('response') or '').strip()
    verdict, reason = None, ''
    try:
        j = json.loads(raw)
        verdict = _VERDICT_MAP.get(str(j.get('has_smoke', '')).strip())
        reason = str(j.get('reason', ''))[:200]
    except Exception:
        pass
    if verdict is None:                      # 兜底：文本匹配（含 ```json 围栏的情况）
        m = re.search(r'不确定|疑似|(^|[^不])有烟|明火|\b有\b|没有|无烟|\b无\b', raw)
        verdict = _VERDICT_MAP.get(m.group(0).strip().lstrip('不'), '不确定') if m else '不确定'
        reason = raw[:200]
    return verdict, reason, raw, time.time() - t0


def cmd_one(a):
    v, r, raw, el = ask_vlm(a.image, with_reason=not a.no_reason)
    log('verdict=%s  用时 %.2fs' % (v, el))
    log('reason=%s' % r)
    log('raw=%r' % raw[:300])
    return 0


def load_done(resfile):
    done = {}
    if os.path.exists(resfile):
        for line in open(resfile, encoding='utf-8'):
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                done[o['file']] = o
            except Exception:
                pass
    return done


def cmd_run(a):
    d = a.dir
    sd = sub_dir(d)
    resfile = os.path.join(sd, 'results.jsonl')
    done = load_done(resfile)
    files = sorted(glob.glob(os.path.join(d, a.pattern)))
    # 只排除元数据文件；**不要**按 "_" 前缀排除（抽帧产物常以 _tag_ 开头，会被误杀）
    files = [f for f in files if os.path.basename(f) not in ('meta.json',)]
    todo = [f for f in files if os.path.basename(f) not in done]
    if a.limit:
        todo = todo[:a.limit]
    log('=== 预筛 %s ===' % d)
    log('  总帧 %d｜已完成 %d｜本次处理 %d｜模型 %s' % (len(files), len(done), len(todo), MODEL))

    use_schema = True
    ok = fail = 0
    t0 = time.time()
    with open(resfile, 'a', encoding='utf-8') as w:
        for i, f in enumerate(todo, 1):
            for attempt in (1, 2):
                try:
                    v, r, raw, el = ask_vlm(f, use_schema=use_schema, with_reason=not a.no_reason)
                    break
                except Exception as e:
                    if attempt == 1 and use_schema:
                        # 可能是 format(schema) 不被支持 → 退回纯文本
                        log('  [warn] schema 模式失败(%s)，切纯文本模式' % type(e).__name__)
                        use_schema = False
                        continue
                    v, r, raw, el = '错误', str(e)[:200], '', 0.0
            rec = {'file': os.path.basename(f), 'verdict': v, 'reason': r,
                   'elapsed': round(el, 2), 'at': time.strftime('%F %T')}
            w.write(json.dumps(rec, ensure_ascii=False) + '\n')
            w.flush()
            if v == '错误':
                fail += 1
            else:
                ok += 1
            if i % 10 == 0 or i == len(todo):
                el_tot = time.time() - t0
                log('  [%d/%d] 最近 %s ｜ 均 %.2fs/帧 ｜ 预计剩余 %.0f 分钟'
                    % (i, len(todo), v, el_tot / i, (len(todo) - i) * el_tot / i / 60))

    allres = load_done(resfile)
    pos = [k for k, o in allres.items() if o.get('verdict') == '有']
    neg = [k for k, o in allres.items() if o.get('verdict') == '无']
    unc = [k for k, o in allres.items() if o.get('verdict') == '不确定']
    err = [k for k, o in allres.items() if o.get('verdict') == '错误']
    for name, lst in (('pos.txt', pos), ('neg.txt', neg), ('uncertain.txt', unc)):
        with open(os.path.join(sd, name), 'w', encoding='utf-8') as w:
            w.write('\n'.join(sorted(lst)) + ('\n' if lst else ''))
    summary = {'dir': d, 'model': MODEL, 'total': len(allres), 'pos': len(pos), 'neg': len(neg),
               'uncertain': len(unc), 'error': len(err), 'at': time.strftime('%F %T')}
    json.dump(summary, open(os.path.join(sd, 'summary.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    log('')
    log('=== 汇总 ===')
    log('  有(候选正) %d ｜ 无(难负候选) %d ｜ 不确定 %d ｜ 错误 %d' % (len(pos), len(neg), len(unc), len(err)))
    log('  清单: %s/{pos,neg,uncertain}.txt   明细: results.jsonl' % sd)
    log('  下一步: prescreen.py review --dir %s' % d)
    return 0


def cmd_summary(a):
    p = os.path.join(sub_dir(a.dir), 'summary.json')
    if os.path.exists(p):
        log(json.dumps(json.load(open(p, encoding='utf-8')), ensure_ascii=False, indent=1))
    else:
        log('无 summary.json（先跑 run）')
    return 0


# ─────────────────── 复核台 HTML ───────────────────
TPL = r"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VLM 预筛复核台 · __TITLE__</title>
<style>
:root{--bg:#f5f7fa;--card:#fff;--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;
--blue:#1a5276;--green:#0f7b4f;--red:#b42318;--amber:#9a6700}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px}
header{position:sticky;top:0;z-index:9;background:#1a5276;color:#fff;padding:12px 18px;
display:flex;flex-wrap:wrap;gap:14px;align-items:center}
header h1{margin:0;font-size:16px;font-weight:600}
header .st{font-size:13px;opacity:.95}
header .grow{flex:1}
button{cursor:pointer;border-radius:7px;border:1px solid var(--line);background:#fff;
padding:6px 12px;font-size:13px}
button.pri{background:#2c6ca6;color:#fff;border-color:#2c6ca6}
button.yes{background:#e7f6ee;border-color:#bfe6d2;color:var(--green)}
button.no{background:#fdeceb;border-color:#f3c4c0;color:var(--red)}
button.un{background:#fff6e5;border-color:#f0dcae;color:var(--amber)}
.wrap{padding:16px 18px 80px;max-width:1500px;margin:0 auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.card.done-yes{outline:3px solid #0f7b4f}.card.done-no{outline:3px solid #b42318}
.card.done-un{outline:3px solid #9a6700}
.card img{width:100%;display:block;background:#000;cursor:zoom-in}
.card .m{padding:8px 10px}
.card .fn{font-family:Consolas,monospace;font-size:11.5px;color:var(--muted);word-break:break-all}
.vlm{font-size:12.5px;margin:4px 0}
.tag{display:inline-block;border-radius:5px;padding:1px 7px;font-weight:600;font-size:12px}
.t-yes{background:#e7f6ee;color:#0f7b4f}.t-no{background:#fdeceb;color:#b42318}
.t-un{background:#fff6e5;color:#9a6700}.t-err{background:#eee;color:#555}
.btns{display:flex;gap:6px;margin-top:6px}
.btns button{flex:1;padding:5px 0;font-size:12.5px}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;align-items:center;
justify-content:center;z-index:99;cursor:zoom-out}
#lb img{max-width:96vw;max-height:96vh;object-fit:contain}
.hint{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin-bottom:14px;font-size:13.5px;line-height:1.75}
code{background:#eef1f5;border-radius:4px;padding:1px 5px;font-family:Consolas,monospace;font-size:12.5px}
</style></head><body>
<header>
  <h1>VLM 预筛复核台</h1>
  <span class="st">待复核 <b id="n">0</b>｜已标 <b id="d">0</b>｜与 VLM 不一致 <b id="x">0</b></span>
  <span class="grow"></span>
  <button class="pri" onclick="exp()">导出 JSON</button>
  <button onclick="rst()">清空本次标注</button>
</header>
<div class="wrap">
<div class="hint">
  <b>怎么用</b>：逐张看，点「真有烟 / 没烟 / 不确定」确认。<b>这一步只做三态确认，不画框</b>——
  判为「真有烟」的图，后续走协议 v1.2 五档整框标注；判为「没烟」且模型曾报过的，进<b>难负池</b>。
  <br><b>为什么先过这一步</b>：VLM 预筛把大批无烟帧挡在人工整框之前，人工只处理"可能真烟"的那一小撮。
  <br><b>注意</b>：VLM 判定仅供参考，<b>以你的判断为准</b>；雾/水汽/扬尘/排气/反光都算「没烟」。
  <br><span id="keyhint"></span>
</div>
<div class="grid" id="g"></div>
</div>
<div id="lb" onclick="this.style.display='none'"><img id="lbi"></div>
<script>
const DATA = __DATA__;
const KEY = '__LSKEY__';
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch(e) { state = {}; }
function save(){ localStorage.setItem(KEY, JSON.stringify(state)); upd(); }
function upd(){
  const n = DATA.length, d = Object.keys(state).length;
  let x = 0; DATA.forEach(o => { const s = state[o.file];
    if (s && ((s==='有') !== (o.verdict==='有'))) x++; });
  document.getElementById('n').textContent = n - d;
  document.getElementById('d').textContent = d;
  document.getElementById('x').textContent = x;
}
function pick(f, v){
  state[f] = v; save();
  const c = document.getElementById('c-'+CSS.escape(f));
  if (c){ c.classList.remove('done-yes','done-no','done-un');
    c.classList.add(v==='有'?'done-yes':(v==='无'?'done-no':'done-un')); }
}
function zoom(src){ document.getElementById('lbi').src = src;
  document.getElementById('lb').style.display='flex'; }
function exp(){
  const out = DATA.map(o => ({file:o.file, vlm:o.verdict, human:state[o.file]||null,
    reason:o.reason||'', agree: state[o.file] ? ((state[o.file]==='有')===(o.verdict==='有')) : null}));
  const blob = new Blob([JSON.stringify({key:KEY, at:new Date().toISOString(), items:out}, null, 1)],
                        {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = KEY + '_export.json'; a.click();
}
function rst(){ if(confirm('清空本次标注？（导出的文件不受影响）')){ state={}; save();
  document.querySelectorAll('.card').forEach(c=>c.classList.remove('done-yes','done-no','done-un')); } }
(function(){
  const g = document.getElementById('g');
  DATA.forEach(o => {
    const cls = ({'有':'t-yes','无':'t-no','不确定':'t-un','错误':'t-err'})[o.verdict] || 't-err';
    const el = document.createElement('div');
    el.className = 'card'; el.id = 'c-' + o.file;
    const s = state[o.file];
    if (s) el.classList.add(s==='有'?'done-yes':(s==='无'?'done-no':'done-un'));
    el.innerHTML =
      '<img loading="lazy" src="'+o.thumb+'" onclick="zoom(this.src)">' +
      '<div class="m"><div class="fn">'+o.file+'</div>' +
      '<div class="vlm">VLM <span class="tag '+cls+'">'+o.verdict+'</span> ' +
      (o.reason? '<span style="color:#6b7280">'+o.reason.slice(0,60)+'</span>':'') + '</div>' +
      '<div class="btns">' +
      '<button class="yes" onclick="pick(\''+o.file.replace(/\x27/g,"\\x27")+'\',\'有\')">真有烟</button>' +
      '<button class="no" onclick="pick(\''+o.file.replace(/\x27/g,"\\x27")+'\',\'无\')">没烟</button>' +
      '<button class="un" onclick="pick(\''+o.file.replace(/\x27/g,"\\x27")+'\',\'不确定\')">不确定</button>' +
      '</div></div>';
    g.appendChild(el);
  });
  document.getElementById('keyhint').textContent = '本次标注保存在浏览器 localStorage，键：' + KEY;
  upd();
})();
</script></body></html>
"""


def make_thumb(path, width=300, quality=72):
    from PIL import Image
    try:
        im = Image.open(path).convert('RGB')
    except Exception:
        return None
    r = width / float(im.width)
    im = im.resize((width, max(1, int(im.height * r))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=quality, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def cmd_review(a):
    d = a.dir
    sd = sub_dir(d)
    resfile = os.path.join(sd, 'results.jsonl')
    if not os.path.exists(resfile):
        log('无 results.jsonl，先跑 prescreen.py run'); return 1
    allres = load_done(resfile)
    order = {'有': 0, '不确定': 1, '错误': 2, '无': 3}      # 候选正在前，难负在后
    items = sorted(allres.values(), key=lambda o: (order.get(o.get('verdict'), 9), o['file']))
    if a.max_embed and len(items) > a.max_embed:
        log('  ⚠️ 条目 %d 超过 --max-embed %d，只内嵌前 %d 条' % (len(items), a.max_embed, a.max_embed))
        items = items[:a.max_embed]
    data = []
    miss = 0
    for o in items:
        p = os.path.join(d, o['file'])
        t = make_thumb(p) if os.path.exists(p) else None
        if not t:
            miss += 1
            continue
        data.append({'file': o['file'], 'verdict': o.get('verdict', '?'),
                     'reason': o.get('reason', ''), 'thumb': t})
    key = 'jsc_prescreen_%s_v1' % re.sub(r'\W+', '_', os.path.basename(d.rstrip('/'))) 
    html = (TPL.replace('__TITLE__', os.path.basename(d.rstrip('/')))
               .replace('__DATA__', json.dumps(data, ensure_ascii=False))
               .replace('__LSKEY__', key))
    out = os.path.join(sd, 'review.html')
    open(out, 'w', encoding='utf-8').write(html)
    log('  ✅ 复核台: %s（%d 条，%d 条缩略图缺失已跳过）｜ %.1f MB'
        % (out, len(data), miss, os.path.getsize(out) / 1048576))
    log('     localStorage 键: %s' % key)
    return 0


def main():
    ap = argparse.ArgumentParser()
    sp = ap.add_subparsers(dest='cmd', required=True)
    p1 = sp.add_parser('run'); p1.add_argument('--dir', required=True)
    p1.add_argument('--pattern', default='*.jpg'); p1.add_argument('--limit', type=int, default=0)
    p1.add_argument('--no-reason', action='store_true', help='只要 有/无（更快：0.26 vs 0.37 s/帧）')
    p2 = sp.add_parser('review'); p2.add_argument('--dir', required=True)
    p2.add_argument('--max-embed', type=int, default=600)
    p3 = sp.add_parser('summary'); p3.add_argument('--dir', required=True)
    p4 = sp.add_parser('one'); p4.add_argument('--image', required=True)
    p4.add_argument('--no-reason', action='store_true')
    a = ap.parse_args()
    return {'run': cmd_run, 'review': cmd_review, 'summary': cmd_summary, 'one': cmd_one}[a.cmd](a)


if __name__ == '__main__':
    sys.exit(main())
