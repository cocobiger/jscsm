#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
9/9 人工复核+标框页 v3
新增（相对 v2）：
  1. 框类型：烟羽(smoke, class0) / 干扰区(distractor, 仅审计+负样本裁剪，不进正样本)
  2. 帧判定新增：干扰无烟 / 无效帧（全黑/切流，自动预标）
  3. 自动探测全黑帧 -> 预标 invalid
  4. 复制上一帧框（视频相邻帧烟位近似，大幅提速）
  5. 导出拆分为 smokeFrames(正样本) + distractors(干扰区) + invalidFrames
"""
import os, json, glob
import numpy as np
from PIL import Image

FR_DIR = '/opt/jsc/frontend/train_0909/frames'
OUT = '/opt/jsc/frontend/train_0909/review.html'
STAT = '/video/xunlian/train_0909/detect_stat.json'
VIDEOS = ['064U_1036', '0S4G_1132']

detect_stat = {}
if os.path.exists(STAT):
    detect_stat = json.load(open(STAT))

frames = []
invalid = []
for vid in VIDEOS:
    hit = {f[0]: f[1] for f in detect_stat.get(vid, {}).get('frames', [])}
    for fp in sorted(glob.glob(f'{FR_DIR}/{vid}_f*.jpg')):
        name = os.path.basename(fp)
        orig = name.split('_', 1)[1]
        a = np.asarray(Image.open(fp).convert('RGB')).astype(np.float32)
        v = float(a.mean())
        sd = float(a.std())
        dark = (v < 8.0) or (sd < 3.0)
        if dark:
            invalid.append(name)
        frames.append({
            'file': name, 'vid': vid, 'conf': hit.get(orig),
            'bright': round(v, 1), 'night': v < 60, 'bad': dark,
        })

print(f'帧总数: {len(frames)}  全黑/无效帧: {len(invalid)}')
print('无效帧:', ', '.join(invalid))

html = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>9/9 人工复核+标框 v3（多框 / 框类型 / 无效帧）</title>
<style>
  :root{--ink:#1f2733;--mut:#5c6b7f;--line:#dbe2ec;--blue:#1b4f9e;--blue2:#eaf1fb;--red:#c0392b;--amber:#b7791f;--amber2:#fff7e6;--green:#1e8e5a;--cyan:#00aaff;--gray:#7a8a9a}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Microsoft YaHei",system-ui,sans-serif;color:var(--ink);font-size:14px;line-height:1.6;background:#f2f5f9;height:100vh;display:flex;flex-direction:column;overflow:hidden}
  .topbar{background:#fff;border-bottom:1px solid var(--line);padding:8px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .topbar h1{font-size:16px;color:var(--blue);white-space:nowrap}
  .topbar .hint{font-size:12px;color:var(--mut)}
  .stats{display:flex;gap:10px;font-size:12px;margin-left:auto;flex-wrap:wrap}
  .stat b{font-size:15px}
  .btn{border:1px solid var(--line);background:#fff;border-radius:4px;padding:4px 11px;font-size:12px;cursor:pointer}
  .grid{flex:1;overflow-y:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;align-content:start}
  .card{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
  .card[data-v="smoke"]{border-color:var(--red);box-shadow:0 0 0 2px #fdecea}
  .card[data-v="nosmoke"]{border-color:var(--green)}
  .card[data-v="distractor"]{border-color:var(--cyan)}
  .card[data-v="invalid"]{border-color:#b6bec9;opacity:.5}
  .card[data-v="unsure"]{border-color:var(--amber)}
  .imgwrap{position:relative;background:#000;cursor:zoom-in;aspect-ratio:4/3}
  .imgwrap img{width:100%;height:100%;object-fit:cover;display:block}
  .tag{position:absolute;font-size:10px;padding:1px 6px;border-radius:3px;font-family:monospace;color:#fff}
  .t-vid{top:5px;left:6px;background:rgba(0,0,0,.62)}
  .t-br{top:5px;right:6px;background:rgba(80,90,100,.85)}
  .t-conf{bottom:5px;right:6px;background:rgba(0,170,255,.9);font-weight:700}
  .t-box{bottom:5px;left:6px;background:rgba(192,57,43,.92)}
  .t-dis{bottom:5px;left:6px;background:rgba(0,170,255,.92)}
  .fname{font-family:monospace;font-size:10px;color:var(--mut);padding:4px 10px 0}
  .verdict{display:flex;gap:4px;padding:6px 8px;border-top:1px solid var(--line);flex-wrap:wrap}
  .verdict button{border:1px solid var(--line);background:#fff;border-radius:4px;padding:5px 4px;font-size:11px;cursor:pointer;flex:1;min-width:52px}
  .verdict button.boxbtn{background:var(--cyan);color:#fff;border-color:var(--cyan);flex:1 0 100%}
  .verdict button.nosmoke.on{background:var(--green);color:#fff;border-color:var(--green)}
  .verdict button.dis.on{background:var(--cyan);color:#fff;border-color:var(--cyan)}
  .verdict button.inv.on{background:var(--gray);color:#fff;border-color:var(--gray)}
  .verdict button.unsure.on{background:var(--amber);color:#fff;border-color:var(--amber)}
  #pagination{padding:8px 14px;background:#fff;border-bottom:1px solid var(--line);display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px}
  .labelmodal{position:fixed;inset:0;background:rgba(0,8,20,.97);display:none;z-index:200}
  .labelmodal .inner{position:absolute;inset:0;display:flex;flex-direction:column}
  .labelbar{background:#0a1628;padding:8px 14px;display:flex;align-items:center;gap:10px;color:#c8e6ff;font-size:13px;border-bottom:1px solid rgba(0,150,220,.2);flex-wrap:wrap}
  .labelbar .info{font-size:12px;color:#7ab8e0}
  .labelbar button{border:1px solid var(--cyan);background:transparent;color:var(--cyan);border-radius:5px;padding:6px 12px;font-size:12px;cursor:pointer}
  .labelbar button.solid{background:var(--cyan);color:#fff}
  .labelbar button.solid.green{background:var(--green);border-color:var(--green)}
  .labelbar button.solid.red{background:var(--red);border-color:var(--red)}
  .labelbar button.solid.gray{background:var(--gray);border-color:var(--gray)}
  .labelbar button.mode.on{background:#fff;color:#0a1628;border-color:#fff;font-weight:700}
  .canvaswrap{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;position:relative}
  #cv{max-width:96%;max-height:96%;cursor:crosshair;background:#000}
  .framenav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,170,255,.28);color:#fff;border:none;font-size:26px;padding:10px 14px;cursor:pointer;border-radius:6px}
  .framenav:hover{background:rgba(0,170,255,.6)}
</style>
</head>
<body>
<div class="topbar">
  <h1>🛸 9/9 复核+标框 v3</h1>
  <span class="hint">【烟羽】框=正样本；【干扰区】框=负样本；全黑帧点【无效】</span>
  <div class="stats">
    <div class="stat">总 <b id="sTotal">0</b></div>
    <div class="stat" style="color:var(--red)">有烟 <b id="sSmoke">0</b></div>
    <div class="stat" style="color:var(--green)">无烟 <b id="sNosmoke">0</b></div>
    <div class="stat" style="color:var(--cyan)">干扰 <b id="sDis">0</b></div>
    <div class="stat" style="color:var(--gray)">无效 <b id="sInv">0</b></div>
    <div class="stat" style="color:var(--amber)">不确定 <b id="sUnsure">0</b></div>
  </div>
</div>
<div class="topbar" style="border-top:none;padding-top:0">
  <button class="btn" onclick="exportAll()" style="background:var(--green);color:#fff;border-color:var(--green)">⬇ 导出标注 JSON</button>
  <button class="btn" onclick="toggleHelp()" style="background:var(--blue);color:#fff;border-color:var(--blue)">❓ 标注规则(H)</button>
  <div class="filter" style="display:flex;gap:4px;flex-wrap:wrap">
    <button class="btn on" onclick="setFilter('todo',this)">待复核</button>
    <button class="btn" onclick="setFilter('smoke',this)">有烟</button>
    <button class="btn" onclick="setFilter('nosmoke',this)">无烟</button>
    <button class="btn" onclick="setFilter('distractor',this)">干扰</button>
    <button class="btn" onclick="setFilter('invalid',this)">无效帧</button>
    <button class="btn" onclick="setFilter('all',this)">全部</button>
  </div>
  <span class="hint" id="progHint"></span>
</div>
<div id="pagination"></div>
<div class="grid" id="grid"></div>

<div class="labelmodal" id="helpModal" style="background:rgba(0,8,20,.92)">
  <div class="inner" style="align-items:center;justify-content:center;padding:20px">
    <div style="background:#fff;border-radius:12px;max-width:860px;width:100%;max-height:92%;overflow-y:auto;padding:22px 26px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <h2 style="font-size:17px;color:var(--blue);flex:1">标注规则速查</h2>
        <button class="btn" onclick="toggleHelp()" style="padding:5px 14px">✕ 关闭(H/Esc)</button>
      </div>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        <div style="flex:1 1 340px">
          <h3 style="font-size:14px;color:var(--ink);margin:0 0 8px">🎯 标注决策链（按顺序）</h3>
          <ol style="padding-left:20px;font-size:13px;line-height:1.9">
            <li><b>画面能看清吗？</b> 全黑/切流/糊成一团 → <b style="color:var(--gray)">无效帧 X</b>（不进训练）</li>
            <li><b>有烟吗？</b> 有 → 画<b style="color:var(--red)">红框</b>（自动=有烟）</li>
            <li><b>没烟，但有易误检物？</b>（夜间亮区/灯光/反光/火光）→ <b style="color:var(--cyan)">干扰无烟 I</b> + 青框</li>
            <li><b>干净背景？</b> → <b style="color:var(--green)">无烟 N</b></li>
            <li><b>拿不准？</b> → <b style="color:var(--amber)">不确定 ?</b>（本批跳过）</li>
          </ol>
          <h3 style="font-size:14px;color:var(--ink);margin:16px 0 8px">⌨️ 快捷键</h3>
          <div style="font-size:12px;line-height:1.9;color:var(--mut);font-family:monospace">
            Enter 确认并下一帧 · N 无烟 · I 干扰 · X 无效<br>
            1 烟羽框 · 2 干扰框 · C 复制上一帧框<br>
            ←→ 上一帧/下一帧 · 双击删框 · 单击框切类型 · H 帮助
          </div>
        </div>
        <div style="flex:1 1 340px;border-left:1px solid var(--line);padding-left:16px">
          <h3 style="font-size:14px;color:var(--red);margin:0 0 8px">🔥 夜间有火怎么标（核心：火 ≠ 烟）</h3>
          <ol style="padding-left:20px;font-size:13px;line-height:1.9">
            <li><b>火点 / 火光本身</b> → 画<b style="color:var(--cyan)">青框</b>（干扰区）。<b style="color:var(--red)">绝对不要画红框！</b></li>
            <li><b>火点上方能看到烟柱/烟羽</b> → 只框那一段烟（<b style="color:var(--red)">红框</b>），别把火点一起框进去</li>
            <li><b>看不出烟</b> → 点「干扰无烟 I」，火点画青框</li>
            <li>整帧判定：画了红框自动=有烟；没画红框就点 I 或 N</li>
          </ol>
          <div style="background:var(--amber2);border-left:3px solid var(--amber);padding:9px 12px;border-radius:6px;font-size:12px;line-height:1.7;margin-top:10px">
            <b>为什么火点不能标红框：</b><br>
            把火标成烟 = 教模型「橙色亮斑 = 烟」。白天它会在篝火、路灯、橙红色屋顶、锈蚀铁皮上大量误报 —— 这正是污染<b>淡烟检测</b>的最快方式。<br>
            火的正确归宿是<b>干扰区（青框）</b>：告诉模型「这里是强干扰源，不是烟」。
          </div>
          <div style="background:var(--blue2);border-left:3px solid var(--blue);padding:9px 12px;border-radius:6px;font-size:12px;line-height:1.7;margin-top:10px">
            <b>补充：</b>天空的月光云、水面反光这类「大面积亮区」如果让你犹豫「这是不是烟」，就说明它是潜在混淆源 —— 圈一个青框，同等有效。
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="labelmodal" id="labelModal">
  <div class="inner">
    <div class="labelbar">
      <span id="labFrameName" style="font-family:monospace"></span>
      <span class="info" id="labInfo"></span>
      <button class="mode on" id="modeSmoke" onclick="setMode('smoke')">框类型：烟羽</button>
      <button class="mode" id="modeDis" onclick="setMode('distractor')">干扰区</button>
      <button onclick="copyPrev()">↧ 复制上一帧框</button>
      <button class="solid green" onclick="saveLabel()">✓ 确认(Enter)</button>
      <button onclick="markAndNext('nosmoke')">无烟(N)</button>
      <button onclick="markAndNext('distractor')">干扰无烟(I)</button>
      <button class="solid gray" onclick="markAndNext('invalid')">无效帧(X)</button>
      <button onclick="clearBoxes()">删光框</button>
      <button onclick="closeLabel()">✕(Esc)</button>
    </div>
    <div class="canvaswrap">
      <canvas id="cv"></canvas>
      <button class="framenav" style="left:12px" onclick="navFrame(-1)">‹</button>
      <button class="framenav" style="right:12px" onclick="navFrame(1)">›</button>
    </div>
  </div>
</div>

<script>
const FRAMES = FRAMES_PLACEHOLDER
const PRESET_INVALID = INVALID_PLACEHOLDER
const PAGE_SIZE = 50
const CV_KEY = 'review_0909_v3_boxes'
const V_KEY = 'review_0909_v3_verdicts'
const MODE_KEY = 'review_0909_v3_mode'

let boxesMap = JSON.parse(localStorage.getItem(CV_KEY) || '{}')
let verdicts = JSON.parse(localStorage.getItem(V_KEY) || '{}')
let boxMode = localStorage.getItem(MODE_KEY) || 'smoke'
let filter = 'todo'
let page = 1
let labelIdx = -1
let curBoxes = []
let curMode = boxMode

PRESET_INVALID.forEach(f => { if (!verdicts[f]) verdicts[f] = 'invalid' })

function hasBox(f){ return (boxesMap[f] || []).length > 0 }
function smokeBoxes(f){ return (boxesMap[f] || []).filter(b => b.t !== 'distractor') }
function disBoxes(f){ return (boxesMap[f] || []).filter(b => b.t === 'distractor') }
function verdictOf(item){
  const v = verdicts[item.file]
  if (v) return v
  if (smokeBoxes(item.file).length) return 'smoke'
  if (disBoxes(item.file).length) return 'distractor'
  return ''
}

function render(){
  const grid = document.getElementById('grid')
  grid.innerHTML = ''
  const filtered = FRAMES.filter(item => {
    const v = verdictOf(item)
    if (filter === 'todo') return !v
    if (filter === 'all') return true
    return v === filter
  })
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  page = Math.max(1, Math.min(page, totalPages))
  filtered.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE).forEach(item => {
    const i = FRAMES.indexOf(item)
    const idx = boxesMap[item.file] || []
    const sb = smokeBoxes(item.file).length, db = disBoxes(item.file).length
    const v = verdictOf(item)
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.v = v
    const confHtml = item.conf ? '<div class="tag t-conf">检出 ' + (item.conf*100).toFixed(0) + '%</div>' : ''
    const boxHtml = sb ? '<div class="tag t-box">烟框 ' + sb + '</div>' : (db ? '<div class="tag t-dis">干扰 ' + db + '</div>' : '')
    card.innerHTML =
      '<div class="imgwrap" onclick="openLabel(' + i + ')">' +
        '<img loading="lazy" src="frames/' + item.file + '">' +
        '<div class="tag t-vid">' + item.vid + '</div>' +
        '<div class="tag t-br">' + item.bright + '</div>' +
        confHtml + boxHtml +
      '</div>' +
      '<div class="fname">' + item.file.replace('.jpg','') + (item.night ? ' · 夜' : '') + '</div>' +
      '<div class="verdict">' +
        '<button class="boxbtn" onclick="openLabel(' + i + ')">✏️ 标框（' + sb + '/' + db + '）</button>' +
        '<button class="nosmoke' + (v==='nosmoke'?' on':'') + '" onclick="mark(\\'' + item.file + '\\',\\'nosmoke\\')">✓无烟</button>' +
        '<button class="dis' + (v==='distractor'?' on':'') + '" onclick="mark(\\'' + item.file + '\\',\\'distractor\\')">干扰</button>' +
        '<button class="inv' + (v==='invalid'?' on':'') + '" onclick="mark(\\'' + item.file + '\\',\\'invalid\\')">无效</button>' +
        '<button class="unsure' + (v==='unsure'?' on':'') + '" onclick="mark(\\'' + item.file + '\\',\\'unsure\\')">?</button>' +
      '</div>'
    grid.appendChild(card)
  })
  renderPagination(filtered.length, totalPages)
  updateStats()
}

function renderPagination(total, totalPages){
  const pg = document.getElementById('pagination')
  pg.innerHTML = ''
  const mk = (label, p, dis, on) => {
    const b = document.createElement('button')
    b.textContent = label
    b.disabled = dis
    b.className = 'btn'
    b.style.cssText = 'padding:4px 10px;border-color:' + (on ? 'var(--cyan)' : 'var(--line)') + ';background:' + (on ? 'rgba(0,170,255,.12)' : '#fff') + ';color:' + (on ? 'var(--cyan)' : 'var(--mut)')
    b.onclick = () => { if (!dis) { page = p; render() } }
    return b
  }
  pg.appendChild(mk('← 上一页', page-1, page<=1, false))
  const start = Math.max(1, page-2), end = Math.min(totalPages, start+4)
  for (let p = start; p <= end; p++) pg.appendChild(mk(String(p), p, false, p===page))
  pg.appendChild(mk('下一页 →', page+1, page>=totalPages, false))
  const info = document.createElement('span')
  info.style.cssText = 'margin-left:8px;color:var(--mut)'
  info.textContent = '第 ' + page + ' / ' + totalPages + ' 页 · 每页 ' + PAGE_SIZE + ' 帧 · 筛选出 ' + total + ' 帧'
  pg.appendChild(info)
}

function mark(file, v){
  if (verdicts[file] === v){ delete verdicts[file] }
  else {
    if ((v === 'nosmoke' || v === 'invalid') && hasBox(file)){
      if (!confirm('该帧已画框，标记为「' + (v === 'nosmoke' ? '无烟' : '无效帧') + '」将清除这些框，确认？')) return
      delete boxesMap[file]
    }
    verdicts[file] = v
  }
  persist(); render()
}

function setFilter(f, btn){
  filter = f; page = 1
  document.querySelectorAll('.filter .btn').forEach(b => b.classList.remove('on'))
  document.querySelectorAll('.filter .btn').forEach(b => { b.style.background='#fff'; b.style.color=''; b.style.borderColor='' })
  if (btn){ btn.classList.add('on'); btn.style.background='var(--blue)'; btn.style.color='#fff'; btn.style.borderColor='var(--blue)' }
  render()
}

function updateStats(){
  let s=0,n=0,d=0,iv=0,u=0
  FRAMES.forEach(item => {
    const v = verdictOf(item)
    if (v==='smoke') s++; else if (v==='nosmoke') n++
    else if (v==='distractor') d++; else if (v==='invalid') iv++
    else if (v==='unsure') u++
  })
  document.getElementById('sSmoke').textContent = s
  document.getElementById('sNosmoke').textContent = n
  document.getElementById('sDis').textContent = d
  document.getElementById('sInv').textContent = iv
  document.getElementById('sUnsure').textContent = u
  document.getElementById('sTotal').textContent = FRAMES.length
  const done = s+n+d+iv+u
  document.getElementById('progHint').textContent = '已复核 ' + done + ' / ' + FRAMES.length + '（' + Math.round(done/FRAMES.length*100) + '%）'
}

function persist(){
  localStorage.setItem(CV_KEY, JSON.stringify(boxesMap))
  localStorage.setItem(V_KEY, JSON.stringify(verdicts))
  localStorage.setItem(MODE_KEY, boxMode)
}

const cv = document.getElementById('cv'), cx = cv.getContext('2d')
let img = new Image(), draft = null, dragMode = null, clickStart = null

function setMode(m){
  curMode = m; boxMode = m
  document.getElementById('modeSmoke').classList.toggle('on', m==='smoke')
  document.getElementById('modeDis').classList.toggle('on', m!=='smoke')
  localStorage.setItem(MODE_KEY, m)
}

function openLabel(i){
  labelIdx = i
  const item = FRAMES[i]
  curBoxes = JSON.parse(JSON.stringify(boxesMap[item.file] || []))
  const sb = curBoxes.filter(b=>b.t!=='distractor').length, db = curBoxes.filter(b=>b.t==='distractor').length
  document.getElementById('labFrameName').textContent = item.file
  document.getElementById('labInfo').textContent =
    (i+1) + '/' + FRAMES.length + ' | 亮度 ' + item.bright + (item.night?' 夜':'') +
    (item.conf ? ' | 检出 ' + (item.conf*100).toFixed(0) + '%' : '') +
    ' | 拖拽画框 · 拖框移动 · 拖角缩放 · 单击框切类型 · 双击删框 · 烟框' + sb + ' 干扰' + db
  setMode(boxMode)
  img.onload = () => { fitCanvas(); draw() }
  img.src = 'frames/' + item.file
  document.getElementById('labelModal').style.display = 'block'
}

function fitCanvas(){
  const wrap = document.querySelector('.canvaswrap')
  const pad = 30
  const maxW = wrap.clientWidth - pad, maxH = wrap.clientHeight - pad
  const ratio = img.width / img.height
  let w = maxW, h = w / ratio
  if (h > maxH){ h = maxH; w = h * ratio }
  cv.width = Math.max(100, w); cv.height = Math.max(100, h)
}

function toCanvas(b){ return {x1:b.x1*cv.width, y1:b.y1*cv.height, x2:b.x2*cv.width, y2:b.y2*cv.height} }
function toNorm(b){
  return {t:b.t,
    x1:Math.max(0,Math.min(1,b.x1/cv.width)), y1:Math.max(0,Math.min(1,b.y1/cv.height)),
    x2:Math.max(0,Math.min(1,b.x2/cv.width)), y2:Math.max(0,Math.min(1,b.y2/cv.height))}
}
function boxColor(b){ return b.t==='distractor' ? '#00d4ff' : '#ff4d4f' }

function draw(){
  cx.clearRect(0,0,cv.width,cv.height)
  if (img.width) cx.drawImage(img,0,0,cv.width,cv.height)
  curBoxes.forEach(b => drawBox(toCanvas(b), boxColor(b), false, b.t==='distractor' ? '干扰' : '烟'))
  if (draft) drawBox(draft, '#ffe600', true, '')
}

function drawBox(b, color, isDraft, label){
  cx.setLineDash(isDraft ? [6,4] : [])
  cx.strokeStyle = color; cx.lineWidth = isDraft ? 1.5 : 3
  cx.strokeRect(b.x1,b.y1,b.x2-b.x1,b.y2-b.y1)
  cx.setLineDash([])
  if (!isDraft){
    cx.fillStyle = color
    const r = 4
    ;[[b.x1,b.y1],[b.x2,b.y1],[b.x1,b.y2],[b.x2,b.y2]].forEach(p => {
      cx.beginPath(); cx.arc(p[0],p[1],r,0,Math.PI*2); cx.fill()
    })
    if (label){
      cx.font = 'bold 14px monospace'
      const tw = cx.measureText(label).width + 8
      cx.fillRect(b.x1, Math.max(0, b.y1-18), tw, 17)
      cx.fillStyle = '#000'; cx.fillText(label, b.x1+4, Math.max(13, b.y1-4))
    }
  }
}

function pos(e){ const r = cv.getBoundingClientRect(); return {x:e.clientX-r.left, y:e.clientY-r.top} }

function findBox(e){
  const p = pos(e)
  for (let bi = curBoxes.length-1; bi >= 0; bi--){
    const b = toCanvas(curBoxes[bi])
    const corners = [[b.x1,b.y1,'x1','y1'],[b.x2,b.y1,'x2','y1'],[b.x1,b.y2,'x1','y2'],[b.x2,b.y2,'x2','y2']]
    for (const c of corners){
      if (Math.hypot(p.x-c[0], p.y-c[1]) < 14) return {bi:bi, type:'corner', cx:c[2], cy:c[3]}
    }
  }
  for (let bi = curBoxes.length-1; bi >= 0; bi--){
    const b = toCanvas(curBoxes[bi])
    if (p.x>=b.x1-6 && p.x<=b.x2+6 && p.y>=b.y1-6 && p.y<=b.y2+6) return {bi:bi, type:'move'}
  }
  return null
}

cv.addEventListener('mousedown', e => {
  const hit = findBox(e)
  const p = pos(e)
  clickStart = {x:p.x, y:p.y}
  if (hit){ dragMode = hit; return }
  draft = {x1:p.x, y1:p.y, x2:p.x, y2:p.y}
  dragMode = {type:'draw'}
})

cv.addEventListener('mousemove', e => {
  if (!dragMode) return
  const p = pos(e)
  if (dragMode.type === 'draw' && draft){ draft.x2 = p.x; draft.y2 = p.y; draw(); return }
  const b = toCanvas(curBoxes[dragMode.bi])
  if (dragMode.type === 'move'){
    if (!dragMode.sx){ dragMode.sx = p.x; dragMode.sy = p.y; dragMode.bx1 = b.x1; dragMode.by1 = b.y1 }
    const dx = p.x-dragMode.sx, dy = p.y-dragMode.sy
    curBoxes[dragMode.bi] = toNorm({t:curBoxes[dragMode.bi].t, x1:dragMode.bx1+dx, y1:dragMode.by1+dy, x2:dragMode.bx1+dx+(b.x2-b.x1), y2:dragMode.by1+dy+(b.y2-b.y1)})
    draw(); return
  }
  if (dragMode.type === 'corner'){
    const nb = {t:curBoxes[dragMode.bi].t, x1:b.x1, y1:b.y1, x2:b.x2, y2:b.y2}
    nb[dragMode.cx] = p.x; nb[dragMode.cy] = p.y
    if (Math.abs(nb.x2-nb.x1) < 10) return
    if (Math.abs(nb.y2-nb.y1) < 10) return
    curBoxes[dragMode.bi] = toNorm(nb); draw(); return
  }
})

cv.addEventListener('mouseup', e => {
  if (dragMode && dragMode.type === 'draw' && draft){
    const nb = toNorm({t:curMode, x1:Math.min(draft.x1,draft.x2), y1:Math.min(draft.y1,draft.y2), x2:Math.max(draft.x1,draft.x2), y2:Math.max(draft.y1,draft.y2)})
    if ((nb.x2-nb.x1)*cv.width > 14 && (nb.y2-nb.y1)*cv.height > 14) curBoxes.push(nb)
  }
  if (dragMode && (dragMode.type === 'move' || dragMode.type === 'corner') && e){
    const p = pos(e)
    if (clickStart && Math.hypot(p.x-clickStart.x, p.y-clickStart.y) < 5){
      const b = curBoxes[dragMode.bi]
      if (b.t === 'distractor'){ b.t = 'smoke' } else { b.t = 'distractor' }
    }
  }
  draft = null; dragMode = null; clickStart = null; draw()
})

cv.addEventListener('dblclick', e => {
  const hit = findBox(e)
  if (hit && hit.type !== 'corner'){ curBoxes.splice(hit.bi,1); draw() }
})

function clearBoxes(){ if (confirm('删光本帧所有框？')){ curBoxes = []; draw() } }

function copyPrev(){
  if (labelIdx <= 0) return
  const prev = FRAMES[labelIdx-1].file
  const pb = boxesMap[prev] || []
  if (!pb.length){ alert('上一帧也没有框'); return }
  curBoxes = JSON.parse(JSON.stringify(pb))
  draw()
}

function applyVerdict(item){
  const sb = curBoxes.filter(b => b.t !== 'distractor')
  const db = curBoxes.filter(b => b.t === 'distractor')
  if (sb.length){ verdicts[item.file] = 'smoke' }
  else if (db.length && !verdicts[item.file]){ verdicts[item.file] = 'distractor' }
}

function saveLabel(){
  const item = FRAMES[labelIdx]
  if (curBoxes.length) boxesMap[item.file] = JSON.parse(JSON.stringify(curBoxes))
  else delete boxesMap[item.file]
  applyVerdict(item)
  if (!verdicts[item.file]) verdicts[item.file] = 'nosmoke'
  persist(); closeLabel()
  const next = FRAMES.findIndex((f, i) => i > labelIdx && !verdictOf(f))
  if (next >= 0) openLabel(next)
}

function markAndNext(v){
  const item = FRAMES[labelIdx]
  if (v !== 'smoke'){
    if (curBoxes.length) boxesMap[item.file] = JSON.parse(JSON.stringify(curBoxes))
    if (v === 'nosmoke' || v === 'invalid') delete boxesMap[item.file]
  }
  verdicts[item.file] = v
  persist(); closeLabel()
  const next = FRAMES.findIndex((f, i) => i > labelIdx && !verdictOf(f))
  if (next >= 0) openLabel(next)
}

function closeLabel(){
  document.getElementById('labelModal').style.display = 'none'
  labelIdx = -1
  render()
}

function navFrame(dir){
  const ni = labelIdx + dir
  if (ni < 0 || ni >= FRAMES.length) return
  const item = FRAMES[labelIdx]
  if (curBoxes.length) boxesMap[item.file] = JSON.parse(JSON.stringify(curBoxes))
  else delete boxesMap[item.file]
  applyVerdict(item)
  persist()
  openLabel(ni)
}

document.addEventListener('keydown', e => {
  const helpOpen = document.getElementById('helpModal').style.display === 'block'
  if (e.key === 'h' || e.key === 'H'){ e.preventDefault(); toggleHelp(); return }
  if (helpOpen){ if (e.key === 'Escape') toggleHelp(); return }
  if (labelIdx < 0) return
  if (e.key === 'Enter'){ e.preventDefault(); saveLabel() }
  else if (e.key === 'Escape') closeLabel()
  else if (e.key === 'ArrowRight') navFrame(1)
  else if (e.key === 'ArrowLeft') navFrame(-1)
  else if (e.key === 'n' || e.key === 'N') markAndNext('nosmoke')
  else if (e.key === 'i' || e.key === 'I') markAndNext('distractor')
  else if (e.key === 'x' || e.key === 'X') markAndNext('invalid')
  else if (e.key === '1') setMode('smoke')
  else if (e.key === '2') setMode('distractor')
  else if (e.key === 'c' || e.key === 'C') copyPrev()
})

function toggleHelp(){
  const m = document.getElementById('helpModal')
  m.style.display = m.style.display === 'block' ? 'none' : 'block'
}

function exportAll(){
  const smoke = {}, distract = {}, invalidF = [], nosmokeF = [], unsureF = []
  FRAMES.forEach(item => {
    const f = item.file
    let v = verdictOf(item)
    const sb = smokeBoxes(f), db = disBoxes(f)
    if (v === 'smoke' && !sb.length) v = 'unsure'
    if (v === 'invalid' || item.bad){ invalidF.push(f); return }
    if (v === 'nosmoke'){ nosmokeF.push(f); return }
    if (v === 'unsure' || !v){ if (v) unsureF.push(f); return }
    if (v === 'smoke' && sb.length){
      smoke[f] = sb.map(b => ({
        class: 0,
        cx: Math.round(((b.x1+b.x2)/2)*1000),
        cy: Math.round(((b.y1+b.y2)/2)*1000),
        w: Math.round((b.x2-b.x1)*1000),
        h: Math.round((b.y2-b.y1)*1000),
      }))
    }
    if (db.length){
      distract[f] = db.map(b => ({
        x1: Math.round(b.x1*1000), y1: Math.round(b.y1*1000),
        x2: Math.round(b.x2*1000), y2: Math.round(b.y2*1000),
      }))
    }
  })
  const out = {
    dataset: 'train_0909',
    videos: VIDEOS_PLACEHOLDER,
    totalFrames: FRAMES.length,
    smokeFrames: Object.keys(smoke),
    smokeBoxCount: Object.values(smoke).reduce((a,b) => a+b.length, 0),
    negativeFrames: nosmokeF,
    distractorFrames: Object.keys(distract),
    distractorBoxCount: Object.values(distract).reduce((a,b) => a+b.length, 0),
    invalidFrames: invalidF,
    unsureFrames: unsureF,
    yolo_norm_0_1000: smoke,
    distractors_norm_0_1000: distract,
    exportedAt: new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], {type:'application/json'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'train_0909_labels_v3.json'
  a.click()
  alert('已导出：\\n烟框 ' + out.smokeFrames.length + ' 帧 / ' + out.smokeBoxCount + ' 框\\n干扰区 ' + out.distractorFrames.length + ' 帧 / ' + out.distractorBoxCount + ' 框\\n无烟负样本 ' + nosmokeF.length + ' 帧\\n无效帧 ' + invalidF.length + ' 帧\\n不确定 ' + unsureF.length + ' 帧')
}

setFilter('todo', document.querySelector('.filter .btn'))
</script>
</body>
</html>
'''

html = html.replace('FRAMES_PLACEHOLDER', json.dumps(frames, ensure_ascii=False))
html = html.replace('INVALID_PLACEHOLDER', json.dumps(invalid, ensure_ascii=False))
html = html.replace('VIDEOS_PLACEHOLDER', json.dumps(VIDEOS, ensure_ascii=False))
open(OUT, 'w', encoding='utf-8').write(html)
print('已生成:', OUT, os.path.getsize(OUT), 'bytes')
