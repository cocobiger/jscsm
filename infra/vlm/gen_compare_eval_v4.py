#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v3-RTDETR / v5-v1 / v5-v2 / v5-v3 四模型 400 帧实测对比 HTML 报告
输入: eval_compare_v4.json (服务器生成后拉回 infra/vlm/)
输出: outputs/v5_compare_eval_v4.html (浅色主题)
"""
import json, datetime

D = json.load(open('E:/CC work/CC jsc/infra/vlm/eval_compare_v4.json', encoding='utf-8'))
now = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')

thrs = D['thrs']
models = {'v1': 'v5-v1', 'v2': 'v5-v2', 'v5v3': 'v5-v3', 'v3rt': 'v3-RTDETR'}
order = ['v1', 'v2', 'v5v3', 'v3rt']
pos, neg, total = D['meta']['pos'], D['meta']['neg_other'], D['meta']['total']

def trow(rows, thr):
    r = next(x for x in rows if x['thr'] == thr)
    return f"<td>{r['hit']}</td><td>{r['tp']}</td><td>{r['recall']:.3f}</td><td>{r['fp']}</td><td>{r['fpr']:.3f}</td>"

body_rows = ''
for t in thrs:
    body_rows += f'<tr><th>{t}</th>' + ''.join(trow(D[k], t) for k in order) + '</tr>\n'

# 行为画像（基于 0.25 阈值）
profiles = {}
for k in order:
    r = next(x for x in D[k] if x['thr'] == 0.25)
    rec, fpr = r['recall'], r['fpr']
    if rec >= 0.8 and fpr > 0.5:
        tag, cls, desc = '高敏 · 误报爆炸', 'red', '几乎不漏检但大量误报，生产不可直接使用'
    elif rec < 0.1 and fpr < 0.05:
        tag, cls, desc = '低敏低噪 · 过保守', 'green', '误报极低，但召回不足，会漏掉大量真烟'
    elif rec < 0.1:
        tag, cls, desc = '低敏 · 召回坍塌', 'amber', '对真实航拍烟响应弱，置信度整体偏低'
    elif rec < 0.5:
        tag, cls, desc = '中敏 · 有提升空间', 'amber', '召回与误报平衡，仍需扩样本提升'
    else:
        tag, cls, desc = '高敏 · 可评估', 'blue', '召回强，误报可控，接近可用'
    profiles[k] = (tag, cls, desc, rec)

cards = ''
for k in order:
    r25 = next(x for x in D[k] if x['thr'] == 0.25)
    r10 = next(x for x in D[k] if x['thr'] == 0.10)
    tag, cls, desc, _ = profiles[k]
    cards += f'''<div class="box {cls}">
    <div class="lbl">{models[k]} {('YOLO11m@1280' if k!='v3rt' else 'RT-DETR@960')}</div>
    <div class="num">{r25['recall']*100:.1f}%</div>
    <div class="desc">conf≥0.25 召回 {r25['recall']*100:.1f}% ({r25['tp']}/{pos}) · 误报率 {r25['fpr']*100:.1f}% ({r25['fp']}/{neg})<br>conf≥0.10 召回 {r10['recall']*100:.1f}% / 误报 {r10['fpr']*100:.1f}%<br><span class="tag {cls}">{tag}</span></div>
  </div>'''

miss, fph = D['miss_25'], D['fph_25']

def chip(frames, head=12):
    items = '\n'.join(f'<li><code>{x}</code></li>' for x in frames[:head])
    more = f'<li class="more">… 余 {len(frames)-head} 帧</li>' if len(frames) > head else ''
    return f'<ul class="miss">{items}{more}</ul>'

# 漏检/误报对比卡（v2 vs v5-v3 为主 + v3rt）
def miss_card(k, title, note_html):
    return f'''<div class="subcard">
    <h3>{title}（{len(miss[k])} 帧）</h3>
    {note_html}
    {chip(miss[k])}
  </div>'''

def fph_card(k, title, note_html):
    return f'''<div class="subcard">
    <h3>{title}（{len(fph[k])} 帧）</h3>
    {note_html}
    {chip(fph[k])}
  </div>'''

n_v2_miss = len(miss['v2']); n_v3_miss = len(miss['v5v3'])
v2_better = n_v3_miss < n_v2_miss
miss_v2_note = f'<div class="note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">v2 召回短板 — 真实烟特征覆盖不足</div>' if n_v2_miss > n_v3_miss else '<div class="note" style="background:var(--green-bg);border-color:#bbf7d0;color:#166534">v2 漏检较少</div>'
miss_v3_note = f'<div class="note" style="background:var(--green-bg);border-color:#bbf7d0;color:#166534">v5-v3 用户标注后漏检大幅收窄</div>' if v2_better else '<div class="note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">v5-v3 漏检仍偏多</div>'

# 洞见（动态）
def cell(k, thr, key):
    return next(x for x in D[k] if x['thr'] == thr)[key]

p_v3_tag = profiles['v5v3'][0]
p_v3_rec = profiles['v5v3'][3] * 100
p_v3_tp = cell('v5v3', 0.25, 'tp')
p_v3_fpr = cell('v5v3', 0.25, 'fpr') * 100
v2_rec25 = cell('v2', 0.25, 'recall') * 100
v3_vs_v2 = '显著提升' if v2_better else '未见提升'
p_v3rt_rec = profiles['v3rt'][3] * 100
p_v3rt_fpr = cell('v3rt', 0.25, 'fpr') * 100
n_fph_v3 = len(fph['v5v3']); n_fph_v2 = len(fph['v2'])

insights = []
insights.append(
    '<li><b>v5-v3（用户复核标注版）行为画像：%s</b> — conf≥0.25 召回 %.1f%%（%d/%d）、'
    '误报率 %.1f%%。相比 v2（召回 %.1f%%）%s，用户 53 框细分标注的价值需要结合误报看。'
    % (p_v3_tag, p_v3_rec, p_v3_tp, pos, p_v3_fpr, v2_rec25, v3_vs_v2)
)
if D['v5v3'] != D['v2']:
    insights.append(
        '<li><b>与 v2 对比</b>：v5-v3 漏检 %d 帧 vs v2 %d 帧%s；误报 %d 帧 vs v2 %d 帧。</li>'
        % (n_v3_miss, n_v2_miss, '，用户标注修正见效' if v2_better else '，改进空间仍大', n_fph_v3, n_fph_v2)
    )
insights.append(
    '<li><b>v3-RTDETR 仍是高敏型</b>：召回 %.1f%% 但误报 %d 帧（%.1f%%），"二次过滤/级联"仍是生产化方向。</li>'
    % (p_v3rt_rec, len(fph['v3rt']), p_v3rt_fpr)
)
insights.append('<li><b>样本量仍是天花板</b>：v3 训练集真实烟 26 帧/53 框（用户复核），相比 v2 的 27 帧/27 框，框量翻倍但帧数未增——下一轮重点仍是扩真实烟帧数至 100+。</li>')

insight_html = '<ol class="insight">' + ''.join(insights) + '</ol>'

HTML = f'''<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>v3-RTDETR / v5-v1 / v5-v2 / v5-v3 四模型 400 帧实测对比</title>
<style>
:root{{ --bg:#f5f6f8; --card:#fff; --line:#e2e5ea; --ink:#1f2937; --sub:#6b7280;
  --blue:#2563eb; --blue-bg:#eff6ff; --amber:#f59e0b; --amber-bg:#fffbeb; --amber-ink:#92400e;
  --red:#dc2626; --red-bg:#fef2f2; --green:#16a34a; --green-bg:#f0fdf4; }}
*{{box-sizing:border-box}}
body{{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.6}}
.wrap{{max-width:1350px;margin:0 auto;padding:24px}}
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
.grid4{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}
.box{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}}
.box .lbl{{font-size:12px;color:var(--sub);font-weight:600;margin-bottom:4px}}
.box .num{{font-size:26px;font-weight:700;line-height:1.2}}
.box .desc{{font-size:12.5px;color:var(--sub);margin-top:6px}}
.box.red .num{{color:var(--red)}}  .box.red{{border-color:#fecaca}}
.box.green .num{{color:var(--green)}}  .box.green{{border-color:#bbf7d0}}
.box.blue .num{{color:var(--blue)}}  .box.blue{{border-color:#bfdbfe}}
.tag{{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}}
.tag.red{{background:var(--red-bg);color:var(--red)}}
.tag.amber{{background:var(--amber-bg);color:var(--amber-ink)}}
.tag.green{{background:var(--green-bg);color:var(--green)}}
.tag.blue{{background:var(--blue-bg);color:var(--blue)}}
ul.miss{{margin:6px 0 0;padding-left:18px;font-size:12px;line-height:1.85}}
ul.miss code{{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:11.5px}}
ul.miss .more{{color:var(--sub);list-style:none;margin-left:-18px}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:12px}}
.subcard{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}}
.insight li{{margin-bottom:6px}}
code{{background:#f3f4f6;padding:1px 6px;border-radius:4px;font-size:12px}}
@media(max-width:1100px){{.grid4{{grid-template-columns:1fr 1fr}}.two{{grid-template-columns:1fr}}}}
</style></head>
<body><div class="wrap">
<h1>📊 v3-RTDETR / v5-v1 / v5-v2 / v5-v3 · 400 帧实测对比报告</h1>
<div class="meta">生成时间: {now} · 测试集: 400 帧（VLM 基准 {pos} 真烟 + {neg} 非真烟）· 用户复核标注版 v5-v3 首次入列</div>

<div class="note">
⚠ <b>口径差异声明</b>：v1 / v2 / v5-v3 是 YOLO 单跑 400 帧（conf=0.10 起报，imgsz=1280）一次性结果；
v3-RTDETR 数据来自 RT-DETR@960 fire 类长跑累加（v3_candidates.json），按 frame 抽 max conf 做阈值对比。
v5-v3 训练集 = 用户复核标注 26 帧/53 框 + wechat 52 + syn 400（从 v2 best 续训 100 epoch）。
</div>

<h2>🎯 核心结论：四模型行为画像（conf≥0.25）</h2>
<div class="grid4">
{cards}
</div>

<h2>📈 多阈值混淆矩阵（VLM 真烟基准）</h2>
<table>
<thead><tr><th rowspan="2">阈值</th>
{' '.join(f'<th colspan="5">{models[k]}</th>' for k in order)}</tr>
<tr>{''.join('<th>检出</th><th>TP</th><th>召回</th><th>FP</th><th>误报率</th>' for k in order)}</tr></thead>
<tbody>
{body_rows}
</tbody>
</table>

<h2>🔍 conf≥0.25 漏检 / 误报清单（v2 vs v5-v3 vs v3rt）</h2>
<div class="two">
  {miss_card('v2', 'v2 漏检真烟', miss_v2_note)}
  {miss_card('v5v3', 'v5-v3 漏检真烟', miss_v3_note)}
  {fph_card('v2', 'v2 误报非真烟', f'<div class="note" style="background:var(--green-bg);border-color:#bbf7d0;color:#166534">误报 {len(fph["v2"])} 帧</div>')}
  {fph_card('v5v3', 'v5-v3 误报非真烟', f'<div class="note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">误报 {len(fph["v5v3"])} 帧</div>' if len(fph["v5v3"])>0 else '<div class="note" style="background:var(--green-bg);border-color:#bbf7d0;color:#166534">零误报</div>')}
  {fph_card('v3rt', 'v3-RTDETR 误报非真烟', f'<div class="note" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">误报 {len(fph["v3rt"])} 帧 — 生产不可用根因</div>')}
</div>

<h2>💡 关键洞见</h2>
<div class="card">
{insight_html}
</div>

<h2>🛠 决策建议</h2>
<div class="card">
<table>
<thead><tr><th>策略</th><th>预期效果</th><th>代价</th><th>推荐度</th></tr></thead>
<tbody>
<tr><td>继续扩真实烟样本（标注工作台 + 司空2 新截图，目标 100+ 帧）</td><td>召回整体上移、置信度爬升</td><td>人工标注工时</td><td>⭐⭐⭐⭐⭐ 首选</td></tr>
<tr><td>v5-v3 续训轮次（v5v3 best → v5-v4，加新标注）</td><td>标注质量红利再释放</td><td>1 次训练时长</td><td>⭐⭐⭐⭐ 随扩样本推进</td></tr>
<tr><td>v2/v5-v3 + v3-RTDETR 级联</td><td>保留高召回 + 剔除误报</td><td>双模型并行 2× GPU</td><td>⭐⭐⭐ 中期</td></tr>
<tr><td>v3-RTDETR 单模型 + 二次过滤</td><td>位置/时间/连续性规则止损</td><td>工程复杂度</td><td>⭐⭐ 短期</td></tr>
</tbody>
</table>
</div>

<div class="meta" style="margin-top:24px;text-align:center">
报告基于 <code>eval_compare_v4.json</code> · 部署 nginx :81/v5_compare_eval_v4.html
</div>
</div></body></html>'''

out = 'E:/CC work/CC jsc/outputs/v5_compare_eval_v4.html'
open(out, 'w', encoding='utf-8').write(HTML)
print(f'OK  {out}')
