#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 9/9 两段视频（064U_1036 + 0S4G_1132）的人工复核页"""
import json, os, glob, shutil

BASE = '/video/shujuji/xunlian/train_0909'
OUT_DIR = '/opt/jsc/frontend/train_0909'
os.makedirs(f'{OUT_DIR}/frames', exist_ok=True)

# 1. 收集两段视频的帧列表 + 检出 conf
detect_stat = json.load(open(f'{BASE}/detect_stat.json'))
videos = ['064U_1036', '0S4G_1132']
frames = []
conf_map = {}
for vid in videos:
    stat = detect_stat.get(vid, {})
    hit_frames = {f[0]: f[1] for f in stat.get('frames', [])}
    files = sorted(glob.glob(f'{BASE}/frames_{vid}/*.jpg'))
    for fp in files:
        fname = os.path.basename(fp)
        new_name = f'{vid}_{fname}'
        dst = f'{OUT_DIR}/frames/{new_name}'
        if not os.path.exists(dst):
            shutil.copy(fp, dst)
        conf = hit_frames.get(fname)
        frames.append({'file': new_name, 'vid': vid, 'conf': conf})

print(f'帧总数: {len(frames)} (064U_1036 {sum(1 for f in frames if f["vid"]=="064U_1036")} + 0S4G_1132 {sum(1 for f in frames if f["vid"]=="0S4G_1132")})')

