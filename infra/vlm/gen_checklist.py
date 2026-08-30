# -*- coding: utf-8 -*-
"""生成 M3 人工复核清单 HTML（41 帧有烟候选）"""
import json
from collections import Counter

RES = '/video/shujuji/datasets/v5_candidates/vlm_results.json'
BR  = '/video/llm_infer/brightness.json'
V3  = '/video/shujuji/datasets/v5_candidates/v3_candidates.json'
BX  = '/video/llm_infer/boxes.json'
OUT = '/video/llm_infer/v5checklist.html'

res = json.load(open(RES))
br  = json.load(open(BR))
v3  = json.load(open(V3))
bx  = json.load(open(BX))
fire_cnt = Counter(h['frame'] for h in v3.get('hits', []))

smoke = sorted(k for k, v in res.items() if '烟' in v and '无烟' not in v)

rows = []
for i, k in enumerate(smoke, 1):
    rel = k.split('/record/')[-1]
    d, fname = rel.split('/')
    b = br.get(rel, {}).get('bright', -1)
    night = b >= 0 and b < 25
    f = fire_cnt.get(k, 0)
    nbox = len(bx.get(k, []))
    if night:
        pri, pri_cn = 'P2', '夜场·建议不确定'
    elif f <= 2:
        pri, pri_cn = 'P0', 'v3 漏检·高价值'
    elif f >= 50:
        pri, pri_cn = 'P1', 'v3 高响应·重点核'
    else:
        pri, pri_cn = 'P1', '日间·常规核'
    # 时间 = 录制目录 HH-MM-SS
    t = d[:8].replace('-', ':')
    rows.append(dict(i=i, d=d, f=fname, t=t, b=b, night=night,
                     fire=f, nbox=nbox, pri=pri, pri_cn=pri_cn))

n_night = sum(1 for r in rows if r['night'])
n_box   = sum(1 for r in rows if r['nbox'] > 0)
n_day   = len(rows) - n_night

# 时间排序
rows.sort(key=lambda r: r['d'])

def pri_badge(p):
    colors = {'P0': '#c0392b', 'P1': '#b7791f', 'P2': '#5b6b7c'}
    bg     = {'P0': '#fdecea', 'P1': '#fdf3e7', 'P2': '#eef1f4'}
    return f'<span class="pb" style="color:{colors[p]};background:{bg[p]}">{p} · {dict(P0="v3漏检高价值",P1="常规/高响应",P2="夜场")[p]}</span>'

trs = []
for r in rows:
    night_badge = '<span class="nb">夜场 亮度%.0f</span>' % r['b'] if r['night'] else '亮度%.0f' % r['b']
    box_badge = '<span class="bb">VLM框×%d</span>' % r['nbox'] if r['nbox'] else ''
    trs.append(f'''<tr>
      <td class="c">{r['i']:02d}</td>
      <td class="c">{r['t']}</td>
      <td><b>{r['d']}</b>/{r['f']}</td>
      <td class="c">{r['fire']}</td>
      <td class="c">{night_badge}</td>
      <td class="c">{box_badge}</td>
      <td>{pri_badge(r['pri'])}</td>
    </tr>''')
rows_html = '\n'.join(trs)

# 负样本统计
neg = json.load(open('/video/shujuji/datasets/v5_candidates/neg_list.json'))
neg_high = sum(1 for x in neg if x.get('fire', 0) >= 30)

