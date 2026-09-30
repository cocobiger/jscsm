#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""9/9 两段视频人工复核页 v2：复核 + 画框一体（用户可画烟框 bbox）"""
import json, os, glob, shutil

BASE = '/video/shujuji/xunlian/train_0909'
OUT_DIR = '/opt/jsc/frontend/train_0909'
os.makedirs(f'{OUT_DIR}/frames', exist_ok=True)

detect_stat = json.load(open(f'{BASE}/detect_stat.json'))
videos = ['064U_1036', '0S4G_1132']
frames = []
for vid in videos:
    hit = {f[0]: f[1] for f in detect_stat.get(vid, {}).get('frames', [])}
    for fp in sorted(glob.glob(f'{BASE}/frames_{vid}/*.jpg')):
        fname = os.path.basename(fp)
        new_name = f'{vid}_{fname}'
        dst = f'{OUT_DIR}/frames/{new_name}'
        if not os.path.exists(dst):
            shutil.copy(fp, dst)
        frames.append({'file': new_name, 'vid': vid, 'conf': hit.get(fname)})

frames_js = json.dumps(frames, ensure_ascii=False)

html = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>9/9 视频人工复核+标框（064U_1036 + 0S4G_1132）</title>
<style>
  :root{--ink:#1f2733;--mut:#5c6b7f;--line:#dbe2ec;--soft:#f4f7fb;--blue:#1b4f9e;--blue2:#eaf1fb;--red:#c0392b;--red2:#fdecea;--amber:#b7791f;--amber2:#fff7e6;--green:#1e8e5a;--green2:#e7f5ee;--cyan:#00aaff}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Microsoft YaHei",system-ui,sans-serif;color:var(--ink);font-size:14px;line-height:1.6;background:#f2f5f9;height:100vh;display:flex;flex-direction:column;overflow:hidden}
  .topbar{background:#fff;border-bottom:1px solid var(--line);padding:8px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
  .topbar h1{font-size:16px;color:var(--blue)}
  .topbar .hint{font-size:12px;color:var(--mut)}
  .topbar .stats{display:flex;gap:12px;font-size:12px;margin-left:auto}
  .stat b{font-size:16px}
  .grid{flex:1;overflow-y:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;align-content:start}
  .card{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
  .card .imgwrap{position:relative;background:#000;cursor:zoom-in;aspect-ratio:4/3}
  .card img{width:100%;height:100%;object-fit:cover;display:block}
  .card .vid{position:absolute;top:5px;left:6px;font-size:10px;background:rgba(0,0,0,0.6);color:#fff;padding:1px 6px;border-radius:3px;font-family:monospace}
  .card .conf{position:absolute;top:5px;right:6px;font-size:10px;background:rgba(0,170,255,0.85);color:#fff;padding:1px 6px;border-radius:3px;font-weight:700}
  .card .boxtag{position:absolute;bottom:5px;left:6px;font-size:10px;background:rgba(30,142,90,0.9);color:#fff;padding:1px 6px;border-radius:3px}
  .card .fname{font-family:monospace;font-size:9px;color:var(--mut);padding:5px 10px}
  .verdict{display:flex;gap:4px;padding:6px 8px;border-top:1px solid var(--line)}
  .verdict button{flex:1;border:1px solid var(--line);background:#fff;border-radius:4px;padding:5px 0;font-size:11px;cursor:pointer}
  .verdict button.boxbtn{background:var(--cyan);color:#fff;border-color:var(--cyan)}
  .verdict button.nosmoke.on{background:var(--green);color:#fff;border-color:var(--green)}
  .verdict button.unsure.on{background:var(--amber);color:#fff;border-color:var(--amber)}
  .card[data-v="smoke"]{border-color:var(--red);box-shadow:0 0 0 2px var(--red2)}
  .card[data-v="nosmoke"]{border-color:var(--green)}
  .card[data-v="unsure"]{border-color:var(--amber)}
  .filter button{border:1px solid var(--line);background:#fff;border-radius:4px;padding:4px 12px;font-size:12px;cursor:pointer}
  .filter button.on{background:var(--blue);color:#fff;border-color:var(--blue)}
  .labelmodal{position:fixed;inset:0;background:rgba(0,8,20,0.96);display:none;z-index:200}
  .labelmodal .inner{position:absolute;inset:0;display:flex;flex-direction:column}
  .labelbar{background:#0a1628;padding:8px 16px;display:flex;align-items:center;gap:14px;color:#c8e6ff;font-size:13px;border-bottom:1px solid rgba(0,150,220,0.2)}
  .labelbar button{border:1px solid var(--cyan);background:var(--cyan);color:#fff;border-radius:5px;padding:6px 14px;font-size:12px;cursor:pointer}
  .labelbar button.ghost{background:transparent;color:var(--cyan)}
  .labelbar .info{font-size:12px;color:#7ab8e0}
  .canvaswrap{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;position:relative}
  #cv{max-width:96%;max-height:96%;cursor:crosshair;background:#000}
  .framenav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,170,255,0.3);color:#fff;border:none;font-size:28px;padding:10px 14px;cursor:pointer;border-radius:6px}
  .framenav:hover{background:rgba(0,170,255,0.6)}
</style>
</head>
<body>
<div class="topbar">
  <h1>🛸 9/9 视频人工复核+标框</h1>
  <span class="hint">点【✏️标框】打开画框编辑器画烟框（确认有烟+框位置）；无烟点【无烟】；不确定点【?】</span>
  <div class="stats">
    <div class="stat"><b id="sTotal">0</b> 总帧</div>
    <div class="stat" style="color:var(--red)"><b id="sSmoke">0</b> 有烟(已标框)</div>
    <div class="stat" style="color:var(--green)"><b id="sNosmoke">0</b> 无烟</div>
    <div class="stat" style="color:var(--amber)"><b id="sUnsure">0</b> 不确定</div>
  </div>
  <div class="filter" style="display:flex;gap:4px">
    <button onclick="exportYolo()" style="background:var(--green);color:#fff;border-color:var(--green)">导出 YOLO 标注</button>
    <button onclick="setFilter('smoke',this)">有烟</button>
    <button onclick="setFilter('nosmoke',this)">无烟</button>
    <button onclick="setFilter('unsure',this)">不确定</button>
    <button onclick="setFilter('todo',this)" class="on">待复核</button>
    <button onclick="setFilter('all',this)">全部</button>
  </div>
</div>
<div class="grid" id="grid"></div>

<!-- 画框编辑器弹层 -->
<div class="labelmodal" id="labelModal">
  <div class="inner">
    <div class="labelbar">
      <span id="labFrameName" style="font-family:monospace"></span>
      <span class="info" id="labInfo">拖拽画框 | 拖框移动 | 拖角缩放 | 双击删框 | Enter确认 | Esc取消</span>
      <button onclick="saveLabel()" style="background:var(--green);border-color:var(--green)">✓ 确认（Enter）</button>
      <button class="ghost" onclick="clearBoxes()">删光框</button>
      <button class="ghost" onclick="closeLabel()">✕ 取消（Esc）</button>
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
const PAGE_SIZE = 50
const CV_KEY = 'review_0909_boxes'
const V_KEY = 'review_0909_verdicts'
let boxesMap = JSON.parse(localStorage.getItem(CV_KEY) || '{}')  // {file: [{x1,y1,x2,y2}归一化0-1]}
let verdicts = JSON.parse(localStorage.getItem(V_KEY) || '{}')   // {file: 'smoke'|'nosmoke'|'unsure'}
let filter = 'todo'
let page = 1
let labelIdx = -1

function render() {
  const grid = document.getElementById('grid')
  grid.innerHTML = ''
  // 先筛选，再分页
  const filtered = FRAMES.filter(item => {
    const hasBox = (boxesMap[item.file] || []).length > 0
    const vv = verdicts[item.file] || (hasBox ? 'smoke' : '')
    if (filter === 'todo') return !vv
    if (filter === 'all') return true
    return vv === filter
  })
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  page = Math.max(1, Math.min(page, totalPages))
  const pageFrames = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  pageFrames.forEach(item => {
    const i = FRAMES.indexOf(item)
    const hasBox = (boxesMap[item.file] || []).length > 0
    if (hasBox && !verdicts[item.file]) { verdicts[item.file] = 'smoke' }
    const vv = verdicts[item.file] || ''
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.v = vv
    const confHtml = item.conf ? `<div class="conf">检出 ${(item.conf*100).toFixed(0)}%</div>` : ''
    const boxHtml = hasBox ? `<div class="boxtag">已标框 ${boxesMap[item.file].length}</div>` : ''
    card.innerHTML = `
      <div class="imgwrap" onclick="openLabel(${i})">
        <img loading="lazy" src="frames/${item.file}">
        <div class="vid">${item.vid}</div>
        ${confHtml}
        ${boxHtml}
      </div>
      <div class="fname">${item.file.replace('.jpg','')}</div>
      <div class="verdict">
        <button class="boxbtn" onclick="openLabel(${i})">✏️ 标框</button>
        <button class="nosmoke ${vv==='nosmoke'?'on':''}" onclick="mark('${item.file}','nosmoke',this)">✓ 无烟</button>
        <button class="unsure ${vv==='unsure'?'on':''}" onclick="mark('${item.file}','unsure',this)">? 不确定</button>
      </div>`
    grid.appendChild(card)
  })
  renderPagination(filtered.length, totalPages)
  updateStats()
}

function renderPagination(total, totalPages) {
  let pg = document.getElementById('pagination')
  if (!pg) {
    pg = document.createElement('div')
    pg.id = 'pagination'
    pg.style.cssText = 'padding:8px 14px;background:#fff;border-top:1px solid var(--line);display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px'
    document.querySelector('.topbar').parentElement.insertBefore(pg, document.getElementById('grid'))
  }
  pg.innerHTML = ''
  const btn = (label, p, dis) => {
    const b = document.createElement('button')
    b.textContent = label
    b.disabled = dis
    b.style.cssText = `padding:4px 10px;border:1px solid ${p===page?'var(--cyan)':'var(--line)'};background:${p===page?'rgba(0,170,255,0.12)':'#fff'};color:${p===page?'var(--cyan)':'var(--mut)'};border-radius:4px;font-size:12px;cursor:${dis?'default':'pointer'}`
    b.onclick = () => { if (!dis) { page = p; render() } }
    return b
  }
  pg.appendChild(btn('← 上一页', page - 1, page <= 1))
  const start = Math.max(1, page - 2), end = Math.min(totalPages, start + 4)
  for (let p = start; p <= end; p++) pg.appendChild(btn(String(p), p, false))
  pg.appendChild(btn('下一页 →', page + 1, page >= totalPages))
  const info = document.createElement('span')
  info.style.cssText = 'margin-left:8px;color:var(--mut);font-size:12px'
  info.textContent = `第 ${page} / ${totalPages} 页 · 每页 ${PAGE_SIZE} 帧 · 共 ${total} 帧`
  pg.appendChild(info)
}

function mark(file, v, btn) {
  if (verdicts[file] === v) delete verdicts[file]
  else verdicts[file] = v
  localStorage.setItem(V_KEY, JSON.stringify(verdicts))
  render()
}

function setFilter(f, btn) {
  filter = f
  page = 1
  document.querySelectorAll('.filter button').forEach(b => b.classList.remove('on'))
  if (btn) btn.classList.add('on')
  render()
}

function updateStats() {
  let smoke=0, nosmoke=0, unsure=0
  FRAMES.forEach(item => {
    const v = verdicts[item.file] || ''
    const hasBox = (boxesMap[item.file] || []).length > 0
    if (v==='smoke' || hasBox) smoke++
    else if (v==='nosmoke') nosmoke++
    else if (v==='unsure') unsure++
  })
  document.getElementById('sSmoke').textContent = smoke
  document.getElementById('sNosmoke').textContent = nosmoke
  document.getElementById('sUnsure').textContent = unsure
  document.getElementById('sTotal').textContent = FRAMES.length
}

// ════════ 画框编辑器 ════════
const cv = document.getElementById('cv'), cx = cv.getContext('2d')
let img = new Image(), boxes = [], draft = null, dragMode = null, editing = null

function openLabel(i) {
  labelIdx = i
  const item = FRAMES[i]
  boxes = JSON.parse(JSON.stringify(boxesMap[item.file] || []))
  document.getElementById('labFrameName').textContent = item.file
  document.getElementById('labInfo').textContent = `${i+1}/${FRAMES.length} | 拖拽画框 | 拖框移动 | 拖角缩放 | 双击删框 | Enter确认`
  img.onload = () => { fitCanvas(); draw() }
  img.src = 'frames/' + item.file
  document.getElementById('labelModal').style.display = 'block'
}

function fitCanvas() {
  const wrap = document.querySelector('.canvaswrap')
  const pad = 30
  const maxW = wrap.clientWidth - pad, maxH = wrap.clientHeight - pad
  const ratio = img.width / img.height
  let w = maxW, h = w / ratio
  if (h > maxH) { h = maxH; w = h * ratio }
  cv.width = w; cv.height = h
}

function toCanvas(b){ return {x1:b.x1*cv.width, y1:b.y1*cv.height, x2:b.x2*cv.width, y2:b.y2*cv.height} }
function toNorm(b){ return {x1:Math.max(0,Math.min(1,b.x1/cv.width)), y1:Math.max(0,Math.min(1,b.y1/cv.height)), x2:Math.max(0,Math.min(1,b.x2/cv.width)), y2:Math.max(0,Math.min(1,b.y2/cv.height))} }

function draw() {
  cx.clearRect(0,0,cv.width,cv.height)
  if (img.width) cx.drawImage(img,0,0,cv.width,cv.height)
  boxes.forEach(b => drawBox(toCanvas(b), '#f1c40f'))
  if (draft) drawBox(draft, '#00e5ff', true)
}

function drawBox(b, color, isDraft) {
  cx.strokeStyle = color; cx.lineWidth = isDraft?1.5:2.5
  cx.strokeRect(b.x1,b.y1,b.x2-b.x1,b.y2-b.y1)
  if (!isDraft){
    cx.fillStyle = color
    const r=4
    [[b.x1,b.y1],[b.x2,b.y1],[b.x1,b.y2],[b.x2,b.y2]].forEach(([x,y])=>{
      cx.beginPath(); cx.arc(x,y,r,0,Math.PI*2); cx.fill()
    })
  }
}

function pos(e){ const r=cv.getBoundingClientRect(); return {x:e.clientX-r.left, y:e.clientY-r.top} }
function findBox(e){
  const p = pos(e)
  for (let bi=boxes.length-1; bi>=0; bi--){
    const b = toCanvas(boxes[bi])
    for (const k of ['x1','y1','x2','y2']){
      const [px,py] = k[0]==='x'? [b[k], k==='x1'? b.y1:b.y2] : [k==='y1'? b.x1:b.x2, b[k]]
      if (Math.hypot(p.x-px,p.y-py) < 12) return {bi, type:'corner', corner:k}
    }
  }
  for (let bi=boxes.length-1; bi>=0; bi--){
    const b = toCanvas(boxes[bi])
    if (p.x>=b.x1-5&&p.x<=b.x2+5&&p.y>=b.y1-5&&p.y<=b.y2+5) return {bi, type:'move'}
  }
  return null
}

cv.addEventListener('mousedown', e=>{
  const hit = findBox(e)
  const p = pos(e)
  if (hit){ dragMode = hit; return }
  draft = {x1:p.x,y1:p.y,x2:p.x,y2:p.y}
  dragMode = {type:'draw'}
})
cv.addEventListener('mousemove', e=>{
  const p = pos(e)
  if (!dragMode) return
  if (dragMode.type==='draw' && draft){ draft.x2=p.x; draft.y2=p.y; draw(); return }
  const b = toCanvas(boxes[dragMode.bi])
  if (dragMode.type==='move'){
    if (!dragMode.sx) { dragMode.sx=p.x; dragMode.sy=p.y }
    const dx=p.x-dragMode.sx, dy=p.y-dragMode.sy
    boxes[dragMode.bi]=toNorm({x1:b.x1+dx,y1:b.y1+dy,x2:b.x2+dx,y2:b.y2+dy})
    dragMode.sx=p.x; dragMode.sy=p.y
  }
  if (dragMode.type==='corner'){
    const c=dragMode.corner, nb={...b}
    nb[c]= c[0]==='x'? p.x : p.y
    if (nb.x2-nb.x1<10) nb[c==='x1'?'x1':'x2'] = (c==='x1'? nb.x2-10 : nb.x1+10)
    if (nb.y2-nb.y1<10) nb[c==='y1'?'y1':'y2'] = (c==='y1'? nb.y2-10 : nb.y1+10)
    boxes[dragMode.bi]=toNorm(nb)
  }
  draw()
})
cv.addEventListener('mouseup', e=>{
  if (dragMode?.type==='draw' && draft){
    const nb = toNorm({x1:Math.min(draft.x1,draft.x2),y1:Math.min(draft.y1,draft.y2),x2:Math.max(draft.x1,draft.x2),y2:Math.max(draft.y1,draft.y2)})
    if ((nb.x2-nb.x1)*cv.width>15 && (nb.y2-nb.y1)*cv.height>15) boxes.push(nb)
  }
  draft=null; dragMode=null; draw()
})
cv.addEventListener('dblclick', e=>{
  const hit = findBox(e)
  if (hit && hit.type!=='corner'){ boxes.splice(hit.bi,1); draw() }
})

function clearBoxes(){ boxes=[]; draw() }

function saveLabel() {
  const item = FRAMES[labelIdx]
  if (boxes.length > 0) {
    boxesMap[item.file] = JSON.parse(JSON.stringify(boxes))
    verdicts[item.file] = 'smoke'
  } else {
    delete boxesMap[item.file]
    if (verdicts[item.file] === 'smoke') delete verdicts[item.file]
  }
  localStorage.setItem(CV_KEY, JSON.stringify(boxesMap))
  localStorage.setItem(V_KEY, JSON.stringify(verdicts))
  closeLabel()
  // 自动跳下一帧未标框的
  const next = FRAMES.findIndex((f, i) => i > labelIdx && !(boxesMap[f.file] || []).length && !verdicts[f.file])
  if (next >= 0) openLabel(next)
}

function closeLabel() {
  document.getElementById('labelModal').style.display = 'none'
  labelIdx = -1
  render()
}

function navFrame(dir) {
  const ni = labelIdx + dir
  if (ni >= 0 && ni < FRAMES.length) {
    // 先保存当前
    const item = FRAMES[labelIdx]
    if (boxes.length > 0) { boxesMap[item.file] = JSON.parse(JSON.stringify(boxes)) }
    openLabel(ni)
  }
}

document.addEventListener('keydown', e=>{
  if (labelIdx < 0) return
  if (e.key==='Enter') saveLabel()
  else if (e.key==='Escape') closeLabel()
  else if (e.key==='ArrowRight') navFrame(1)
  else if (e.key==='ArrowLeft') navFrame(-1)
})

function exportYolo() {
  const labels = {}
  FRAMES.forEach(item => {
    const boxes = boxesMap[item.file] || []
    if (boxes.length) {
      labels[item.file] = boxes.map(b=>({
        class: 0,
        cx: Math.round(((b.x1+b.x2)/2)*1000),
        cy: Math.round(((b.y1+b.y2)/2)*1000),
        w: Math.round((b.x2-b.x1)*1000),
        h: Math.round((b.y2-b.y1)*1000),
      }))
    }
  })
  const out = {
    videos: ['064U_1036', '0S4G_1132'],
    totalFrames: FRAMES.length,
    labeledFrames: Object.keys(labels).length,
    smokeFrames: Object.keys(labels),
    yolo_norm_0_1000: labels,
    verdicts,
    exportedAt: new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(out, null, 2)], {type: 'application/json'})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'train_0909_yolo_labels.json'
  a.click()
  alert(`已导出 ${Object.keys(labels).length} 帧烟框标注（YOLO 0-1000）`)
}

render()
</script>
</body>
</html>
'''

html = html.replace('FRAMES_PLACEHOLDER', frames_js)
open(f'{OUT_DIR}/review.html', 'w', encoding='utf-8').write(html)
print(f'复核+标框页已生成: {OUT_DIR}/review.html')
print(f'帧总数: {len(frames)}')