# 2. 生成复核页 HTML
frames_js = json.dumps(frames, ensure_ascii=False)
html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>9/9 无人机视频人工复核（064U_1036 + 0S4G_1132）</title>
<style>
  :root{{--ink:#1f2733;--mut:#5c6b7f;--line:#dbe2ec;--soft:#f4f7fb;--blue:#1b4f9e;--blue2:#eaf1fb;--red:#c0392b;--red2:#fdecea;--amber:#b7791f;--amber2:#fff7e6;--green:#1e8e5a;--green2:#e7f5ee;--cyan:#00aaff}}
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{font-family:"Microsoft YaHei",system-ui,sans-serif;color:var(--ink);font-size:14px;line-height:1.6;background:#f2f5f9;height:100vh;display:flex;flex-direction:column;overflow:hidden}}
  .topbar{{background:#fff;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}}
  .topbar h1{{font-size:16px;color:var(--blue)}}
  .topbar .hint{{font-size:12px;color:var(--mut)}}
  .topbar .stats{{display:flex;gap:12px;font-size:12px;margin-left:auto}}
  .stat b{{font-size:16px}}
  .grid{{flex:1;overflow-y:auto;padding:14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;align-content:start}}
  .card{{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}}
  .card .imgwrap{{position:relative;background:#000;cursor:zoom-in;aspect-ratio:4/3}}
  .card img{{width:100%;height:100%;object-fit:cover;display:block}}
  .card .vid{{position:absolute;top:5px;left:6px;font-size:10px;background:rgba(0,0,0,0.6);color:#fff;padding:1px 6px;border-radius:3px;font-family:monospace}}
  .card .conf{{position:absolute;top:5px;right:6px;font-size:10px;background:rgba(0,170,255,0.85);color:#fff;padding:1px 6px;border-radius:3px;font-weight:700}}
  .card .meta{{padding:6px 10px;display:flex;flex-direction:column;gap:4px;flex:1}}
  .card .fname{{font-family:monospace;font-size:10px;color:var(--ink)}}
  .verdict{{display:flex;gap:4px;padding:6px 8px;border-top:1px solid var(--line)}}
  .verdict button{{flex:1;border:1px solid var(--line);background:#fff;border-radius:4px;padding:5px 0;font-size:11px;cursor:pointer}}
  .verdict button.smoke.on{{background:var(--red);color:#fff;border-color:var(--red)}}
  .verdict button.nosmoke.on{{background:var(--green);color:#fff;border-color:var(--green)}}
  .verdict button.unsure.on{{background:var(--amber);color:#fff;border-color:var(--amber)}}
  .card[data-v="smoke"]{{border-color:var(--red);box-shadow:0 0 0 2px var(--red2)}}
  .card[data-v="nosmoke"]{{border-color:var(--green)}}
  .card[data-v="unsure"]{{border-color:var(--amber)}}
  .modal{{position:fixed;inset:0;background:rgba(0,0,0,0.9);display:none;align-items:center;justify-content:center;z-index:100;cursor:zoom-out}}
  .modal img{{max-width:96vw;max-height:96vh}}
  .filter button{{border:1px solid var(--line);background:#fff;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer}}
  .filter button.on{{background:var(--blue);color:#fff;border-color:var(--blue)}}
</style>
</head>
<body>
<div class="topbar">
  <h1>🛸 9/9 无人机视频人工复核（064U_1036 + 0S4G_1132）</h1>
  <span class="hint">逐帧复核：真烟/无烟/不确定。检出 conf 低的稀释远烟也要确认。标注后可画框。</span>
  <div class="stats">
    <div class="stat"><b id="sTotal">0</b> 总帧</div>
    <div class="stat" style="color:var(--red)"><b id="sSmoke">0</b> 有烟</div>
    <div class="stat" style="color:var(--green)"><b id="sNosmoke">0</b> 无烟</div>
    <div class="stat" style="color:var(--amber)"><b id="sUnsure">0</b> 不确定</div>
    <div class="stat"><b id="sDone">0</b> 已复核</div>
  </div>
  <div class="filter" style="display:flex;gap:4px">
    <button onclick="exportResult()" style="background:var(--green);color:#fff;border-color:var(--green)">导出复核结果</button>
    <button onclick="setFilter('smoke',this)">有烟</button>
    <button onclick="setFilter('nosmoke',this)">无烟</button>
    <button onclick="setFilter('unsure',this)">不确定</button>
    <button onclick="setFilter('todo',this)" class="on">待复核</button>
    <button onclick="setFilter('all',this)">全部</button>
  </div>
</div>
<div class="grid" id="grid"></div>
<div class="modal" id="modal" onclick="this.style.display='none'"><img id="modalImg"></div>
<script>
const FRAMES = {frames_js}
const STORAGE_KEY = 'review_0909_two'
let verdicts = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{{}}')
let filter = 'todo'

function render() {{
  const grid = document.getElementById('grid')
  grid.innerHTML = ''
  FRAMES.forEach(item => {{
    const v = verdicts[item.file] || ''
    if (filter === 'todo' && v) return
    if (filter !== 'all' && filter !== 'todo' && v !== filter) return
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.v = v
    const confHtml = item.conf ? `<div class="conf">检出 ${{(item.conf*100).toFixed(0)}}%</div>` : ''
    card.innerHTML = `
      <div class="imgwrap" onclick="zoom('frames/${{item.file}}')">
        <img loading="lazy" src="frames/${{item.file}}">
        <div class="vid">${{item.vid}}</div>
        ${{confHtml}}
      </div>
      <div class="meta">
        <div class="fname">${{item.file.replace('.jpg','')}}</div>
      </div>
      <div class="verdict">
        <button class="smoke ${{v==='smoke'?'on':''}}" onclick="mark('${{item.file}}','smoke',this)">🔥 有烟</button>
        <button class="nosmoke ${{v==='nosmoke'?'on':''}}" onclick="mark('${{item.file}}','nosmoke',this)">✓ 无烟</button>
        <button class="unsure ${{v==='unsure'?'on':''}}" onclick="mark('${{item.file}}','unsure',this)">? 不确定</button>
      </div>`
    grid.appendChild(card)
  }})
  updateStats()
}}

function mark(file, v, btn) {{
  if (verdicts[file] === v) delete verdicts[file]
  else verdicts[file] = v
  localStorage.setItem(STORAGE_KEY, JSON.stringify(verdicts))
  render()
}}

function setFilter(f, btn) {{
  filter = f
  document.querySelectorAll('.filter button').forEach(b => b.classList.remove('on'))
  if (btn) btn.classList.add('on')
  render()
}}

function updateStats() {{
  let smoke=0, nosmoke=0, unsure=0, done=0
  Object.values(verdicts).forEach(v => {{ if(v==='smoke')smoke++; else if(v==='nosmoke')nosmoke++; else if(v==='unsure')unsure++; if(v)done++ }})
  document.getElementById('sSmoke').textContent = smoke
  document.getElementById('sNosmoke').textContent = nosmoke
  document.getElementById('sUnsure').textContent = unsure
  document.getElementById('sDone').textContent = done
  document.getElementById('sTotal').textContent = FRAMES.length
}}

function zoom(src) {{
  document.getElementById('modalImg').src = src
  document.getElementById('modal').style.display = 'flex'
}}

function exportResult() {{
  const smokeFrames = FRAMES.filter(item => verdicts[item.file] === 'smoke').map(item => item.file)
  const out = {{
    videos: ['064U_1036', '0S4G_1132'],
    total: FRAMES.length,
    humanSmoke: smokeFrames.length,
    smokeFrames,
    verdicts,
    exportedAt: new Date().toISOString(),
  }}
  const blob = new Blob([JSON.stringify(out, null, 2)], {{type: 'application/json'}})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'review_0909_two.json'
  a.click()
}}

render()
</script>
</body>
</html>
'''

open(f'{OUT_DIR}/review.html', 'w', encoding='utf-8').write(html)
print(f'复核页已生成: {OUT_DIR}/review.html')
print(f'帧图: {OUT_DIR}/frames/ ({len(glob.glob(f"{OUT_DIR}/frames/*.jpg"))} 张)')