html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>M3 人工复核清单 · 41 帧有烟候选</title>
<style>
  body {{ font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2937; margin: 0; padding: 24px 16px; }}
  .wrap {{ max-width: 960px; margin: 0 auto; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; color: #111827; }}
  .sub {{ color: #6b7280; font-size: 13px; margin-bottom: 16px; }}
  .stats {{ display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }}
  .stat {{ background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
           padding: 12px 18px; min-width: 110px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }}
  .stat b {{ display: block; font-size: 24px; color: #111827; }}
  .stat span {{ font-size: 12px; color: #6b7280; }}
  .tip {{ background: #fff8e6; border: 1px solid #f0dfa8; border-radius: 8px;
          padding: 10px 14px; font-size: 13px; color: #7a5b1a; margin-bottom: 18px; line-height: 1.7; }}
  table {{ width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px;
           overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.06); font-size: 13px; }}
  th {{ background: #eef2f6; color: #374151; text-align: left; padding: 10px 12px;
        font-size: 12px; white-space: nowrap; }}
  td {{ padding: 9px 12px; border-top: 1px solid #f0f1f3; vertical-align: middle; }}
  tr:hover td {{ background: #fafbfc; }}
  .c {{ text-align: center; }}
  .pb {{ display: inline-block; border-radius: 999px; padding: 2px 10px; font-size: 12px;
         white-space: nowrap; }}
  .nb {{ display: inline-block; border-radius: 4px; padding: 1px 8px; font-size: 12px;
         background: #1f2937; color: #fbbf24; }}
  .bb {{ display: inline-block; border-radius: 4px; padding: 1px 8px; font-size: 12px;
         background: #e8f0fe; color: #1a56db; }}
  .legend {{ font-size: 12px; color: #6b7280; margin: 14px 0 4px; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>M3 人工复核清单 · 41 帧有烟候选</h1>
  <div class="sub">数据源：400 帧抽帧（80 录制 × 5）· VLM Qwen2.5-VL-3B 判"有烟" · 生成于 2026-08-28 19:46</div>

  <div class="stats">
    <div class="stat"><b>{len(rows)}</b><span>有烟候选帧</span></div>
    <div class="stat"><b>{n_day}</b><span>日间帧（可确认烟形）</span></div>
    <div class="stat"><b>{n_night}</b><span>夜场帧（低可信）</span></div>
    <div class="stat"><b>{n_box}</b><span>VLM 画出框（仅参考）</span></div>
    <div class="stat"><b>{len(neg)}</b><span>负样本帧（VLM 判无烟）</span></div>
  </div>

  <div class="tip">
    <b>操作指引</b>：① 打开线上复核页 <code>http://111.10.220.226:81/v5review.html</code>（手机/电脑均可，41 张大图自包含）；
    ② 逐帧确认"有烟 / 无烟 / 不确定"（夜场帧除非明确看到烟形，建议标"不确定或无烟"）；
    ③ 全部完成后点底部"导出复核结果"，把 <code>v5_review_result.json</code> 发我 → 我按结果切分正/负样本进 M4 v2 训练。
  </div>

  <div class="legend">优先级说明：<b style="color:#c0392b">P0</b>=v3 漏检（fire≤2，正样本价值最高）｜ <b style="color:#b7791f">P1</b>=日间常规/高响应 ｜ <b style="color:#5b6b7c">P2</b>=夜场低可信</div>

  <table>
    <thead><tr>
      <th>#</th><th>录制时间</th><th>目录 / 文件</th><th>v3 fire 响应</th><th>亮度</th><th>VLM 框</th><th>优先级</th>
    </tr></thead>
    <tbody>
    {rows_html}
    </tbody>
  </table>

  <div class="sub" style="margin-top:18px">
    负样本侧：359 帧 VLM 判无烟（<code>neg_list.json</code>），其中 <b>{neg_high} 帧 v3 fire≥30 次</b>（居民区难负样本，M4 训练高优先级）。
    9 帧夜场：11-42-29-5/f5、12-39-46-0/f3~f5、12-42-51-6/f2、13-36-59-0/f4/f5、13-54-09-0/f4、14-42-52-8/f5。
  </div>
</div>
</body>
</html>'''

open(OUT, 'w', encoding='utf-8').write(html)
print('generated:', OUT, f'({len(html)//1024} KB)')
print(f'rows={len(rows)} day={n_day} night={n_night} boxed={n_box} neg={len(neg)} neg_high={neg_high}')
