#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3 / v5-v1 / v5-v2 三方 400 帧实测对比 HTML 报告
输入: eval_compare.json
输出: outputs/v5_compare_eval.html (浅色主题)
"""
import json, datetime

D = json.load(open('E:/CC work/CC jsc/infra/vlm/eval_compare.json', encoding='utf-8'))
now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

thrs = D['thrs']
v1, v2, v3 = D['v1'], D['v2'], D['v3']
pos, neg, total = D['meta']['pos'], D['meta']['neg_other'], D['meta']['total']

def trow(rows, thr):
    r = next(x for x in rows if x['thr'] == thr)
    return f"<td>{r['hit']}</td><td>{r['tp']}</td><td>{r['recall']:.3f}</td><td>{r['fp']}</td><td>{r['fpr']:.3f}</td>"

# 三方阈值行（按 thr 排）
body_rows = ''
for t in thrs:
    body_rows += f'<tr><th>{t}</th>' + trow(v1, t) + trow(v2, t) + trow(v3, t) + '</tr>\n'

# 0.25 漏检/误报清单
miss = D['miss_25']
fph = D['fph_25']

def chip(frames, head=12):
    items = '\n'.join(f'<li><code>{x}</code></li>' for x in frames[:head])
    more = f'<li class="more">… 余 {len(frames)-head} 帧</li>' if len(frames) > head else ''
    return f'<ul class="miss">{items}{more}</ul>'

miss_v2 = chip(miss['v2'])
fph_v2 = chip(fph['v2'], 15)
miss_v3 = chip(miss['v3'])
fph_v3 = chip(fph['v3'], 15)

HTML = f'''<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>v3 / v5-v1 / v5-v2 三方 400 帧实测对比</title>
<style>
:root{{ --bg:#f5f6f8; --card:#fff; --line:#e2e5ea; --ink:#1f2937; --sub:#6b7280;
  --blue:#2563eb; --blue-bg:#eff6ff; --amber:#f59e0b; --amber-bg:#fffbeb; --amber-ink:#92400e;
  --red:#dc2626; --red-bg:#fef2f2; --green:#16a34a; --green-bg:#f0fdf4; }}
*{{box-sizing:border-box}}
body{{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.6}}
.wrap{{max-width:1300px;margin:0 auto;padding:24px}}
h1{{font-size:22px;margin:0 0 6px;font-weight:700}}
h2{{font-size:17px;margin:24px 0 10px;font-weight:700;padding-left:10px;border-left:3px solid var(--blue)}}
h3{{font-size:14px;margin:14px 0 6px;color:var(--sub);font-weight:600}}
.meta{{color:var(--sub);font-size:13px;margin-bottom:18px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}}
.note{{background:var(--amber-bg);border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;color:var(--amber-ink);font-size:13px;margin-bottom:14px}}
table{{width:100%;border-collapse:collapse;background:var(--card);border-radius:8px;overflow:hidden;font-size:13px}}
th,td{{padding:7px 10px;text-align:center;border-bottom:1px solid var(--line)}}
thead th{{background:#f9fafb;font-weight:700;color:var(--sub);font-size:12.5px}}
tbody th{{background:#f9fafb;font-weight:700;width:48px}}
tbody tr:hover{{background:#fafbff}}
.grid3{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}}
.box{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}}
.box .lbl{{font-size:12px;color:var(--sub);font-weight:600;margin-bottom:4px}}
.box .num{{font-size:28px;font-weight:700;line-height:1.2}}
.box .desc{{font-size:12.5px;color:var(--sub);margin-top:6px}}
.box.red .num{{color:var(--red)}}  .box.red{{border-color:#fecaca}}
.box.green .num{{color:var(--green)}}  .box.green{{border-color:#bbf7d0}}
.box.blue .num{{color:var(--blue)}}  .box.blue{{border-color:#bfdbfe}}
.tag{{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}}
.tag.red{{background:var(--red-bg);color:var(--red)}}
.tag.amber{{background:var(--amber-bg);color:var(--amber-ink)}}
.tag.green{{background:var(--green-bg);color:var(--green)}}
ul.miss{{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.85}}
ul.miss code{{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:11.5px}}
ul.miss .more{{color:var(--sub);list-style:none;margin-left:-18px}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
.subcard{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}}
.insight li{{margin-bottom:6px}}
code{{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:12px}}
</style></head>
<body><div class="wrap">
<h1>📊 v3 / v5-v1 / v5-v2 · 400 帧实测对比报告</h1>
<div class="meta">生成时间: {now} · 测试集: 400 帧（41 真烟 + 359 非真烟）· VLM 基准</div>

<div class="note">
⚠ <b>口径差异声明</b>：v1 与 v2 是 YOLO 单跑 400 帧（conf=0.10 起报，imgsz=1280）一次性结果；
v3 数据来自 RT-DETR@960 fire 类长跑累加（v3_candidates.json 累计 7992 hits），按 frame 抽 max conf 做阈值对比。
同帧集 400 张，但 v3 命中数 379 远高于 v1/v2（口径上 v3 触发条件更宽 = 长期布控持续累加）。
</div>

<h2>🎯 核心结论：三方三种行为画像</h2>
<div class="grid3">
  <div class="box red">
    <div class="lbl">v3 RT-DETR@960 (生产)</div>
    <div class="num">97.6%</div>
    <div class="desc">召回 40/41 真烟 — <b>但是误报率 94%</b>，每张含云/反光/灯的帧几乎都被 fire 类触发<br><span class="tag red">高敏 · 不可用</span></div>
  </div>
  <div class="box amber">
    <div class="lbl">v5-v1 YOLO11m@1280 (合成+微信近景)</div>
    <div class="num">17%</div>
    <div class="desc">召回 7/41 真烟 — 误报 13% (48/359)，仍把云/灯/建筑当烟<br><span class="tag amber">域偏移 · 受限</span></div>
  </div>
  <div class="box green">
    <div class="lbl">v5-v2 YOLO11m@1280 (含 27 真实烟)</div>
    <div class="num">2.4%</div>
    <div class="desc">召回 1/41 真烟 — 误报仅 0.3% (1/359)，<b>矫枉过正</b>，过保守<br><span class="tag green">低噪 · 召回不足</span></div>
  </div>
</div>

<h2>📈 多阈值混淆矩阵（VLM 41 帧真烟基准）</h2>
<table>
<thead><tr><th rowspan="2">阈值</th><th colspan="5">v1 (YOLO11m 合成烟)</th>
<th colspan="5">v2 (YOLO11m +27 真实烟)</th>
<th colspan="5">v3 (RT-DETR fire 长跑累加)</th></tr>
<tr><th>检出</th><th>TP</th><th>召回</th><th>FP</th><th>误报率</th>
<th>检出</th><th>TP</th><th>召回</th><th>FP</th><th>误报率</th>
<th>检出</th><th>TP</th><th>召回</th><th>FP</th><th>误报率</th></tr></thead>
<tbody>
{body_rows}
</tbody>
</table>

<h2>🔍 conf≥0.25 漏检 / 误报清单（v2 vs v3 关键对比）</h2>
<div class="two">
  <div class="subcard">
    <h3>v2 漏检真烟（40 帧未触发）</h3>
    <div class="note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">v2 召回崩盘主因 — 模型对真实航拍烟特征覆盖度严重不足</div>
    {miss_v2}
  </div>
  <div class="subcard">
    <h3>v3 漏检真烟（1 帧）</h3>
    <div class="note" style="background:var(--green-bg);border-color:#bbf7d0;color:#166534">v3 几乎不漏检，召回极强</div>
    {miss_v3}
  </div>
  <div class="subcard">
    <h3>v2 误报非真烟（仅 1 帧）</h3>
    <div class="note" style="background:var(--green-bg);border-color:#bbf7d0;color:#166534">误报率 0.3%，<b>云/灯/建筑零触发</b></div>
    {fph_v2}
  </div>
  <div class="subcard">
    <h3>v3 误报非真烟（307 帧）</h3>
    <div class="note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">误报率 85.5% — 这是 v3 生产不可用的根因</div>
    {fph_v3}
  </div>
</div>

<h2>💡 关键洞见</h2>
<div class="card">
<ol class="insight">
  <li><b>v2 不是 v1 与 v3 的"中间态"</b>，而是第三种独立行为模式：低敏低噪型。训完 27 真实烟后，模型彻底摆脱了"合成烟偏好"，但真实烟样本量(20 训练)不足以让模型学透真实烟特征，<b>confidence 普遍压低到 0.10-0.20 区间</b>。</li>
  <li><b>v2 修复"误报"目标已完美达成</b>（13%→0.3%），但触发了新的"召回坍塌"问题。这与平台期 mAP50=0.225、val R=0.272 的训练指标一致——数据瓶颈，不是训练 bug。</li>
  <li><b>v3 fire 类 = 事实上的烟类</b>：97.6% 召回证明它对真烟极度敏感，但 94% 误报说明它把所有"看起来像烟"的东西都标记。生产中需要"二次过滤"（位置/时间/连续性规则）才能用，或者用 v2 这样的低敏模型做预筛。</li>
  <li><b>三方互补策略可能成立</b>：v2 做"低噪预筛"（把云/灯/建筑剔除）→ v3 在 v2 通过的帧上做"高召回确认" → 大幅降低 v3 误报同时保留召回。这是后续 v3 训练可考虑的架构方向。</li>
  <li><b>最直接的路径仍是继续扩真实烟样本</b>：27 真实烟让误报从 13% 降至 0.3%，证明这条路线方向正确；样本量若提升到 100+，模型置信度爬升，召回可恢复。标注工作台 v5ai_label.html 是当前最关键的下一步。</li>
</ol>
</div>

<h2>🛠 决策建议</h2>
<div class="card">
<table>
<thead><tr><th>策略</th><th>预期效果</th><th>代价</th><th>推荐度</th></tr></thead>
<tbody>
<tr><td>继续扩真实烟样本（标注工作台 + 新截图）</td><td>召回从 12%→40%+，置信度整体上移</td><td>人工标注工时</td><td>⭐⭐⭐⭐⭐ 首选</td></tr>
<tr><td>v2 + v3 级联架构</td><td>保留 v3 召回 + 用 v2 剔除误报</td><td>双模型并行 2× GPU</td><td>⭐⭐⭐ 中期</td></tr>
<tr><td>v3 单模型 + 二次过滤</td><td>位置/时间/连续性规则</td><td>工程复杂度</td><td>⭐⭐ 短期止损</td></tr>
<tr><td>重训 v4（YOLO11l + 真实烟 50+）</td><td>彻底解决</td><td>需要 2-3 天扩样本+训练</td><td>⭐⭐⭐⭐ 中期（扩样本后启动）</td></tr>
</tbody>
</table>
</div>

<div class="meta" style="margin-top:24px;text-align:center">
报告基于 <code>eval_compare.json</code> · 部署 nginx :81/v5_compare_eval.html
</div>
</div></body></html>'''

out = 'E:/CC work/CC jsc/outputs/v5_compare_eval.html'
open(out, 'w', encoding='utf-8').write(HTML)
print(f'OK  {out}')
