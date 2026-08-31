// 秸秆 v5 · P3-2a VLM 分类抽检工具（5 类 + reflection）
// 数据源：/video/shujuji/datasets/v5_candidates/neg_classified.json
// 用法：浏览器打开，每帧三选一（✅正确 / ❌错误 / ❓不确定）
// 上传后端：/api/review/neg-classify-verify
//
// 抽样策略：每类至少 10 帧（pole 12 / concrete 12 / cloud 12 / building 12 / reflection 12 / none 5），共 ~65 帧
// 缩略图：nginx /v5_old_imgs/<rel>（按 mtime + 时间戳目录）

const CATS = ['pole', 'concrete', 'cloud', 'building', 'reflection', 'none', 'other'];
const COLORS = {
  pole: '#bc8cff',
  concrete: '#d29922',
  cloud: '#58a6ff',
  building: '#3fb950',
  reflection: '#42b0e8',  // 水面/天空青色
  none: '#7d8590',
  other: '#f85149',
};

let data = {};
let order = [];
let curIdx = 0;
let reviews = {};

async function init() {
  // 拉分类 JSON
  data = await fetch('/v5_candidates/neg_classified.json').then(r => r.json());
  // 抽样：每类 10~12 帧（多标签帧全类别分桶，抽样去重）
  const buckets = {};
  for (const [fp, v] of Object.entries(data)) {
    const cs = v.cats || [];
    if (!cs.length) continue;
    for (const c of cs) {
      (buckets[c] = buckets[c] || []).push(fp);
    }
  }
  const seen = new Set();
  const sample = [];
  for (const c of CATS) {
    const n = c === 'none' ? 5 : 12;
    let got = 0;
    for (const fp of buckets[c] || []) {
      if (got >= n) break;
      if (seen.has(fp)) continue;
      seen.add(fp);
      sample.push(fp);
      got++;
    }
  }
  order = sample;
  console.log('抽样帧数:', order.length, '各类可用:', Object.fromEntries(CATS.map(c => [c, (buckets[c]||[]).length])));

  // 加载历史复核（localStorage）
  reviews = JSON.parse(localStorage.getItem('neg_verify_v1') || '{}');

  document.getElementById('stats').innerText = `${order.length} 帧 · ${Object.keys(reviews).length} 已审`;
  render();
}

function render() {
  const fp = order[curIdx];
  const v = data[fp];
  const rel = fp.split('/record/')[1];
  const imgUrl = `/v5_old_imgs/${rel}`;
  const cats = v.cats || [];
  const catsHtml = cats.map(c => `<span class="badge" style="background:${COLORS[c]}33;color:${COLORS[c]};border:1px solid ${COLORS[c]}">${c}</span>`).join(' ');
  const review = reviews[fp] || '';

  document.getElementById('content').innerHTML = `
    <div class="frame">
      <div class="hd">
        <span class="idx">[${curIdx+1}/${order.length}]</span>
        <span class="rel">${rel}</span>
        <span class="ts">${v.ts || '?'}</span>
      </div>
      <img src="${imgUrl}" loading="lazy" />
      <div class="meta">
        <div class="cats">VLM 判定: ${catsHtml || '<em>none</em>'}</div>
        <div class="raw">raw: "${(v.raw||'').slice(0,60)}"</div>
      </div>
      <div class="actions">
        <button class="ok ${review==='ok'?'sel':''}" onclick="setReview('ok')">✅ 正确</button>
        <button class="no ${review==='no'?'sel':''}" onclick="setReview('no')">❌ 错误</button>
        <button class="dn ${review==='dn'?'sel':''}" onclick="setReview('dn')">❓ 不确定</button>
      </div>
      <div class="nav">
        <button onclick="prev()">← 上一帧</button>
        <button onclick="next()">下一帧 →</button>
        <button onclick="exportReviews()">导出结果</button>
      </div>
    </div>
  `;
}

function setReview(r) {
  reviews[order[curIdx]] = r;
  localStorage.setItem('neg_verify_v1', JSON.stringify(reviews));
  document.getElementById('stats').innerText = `${order.length} 帧 · ${Object.keys(reviews).length} 已审`;
  render();
}

function prev() { curIdx = (curIdx - 1 + order.length) % order.length; render(); }
function next() { curIdx = (curIdx + 1) % order.length; render(); }

function exportReviews() {
  const lines = ['frame,cats,raw,review'];
  for (const fp of order) {
    const v = data[fp] || {};
    const r = reviews[fp] || '';
    lines.push(`${fp},"${(v.cats||[]).join('|')}","${(v.raw||'').replace(/"/g,'""')}",${r}`);
  }
  const blob = new Blob([lines.join('\n')], {type: 'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `neg_verify_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

init();