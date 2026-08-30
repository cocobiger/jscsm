#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3 标注工作台生成器（外链模式 + 整框优先引导，支持 100+ 帧）

与 v1 关键差异：
- 图片优先用 URL（nginx 静态服务）按需加载，base64 退路保留
- 顶部新增 ⑦ 整框优先 引导（解决细分多框副作用）
- 支持多批混合（v2_ai 27 帧 + 视频抽帧 60 帧 + 后续可继续追加）
- 启动时可指定外部 INIT JSON 文件，便于跨批追加
- 进度可视化（顶部统计已复核 / 总帧）

输入数据格式（INIT JSON）：
  {
    "order": ["rel1","rel2",...],
    "frames": {
      "rel1": {"boxes":[[0,cx,cy,w,h],...], "note":"", "fire":"-", "url":"/v5_photos/0826/f001.jpg", "src":"video"},
      "rel2": {"boxes":[...], "url":"/v5ai_imgs/old/02-10-05-0/f1.jpg", "src":"old27"}
    }
  }
- url 可为空（base64 退路）—— v3 默认都填 url
- 框坐标：归一化 cx/cy/w/h（YOLO 格式）
"""
import os, json, base64, sys, argparse

# 路径与默认
DEFAULT_OUT = '/video/llm_infer/v5ai_label_v3.html'

# ---------- HTML 模板 ----------
HTML = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>v3 训练 · 多批标注工作台（外链模式）</title>
<style>
:root{
  --bg:#f5f6f8; --card:#ffffff; --line:#e2e5ea; --ink:#1f2937; --sub:#6b7280;
  --blue:#2563eb; --blue-bg:#eff6ff; --amber:#f59e0b; --amber-bg:#fffbeb; --amber-ink:#92400e;
  --red:#dc2626; --green:#16a34a; --green-bg:#f0fdf4; --violet:#7c3aed; --violet-bg:#f5f3ff;
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);font-size:14px}
.wrap{max-width:1500px;margin:0 auto;padding:12px 16px 8px;display:flex;flex-direction:column;height:100vh}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-bottom:8px}
h1{font-size:17px;margin:0;font-weight:700}
.badge{font-size:12px;padding:2px 10px;border-radius:12px;background:var(--blue-bg);color:var(--blue);border:1px solid #bfdbfe}
.badge.done{background:var(--green-bg);color:var(--green);border-color:#bbf7d0}
.badge.violet{background:var(--violet-bg);color:var(--violet);border-color:#ddd6fe}
details{margin-left:auto}
summary{cursor:pointer;font-size:13px;color:var(--blue);user-select:none;font-weight:600}
.info-panel{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin-bottom:8px}
.info-panel .sec{font-size:12px;color:var(--sub);margin:2px 0}
.info-panel ul{margin:4px 0 2px;padding-left:18px}
.info-panel li{font-size:12.5px;line-height:1.75}
.info-panel b{color:var(--ink)}
.factor{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12.5px;line-height:1.6;margin-top:2px}
.factor .n{font-weight:700;color:var(--amber-ink);background:var(--amber-bg);border:1px solid #fcd34d;border-radius:6px;padding:0 7px;height:20px;line-height:18px;white-space:nowrap}
.factor .n.prime{background:var(--green-bg);color:var(--green);border-color:#86efac}
kbd{background:#f3f4f6;border:1px solid #d1d5db;border-bottom-width:2px;border-radius:4px;padding:0 5px;font-size:11px;font-family:inherit}
.src-tag{font-size:10px;background:#f3f4f6;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--sub);margin-left:4px}
/* toolbar */
.toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 8px;margin-bottom:8px}
.toolbar .grp{display:flex;gap:4px;align-items:center;padding-right:8px;border-right:1px solid var(--line);margin-right:2px}
.toolbar .grp:last-child{border-right:none}
.btn{border:1px solid var(--line);background:#fff;border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;color:var(--ink);transition:all .12s}
.btn:hover{border-color:var(--blue);color:var(--blue)}
.btn.active{background:var(--blue);border-color:var(--blue);color:#fff}
.btn.primary{background:var(--blue);border-color:var(--blue);color:#fff}
.btn.primary:hover{background:#1d4ed8}
.btn.danger{color:var(--red)}
.btn.danger:hover{border-color:var(--red);background:#fef2f2}
.btn:disabled{opacity:.45;cursor:not-allowed}
.nav-arrow{font-size:15px;padding:5px 12px}
.sep{width:1px;height:22px;background:var(--line)}
.progress{font-size:12px;color:var(--sub);margin-right:4px}
/* main */
main{flex:1;display:flex;gap:10px;min-height:0}
#canvasWrap{flex:1;background:#0f172a;border-radius:8px;position:relative;overflow:hidden;border:1px solid var(--line)}
#cv{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:crosshair;touch-action:none}
.zoom-hint{position:absolute;right:10px;bottom:8px;color:#94a3b8;font-size:11px;background:rgba(15,23,42,.7);padding:3px 8px;border-radius:5px;pointer-events:none}
.loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#cbd5e1;font-size:13px}
#side{width:272px;flex-shrink:0;display:flex;flex-direction:column;gap:8px;overflow-y:auto}
.side-card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px}
.side-card h3{margin:0 0 8px;font-size:13px;color:var(--sub);font-weight:600}
#curRel{font-size:12.5px;word-break:break-all;background:#f9fafb;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin-bottom:6px}
.amb{background:var(--amber-bg);border:1px solid #fcd34d;border-radius:6px;padding:5px 8px;color:var(--amber-ink);font-size:12px;margin-bottom:8px}
.boxlist{max-height:210px;overflow-y:auto;display:flex;flex-direction:column;gap:4px}
.boxrow{display:flex;align-items:center;gap:6px;font-size:12px;border:1px solid var(--line);border-radius:6px;padding:3px 6px;cursor:pointer}
.boxrow.sel{border-color:var(--blue);background:var(--blue-bg)}
.boxrow .idx{font-weight:700;color:var(--blue);min-width:20px}
.boxrow .wh{color:var(--sub);flex:1}
.boxrow .del{cursor:pointer;color:var(--red);font-weight:700;padding:0 4px;border-radius:4px}
.boxrow .del:hover{background:#fef2f2}
.empty{color:var(--sub);font-size:12px;padding:8px 0;text-align:center}
.status-row{display:flex;gap:6px;margin-top:8px}
.hotkeys{font-size:12px;color:var(--sub);line-height:1.9}
.hotkeys kbd{margin-right:2px}
/* src filter */
.src-filter{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.src-chip{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer;user-select:none}
.src-chip.active{background:var(--blue);color:#fff;border-color:var(--blue)}
/* thumb strip */
#thumbs{display:flex;gap:6px;overflow-x:auto;padding:8px 2px 2px;margin-top:8px}
.thumb{position:relative;width:74px;height:46px;border-radius:6px;overflow:hidden;cursor:pointer;border:2px solid transparent;flex-shrink:0;background:#0f172a}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb .st{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#9ca3af;border:1px solid #fff}
.thumb .st.ok{background:var(--green)}
.thumb .n{position:absolute;left:3px;bottom:1px;color:#fff;font-size:10px;text-shadow:0 1px 2px #000;font-weight:700}
.thumb.cur{border-color:var(--blue)}
.thumb.rev{border-color:var(--green)}
/* toast */
#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%) translateY(20px);background:#111827;color:#fff;font-size:13px;padding:7px 16px;border-radius:8px;opacity:0;transition:all .2s;pointer-events:none;z-index:99}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🧭 标注工作台 v3</h1>
    <span class="badge" id="progBadge">已复核 0 / __TOTAL__</span>
    <span class="badge violet" id="batchBadge">__BATCH__</span>
    <details open>
      <summary>📖 标注说明（点此展开/收起）</summary>
      <div class="info-panel">
        <div class="sec">🖱 操作：<b>画框工具</b>下拖拽空白处画新框；<b>选择工具</b>下点击框选中、拖动移动、拖拽 8 个白色手柄缩放。<b>Delete</b> 删除选中框，<b>Ctrl+Z / Ctrl+Y</b> 撤销/重做，<b>滚轮</b>缩放画布，<b>空格+拖拽</b>平移，<b>双击</b>适应窗口。标注<b>自动保存</b>到本机浏览器，刷新不丢。</div>
        <div class="sec">📤 导出：完成一帧点「✅ 标记已复核」；全部完成点「导出 JSON」（替换 boxes_v2_ai.json 直接入训练集）或「导出 YOLO」（合并 txt 标签）。</div>
        <div class="sec">🔀 批次过滤：右侧"批次"芯片可只看某一来源（v2_ai 老批 / video 视频抽帧 / photo 任务照片）。</div>
      </div>
    </details>
    <details>
      <summary>⚠️ 训练影响因子（务必阅读）</summary>
      <div class="info-panel">
        <div class="factor">
          <span class="n prime">⑦</span><span><b>整框优先</b>——<u>一帧 = 一个完整的烟框</u>。细分多框（27→53）会让模型学"碎片化烟"，整片烟置信度被压低（v5-v3 召回 2.4% 的根因）。先画一个覆盖整片烟的框，<b>仅当一片帧内有多团独立烟</b>才用多框。</span>
          <span class="n">①</span><span><b>框贴烟体</b>——框必须紧贴烟体边缘，宁紧勿松。偏移超 25% 会让 IoU&lt;0.5 匹配失败，该框对 mAP50 贡献归零。</span>
          <span class="n">②</span><span><b>漏标是召回灾难</b>——真烟帧必须全部画框。漏标=把真烟当背景，模型学不会召回（v1 只有 2/41 的教训）。</span>
          <span class="n">③</span><span><b>错标污染正样本</b>——云、灯光、反光不是烟，误标会让模型对同类误报（v3 无烟帧 307 次误触发的教训）。</span>
          <span class="n">④</span><span><b>框大小一致性</b>——烟多大框就多大，不要留大边距；过松过紧都会干扰模型对烟体尺寸的学习。</span>
          <span class="n">⑤</span><span><b>样本多样性</b>——保留不同时段/天气/地形/距离的烟。单一形态会让模型过拟合（v1 合成烟过拟合的教训）。</span>
          <span class="n">⑥</span><span><b>train/val 同源泄漏</b>——本批 27 帧已是 v2 的训练/验证来源。后续新标注帧勿与训练帧同录制同时段，否则 mAP50 虚高（v1 0.809 虚高的教训）。</span>
        </div>
      </div>
    </details>
  </header>

  <div class="toolbar">
    <div class="grp">
      <button class="btn nav-arrow" id="prevB" title="上一帧 (←)">◀</button>
      <span class="progress" id="posText">1 / __TOTAL__</span>
      <button class="btn nav-arrow" id="nextB" title="下一帧 (→)">▶</button>
    </div>
    <div class="grp">
      <button class="btn active" id="toolDraw" title="拖拽画新框">✏️ 画框</button>
      <button class="btn" id="toolSel" title="点击选中/拖动移动/手柄缩放">🖱 选择</button>
    </div>
    <div class="grp">
      <button class="btn" id="undoB" title="Ctrl+Z">↩ 撤销</button>
      <button class="btn" id="redoB" title="Ctrl+Y">↪ 重做</button>
      <button class="btn danger" id="delB" title="Delete">🗑 删除选中</button>
    </div>
    <div class="sep"></div>
    <div class="grp">
      <button class="btn" id="resetB" title="恢复为 AI 初始框">♻ 重置本帧</button>
      <button class="btn" id="markB" title="标记为已复核">✅ 标记已复核</button>
    </div>
    <div class="sep"></div>
    <div class="grp">
      <button class="btn primary" id="expJson">⬇ 导出 JSON</button>
      <button class="btn primary" id="expYolo">⬇ 导出 YOLO</button>
    </div>
  </div>

  <main>
    <div id="canvasWrap">
      <canvas id="cv"></canvas>
      <div class="loading" id="loadingHint">⏳ 加载中...</div>
      <div class="zoom-hint">滚轮缩放 · 空格+拖拽平移 · 双击适应</div>
    </div>
    <div id="side">
      <div class="side-card">
        <h3>批次过滤 <span id="filterStat" style="font-weight:400;color:var(--sub)"></span></h3>
        <div class="src-filter" id="srcFilter"></div>
      </div>
      <div class="side-card">
        <h3>当前帧</h3>
        <div id="curRel">—</div>
        <div class="amb" id="ambNote" style="display:none"></div>
        <div class="status-row">
          <button class="btn" id="markB2" style="flex:1">✅ 标记已复核</button>
        </div>
      </div>
      <div class="side-card">
        <h3>框列表（点击选中）</h3>
        <div class="boxlist" id="boxList"></div>
      </div>
      <div class="side-card">
        <h3>快捷键</h3>
        <div class="hotkeys">
          <div><kbd>←</kbd><kbd>→</kbd> 切换帧</div>
          <div><kbd>Del</kbd> 删除选中框</div>
          <div><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> 撤销 / 重做</div>
          <div><kbd>1</kbd> 画框工具 · <kbd>2</kbd> 选择工具</div>
        </div>
      </div>
    </div>
  </main>

  <div id="thumbs"></div>
</div>
<div id="toast"></div>

<script>
'use strict';
/* __INIT_DATA__ */
const INIT = /*__INIT__*/;
const LS_KEY = 'v5ai_label_v3';
const CLS_NAME = {0:'smoke'};

const order = INIT.order;
let state = null;
function defaultFrame(rel){
  return {
    boxes: (INIT.frames[rel].boxes||[]).map(b=>b.slice()),
    note: INIT.frames[rel].note||'',
    fire: INIT.frames[rel].fire||'-',
    status: 'pending'
  };
}
function loadState(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){ const s = JSON.parse(raw); if(s && s.frames && s.current && order.includes(s.current)) return s; }
  }catch(e){}
  const frames = {}; order.forEach(r=>frames[r]=defaultFrame(r));
  return {frames, current: order[0]};
}
function save(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(state)); }catch(e){} }

// ---------- 历史 ----------
let undoStack=[], redoStack=[];
const snap = () => JSON.parse(JSON.stringify(state.frames));
function pushHistory(){ undoStack.push(snap()); if(undoStack.length>300) undoStack.shift(); redoStack=[]; updateToolbar(); }
function undo(){ if(!undoStack.length) return; redoStack.push(snap()); state.frames=undoStack.pop(); save(); render(); updatePanel(); updateToolbar(); toast('已撤销'); }
function redo(){ if(!redoStack.length) return; undoStack.push(snap()); state.frames=undoStack.pop(); save(); render(); updatePanel(); updateToolbar(); toast('已重做'); }

// ---------- 图像预加载（外链模式） ----------
const imgs = {};
let readyCount = 0;
const visibleOrder = () => activeSrc ? order.filter(r => (INIT.frames[r].src||'') === activeSrc) : order;
order.forEach(rel=>{
  const meta = INIT.frames[rel];
  if(!meta.url){ console.warn('frame without url:', rel); return; }
  const im = new Image();
  im.onload = ()=>{ readyCount++; if(readyCount===order.length) fitCanvas(); };
  im.onerror = ()=>{ console.error('load failed:', rel, meta.url); document.getElementById('loadingHint').textContent = '⚠️ 加载失败: ' + rel; };
  im.src = meta.url;
  imgs[rel] = im;
});

// ---------- 视图 ----------
const wrap = document.getElementById('canvasWrap');
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const view = {zoom:1, ox:0, oy:0};
let fitW=0, fitH=0, dpr=1;
let tool = 'draw';
let activeSrc = '';  // '' = 全部

function fitCanvas(){
  const img = imgs[state.current];
  if(!img || !img.naturalWidth){ document.getElementById('loadingHint').style.display=''; return; }
  document.getElementById('loadingHint').style.display='none';
  dpr = window.devicePixelRatio||1;
  const r = wrap.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width*dpr));
  cv.height = Math.max(1, Math.round(r.height*dpr));
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const cw=r.width, ch=r.height;
  const s = Math.min(cw/img.naturalWidth, ch/img.naturalHeight);
  fitW = img.naturalWidth*s; fitH = img.naturalHeight*s;
  view.ox = (cw-fitW)/2; view.oy = (ch-fitH)/2; view.zoom = 1;
  render();
}
function toImageXY(mx,my){ return { x:(mx-view.ox)/view.zoom, y:(my-view.oy)/view.zoom }; }
function zoomAt(mx,my,f){
  const nz = Math.min(20, Math.max(0.1, view.zoom*f));
  if(nz===view.zoom) return;
  view.ox = mx - (mx-view.ox)*(nz/view.zoom);
  view.oy = my - (my-view.oy)*(nz/view.zoom);
  view.zoom = nz; render();
}

// ---------- 渲染 ----------
function curBoxes(){ return state.frames[state.current].boxes; }
let selIdx = -1;
function render(){
  const img = imgs[state.current];
  if(!img || !img.naturalWidth) return;
  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.zoom, view.zoom);
  ctx.drawImage(img, 0, 0, fitW, fitH);
  const boxes = curBoxes();
  boxes.forEach((b,i)=>{
    const x = b[1]*fitW, y = b[2]*fitH, w = b[3]*fitW, h = b[4]*fitH;
    const sel = (i===selIdx);
    ctx.strokeStyle = sel ? '#2563eb' : '#dc2626';
    ctx.lineWidth = sel ? 3 : 2;
    ctx.strokeRect(x,y,w,h);
    ctx.fillStyle = sel ? '#2563eb' : '#dc2626';
    ctx.font = 'bold 11px system-ui';
    ctx.fillText(i, x+2, y-3);
    if(sel){
      const hs = 7;
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5;
      [[x,y],[x+w/2,y],[x+w,y],[x,y+h/2],[x+w,y+h/2],[x,y+h],[x+w/2,y+h],[x+w,y+h]].forEach(p=>{
        ctx.fillRect(p[0]-hs/2, p[1]-hs/2, hs, hs);
        ctx.strokeRect(p[0]-hs/2, p[1]-hs/2, hs, hs);
      });
    }
  });
  ctx.restore();
}

// ---------- 交互 ----------
let mode = 'idle';
let drag = null;
const HANDLES = ['nw','n','ne','e','se','s','sw','w'];
function hitHandle(b, mx, my){
  const x = b[1]*fitW, y = b[2]*fitH, w = b[3]*fitW, h = b[4]*fitH;
  const pts = {nw:[x,y],n:[x+w/2,y],ne:[x+w,y],e:[x+w,y+h/2],se:[x+w,y+h],s:[x+w/2,y+h],sw:[x,y+h],w:[x,y+h/2]};
  for(const k of HANDLES){
    const p = pts[k];
    if(Math.abs(mx-p[0])<=8 && Math.abs(my-p[1])<=8) return k;
  }
  return null;
}
function hitBox(b, mx, my){
  const x = b[1]*fitW, y = b[2]*fitH, w = b[3]*fitW, h = b[4]*fitH;
  return mx>=x && mx<=x+w && my>=y && my<=y+h;
}
function cvPos(e){
  const r = cv.getBoundingClientRect();
  return { mx:e.clientX-r.left, my:e.clientY-r.top };
}
function clamp01(v){ return Math.min(1, Math.max(0, v)); }
cv.addEventListener('pointerdown', e=>{
  if(spaceDown) return;
  e.preventDefault(); cv.setPointerCapture(e.pointerId);
  const {mx,my} = cvPos(e);
  const p = toImageXY(mx,my);
  const boxes = curBoxes();
  if(selIdx>=0 && selIdx<boxes.length){
    const h = hitHandle(boxes[selIdx], mx, my);
    if(h){ pushHistory(); mode='resize'; drag={x:mx,y:my, handle:h, b:boxes[selIdx].slice()}; return; }
  }
  for(let i=boxes.length-1;i>=0;i--){
    if(hitBox(boxes[i], mx, my)){
      if(tool==='sel' || e.shiftKey){
        selIdx=i; pushHistory(); mode='move';
        drag={x:mx, y:my, b1:boxes[i][1], b2:boxes[i][2], px:p.x, py:p.y};
        render(); updatePanel(); return;
      }
      selIdx=i; render(); updatePanel(); return;
    }
  }
  if(tool==='draw' || e.altKey){
    pushHistory(); selIdx=-1; mode='draw';
    drag = {x:mx, y:my, p0x:p.x, p0y:p.y};
    boxes.push([0, clamp01(p.x/fitW), clamp01(p.y/fitH), 0.0001, 0.0001]);
    render(); updatePanel();
  }
});
cv.addEventListener('pointermove', e=>{
  if(mode==='idle'){
    const {mx,my} = cvPos(e);
    cv.style.cursor = (selIdx>=0 && hitHandle(curBoxes()[selIdx],mx,my)) ? 'nwse-resize' : (hitBoxList(mx,my) ? 'move' : 'crosshair');
    return;
  }
  const {mx,my} = cvPos(e);
  const p = toImageXY(mx,my);
  const boxes = curBoxes();
  if(mode==='draw' && drag){
    const b = boxes[boxes.length-1];
    b[1] = clamp01(Math.min(drag.p0x, p.x)/fitW);
    b[2] = clamp01(Math.min(drag.p0y, p.y)/fitH);
    b[3] = clamp01(Math.max(drag.p0x, p.x)/fitW) - b[1];
    b[4] = clamp01(Math.max(drag.p0y, p.y)/fitH) - b[2];
    render();
  }else if(mode==='move' && drag && selIdx>=0){
    const b = boxes[selIdx];
    let nx = clamp01(drag.b1 + (p.x-drag.px)/fitW);
    let ny = clamp01(drag.b2 + (p.y-drag.py)/fitH);
    nx = Math.min(nx, 1-b[3]); ny = Math.min(ny, 1-b[4]);
    b[1]=nx; b[2]=ny;
    render();
  }else if(mode==='resize' && drag && selIdx>=0){
    const b = boxes[selIdx];
    const x = drag.b[1]*fitW, y = drag.b[2]*fitH, w = drag.b[3]*fitW, h = drag.b[4]*fitH;
    let L=x, R=x+w, T=y, B=y+h;
    const hh = drag.handle;
    if(hh.includes('w')) L = Math.min(p.x, x+w-4);
    if(hh.includes('e')) R = Math.max(p.x, x+4);
    if(hh.includes('n')) T = Math.min(p.y, y+h-4);
    if(hh.includes('s')) B = Math.max(p.y, y+4);
    R = Math.max(R, L+4); B = Math.max(B, T+4);
    b[1]=clamp01(L/fitW); b[2]=clamp01(T/fitH);
    b[3]=clamp01(R/fitW)-b[1]; b[4]=clamp01(B/fitH)-b[2];
    render();
  }
});
cv.addEventListener('pointerup', ()=>{
  if(mode==='draw'){
    const boxes = curBoxes();
    const b = boxes[boxes.length-1];
    if(b && (b[3]*fitW < 5 || b[4]*fitH < 5)){
      boxes.pop();
      if(undoStack.length) undoStack.pop();
      selIdx=-1;
    }
  }
  if(mode!=='idle'){ mode='idle'; drag=null; save(); updatePanel(); updateToolbar(); }
});
function hitBoxList(mx,my){
  const boxes = curBoxes();
  for(let i=boxes.length-1;i>=0;i--) if(hitBox(boxes[i],mx,my)) return true;
  return false;
}

cv.addEventListener('wheel', e=>{
  e.preventDefault();
  const {mx,my} = cvPos(e);
  zoomAt(mx, my, e.deltaY<0 ? 1.12 : 1/1.12);
},{passive:false});
let spaceDown=false, panDrag=null;
window.addEventListener('keydown', e=>{
  if(e.code==='Space'){ spaceDown=true; e.preventDefault(); cv.style.cursor='grab'; }
});
window.addEventListener('keyup', e=>{ if(e.code==='Space'){ spaceDown=false; cv.style.cursor=''; } });
cv.addEventListener('pointerdown', e=>{
  if(spaceDown){
    const {mx,my}=cvPos(e); panDrag={x:mx,y:my}; cv.style.cursor='grabbing'; e.preventDefault(); return;
  }
});
cv.addEventListener('pointermove', e=>{
  if(panDrag){ const {mx,my}=cvPos(e); view.ox+=mx-panDrag.x; view.oy+=my-panDrag.y; panDrag={x:mx,y:my}; render(); }
});
cv.addEventListener('pointerup', ()=>{ panDrag=null; cv.style.cursor = spaceDown?'grab':''; });
cv.addEventListener('dblclick', ()=>fitCanvas());

// ---------- 面板 / 工具栏 ----------
function updatePanel(){
  const rel = state.current, f = state.frames[rel];
  const meta = INIT.frames[rel] || {};
  document.getElementById('curRel').innerHTML = rel + (meta.src? ' <span class="src-tag">'+meta.src+'</span>':'');
  const amb = document.getElementById('ambNote');
  if(f.note){ amb.style.display=''; amb.textContent = 'ℹ 初判备注: ' + f.note + (f.fire!=='-' ? '  ·  fire置信=' + f.fire : ''); }
  else amb.style.display='none';
  const bl = document.getElementById('boxList');
  bl.innerHTML='';
  if(!f.boxes.length){ bl.innerHTML='<div class="empty">本帧暂无框（确认无烟则保持为空）</div>'; }
    f.boxes.forEach((b,i)=>{
    const row = document.createElement('div');
    row.className = 'boxrow' + (i===selIdx?' sel':'');
    row.innerHTML = `<span class="idx">${i}</span><span class="wh">${CLS_NAME[b[0]]||b[0]} · ${(b[3]*100).toFixed(1)}×${(b[4]*100).toFixed(1)}%</span><span class="del" title="删除">✕</span>`;
    row.onclick = ()=>{ selIdx=i; render(); updatePanel(); };
    const del = row.querySelector('.del');
    if (del) del.onclick = (ev)=>{ ev.stopPropagation(); deleteBox(i); };
    bl.appendChild(row);
  });
  const badge = document.getElementById('progBadge');
  const done = order.filter(r=>state.frames[r].status==='reviewed').length;
  badge.textContent = '已复核 ' + done + ' / ' + order.length;
  badge.className = 'badge' + (done===order.length?' done':'');
  const v = visibleOrder();
  const pos = v.indexOf(rel)+1;
  document.getElementById('posText').textContent = (pos>=0? pos : '?') + ' / ' + v.length + (activeSrc?' ('+order.length+' 全)':'');
  buildThumbs();
}
function updateToolbar(){
  document.getElementById('undoB').disabled = !undoStack.length;
  document.getElementById('redoB').disabled = !redoStack.length;
  document.getElementById('delB').disabled = selIdx<0;
  document.getElementById('toolDraw').classList.toggle('active', tool==='draw');
  document.getElementById('toolSel').classList.toggle('active', tool==='sel');
}
function deleteBox(i){
  const boxes = curBoxes();
  if(i<0 || i>=boxes.length) return;
  pushHistory(); boxes.splice(i,1); selIdx=-1; save(); render(); updatePanel(); updateToolbar();
}
function resetFrame(){
  pushHistory();
  const f = state.frames[state.current];
  f.boxes = (INIT.frames[state.current].boxes||[]).map(b=>b.slice());
  f.status = 'pending';
  selIdx=-1; save(); render(); updatePanel(); updateToolbar(); toast('已恢复 AI 初始框');
}
function markReviewed(){
  const f = state.frames[state.current];
  f.status = f.status==='reviewed' ? 'pending' : 'reviewed';
  save(); updatePanel(); toast(f.status==='reviewed' ? '已标记复核 ✓' : '已取消复核标记');
}
function gotoFrame(rel){
  save();
  state.current = rel; selIdx=-1; mode='idle'; drag=null;
  fitCanvas();
  updatePanel(); updateToolbar();
}

// ---------- 批次过滤 ----------
function buildSrcFilter(){
  const srcs = [...new Set(order.map(r => INIT.frames[r].src || 'unknown'))];
  const f = document.getElementById('srcFilter');
  f.innerHTML='';
  const all = document.createElement('span');
  all.className = 'src-chip' + (activeSrc===''?' active':'');
  all.textContent = '全部 ('+order.length+')';
  all.onclick = ()=>{ activeSrc=''; buildSrcFilter(); updatePanel(); };
  f.appendChild(all);
  srcs.forEach(s=>{
    const cnt = order.filter(r => (INIT.frames[r].src||'')===s).length;
    const c = document.createElement('span');
    c.className = 'src-chip' + (activeSrc===s?' active':'');
    c.textContent = s + ' ('+cnt+')';
    c.onclick = ()=>{ activeSrc = (activeSrc===s?'':s); buildSrcFilter(); updatePanel(); };
    f.appendChild(c);
  });
  const total = visibleOrder().length;
  document.getElementById('filterStat').textContent = activeSrc? '当前过滤：'+activeSrc+'，'+total+' 帧' : '已显示全部';
}

// ---------- 缩略图 ----------
function buildThumbs(){
  const t = document.getElementById('thumbs'); t.innerHTML='';
  const show = visibleOrder();
  show.forEach((rel,i)=>{
    const meta = INIT.frames[rel];
    const d = document.createElement('div');
    d.className = 'thumb' + (rel===state.current?' cur':'') + (state.frames[rel].status==='reviewed'?' rev':'');
    const im = document.createElement('img');
    im.src = meta.url;
    im.loading = 'lazy';
    d.appendChild(im);
    const st = document.createElement('div');
    st.className = 'st' + (state.frames[rel].status==='reviewed'?' ok':'');
    d.appendChild(st);
    const n = document.createElement('div'); n.className='n'; n.textContent = (order.indexOf(rel));
    d.appendChild(n);
    d.onclick = ()=>gotoFrame(rel);
    t.appendChild(d);
  });
  const cur = t.querySelector('.cur');
  if(cur) cur.scrollIntoView({block:'nearest', inline:'center', behavior:'smooth'});
}

// ---------- 导出 ----------
function exportJson(){
  const out = {};
  order.forEach(rel=>{ out[rel] = state.frames[rel].boxes.map(b=>b.slice()); });
  const blob = new Blob([JSON.stringify(out,null,2)], {type:'application/json'});
  download(blob, 'v5ai_v3_labels_export.json');
  toast('已导出 JSON（'+Object.keys(out).length+' 帧）');
}
function exportYolo(){
  let txt = '# v3 标注工作台导出 · 合并 YOLO 标签\n# 格式: 每帧以 # rel 开头，后续每行 = cls cx cy w h（归一化）\n';
  order.forEach(rel=>{
    const bs = state.frames[rel].boxes;
    txt += '\n# ' + rel + '\n';
    if(!bs.length) txt += '# (无框)\n';
    bs.forEach(b=>{ txt += b.join(' ') + '\n'; });
  });
  const blob = new Blob([txt], {type:'text/plain'});
  download(blob, 'v5ai_v3_yolo_labels.txt');
  toast('已导出 YOLO 合并标签');
}
function download(blob, name){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 300);
}

// ---------- 事件绑定 ----------
function gotoVisible(delta){
  const v = visibleOrder();
  const i = v.indexOf(state.current);
  const n = (i + delta + v.length) % v.length;
  gotoFrame(v[n]);
}
document.getElementById('prevB').onclick = ()=>gotoVisible(-1);
document.getElementById('nextB').onclick = ()=>gotoVisible(1);
document.getElementById('toolDraw').onclick = ()=>{ tool='draw'; updateToolbar(); };
document.getElementById('toolSel').onclick = ()=>{ tool='sel'; updateToolbar(); };
document.getElementById('undoB').onclick = undo;
document.getElementById('redoB').onclick = redo;
document.getElementById('delB').onclick = ()=>deleteBox(selIdx);
document.getElementById('resetB').onclick = resetFrame;
document.getElementById('markB').onclick = markReviewed;
document.getElementById('markB2').onclick = markReviewed;
document.getElementById('expJson').onclick = exportJson;
document.getElementById('expYolo').onclick = exportYolo;
window.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA') return;
  if((e.ctrlKey||e.metaKey) && e.key==='z'){ e.preventDefault(); undo(); }
  else if((e.ctrlKey||e.metaKey) && e.key==='y'){ e.preventDefault(); redo(); }
  else if(e.key==='Delete' || e.key==='Backspace'){ if(selIdx>=0){ e.preventDefault(); deleteBox(selIdx); } }
  else if(e.key==='ArrowLeft'){ gotoVisible(-1); }
  else if(e.key==='ArrowRight'){ gotoVisible(1); }
  else if(e.key==='1'){ tool='draw'; updateToolbar(); }
  else if(e.key==='2'){ tool='sel'; updateToolbar(); }
});
window.addEventListener('resize', ()=>fitCanvas());
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 1400);
}

// ---------- 启动 ----------
state = loadState();
buildSrcFilter();
fitCanvas();
updatePanel();
updateToolbar();
window.__v5ai_v3 = {
  getBoxes: () => curBoxes().map(b=>b.slice()),
  getTool: () => tool,
  getMode: () => mode,
  getSel: () => selIdx,
  getView: () => ({zoom:view.zoom, ox:view.ox, oy:view.oy, fitW, fitH}),
  getOrder: () => order.slice(),
  getActive: () => activeSrc,
  setSrc: (s) => { activeSrc = s||''; buildSrcFilter(); updatePanel(); },
  state: () => state,
};
</script>
</body>
</html>'''


def jdump(o):
    """安全 JSON 序列化（HTML 安全）"""
    return json.dumps(o, ensure_ascii=False).replace('</', '<\\/')


def build_init_from_url_spec(spec_path):
    """从外部 spec.json 读 INIT 数据
    spec.json 格式:  {
      "title": "v3 多批标注",
      "frames": [
        {"rel": "0826/f001.jpg", "url": "/v5_photos/0826/f001.jpg", "src": "video", "boxes": [[0,0.1,0.2,0.3,0.4]], "note":"", "fire":"-"},
        ...
      ]
    }
    """
    spec = json.load(open(spec_path, encoding='utf-8'))
    order = []
    frames = {}
    for f in spec['frames']:
        rel = f['rel']
        order.append(rel)
        frames[rel] = {
            'boxes': f.get('boxes', []),
            'note':  f.get('note', ''),
            'fire':  f.get('fire', '-'),
            'url':   f.get('url', ''),
            'src':   f.get('src', 'unknown'),
        }
    return {
        'title': spec.get('title', 'v3 多批标注'),
        'order': order,
        'frames': frames,
    }


def render(init_data, out_path):
    total = len(init_data['order'])
    html = HTML
    # 移除占位注释（避免 /* */ 嵌套），INIT 数据直接跟在 const 声明后
    html = html.replace('/* __INIT_DATA__ */', '')
    html = html.replace('/*__INIT__*/', jdump(init_data))
    html = html.replace('__TOTAL__', str(total))
    html = html.replace('__BATCH__', init_data.get('title', ''))
    open(out_path, 'w', encoding='utf-8').write(html)
    print(f'OK 写入 {out_path}')
    print(f'  总帧数: {total}')
    print(f'  按批次:')
    src_cnt = {}
    for r in init_data['order']:
        s = init_data['frames'][r].get('src', '?')
        src_cnt[s] = src_cnt.get(s, 0) + 1
    for s, c in src_cnt.items():
        print(f'    {s}: {c}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--spec', required=True, help='INIT spec JSON 路径')
    ap.add_argument('--out',  default=DEFAULT_OUT)
    args = ap.parse_args()
    init = build_init_from_url_spec(args.spec)
    render(init, args.out)


if __name__ == '__main__':
    main()
