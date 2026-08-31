#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""P3-2b: 生成 v5 训练集配比 HTML 报告"""
import json, os

JSON_PATH = "/video/shujuji/datasets/v5_train_balance_report.json"
HTML_OUT = "/video/llm_infer/v5_balance_report.html"
os.makedirs(os.path.dirname(HTML_OUT), exist_ok=True)


def fmt_pct(n, total):
    return f"{100*n/total:.1f}%" if total else "0%"


def main():
    d = json.load(open(JSON_PATH, encoding="utf-8"))
    m = d["merge"]
    nc = d["neg_classified"]
    extra = d["extra"]
    plan = d["plan"]

    total = m["total"]
    pos_after = plan["pos_after"]
    neg_from_merge = plan["neg_from_merge"]
    target_neg = plan["target_neg_count"]
    neg_picks = plan["neg_picks"]
    neg_picks_total = plan["neg_picks_total"]

    # 现实可达负样本（加上 v5_syn + v5_wechat）
    extra_neg_available = extra["v5_syn"] + extra["v5_wechat"]
    realistic_neg = neg_from_merge + extra_neg_available + neg_picks_total
    realistic_ratio = f"{pos_after/realistic_neg:.2f}" if realistic_neg else "n/a"

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>v5 训练集配比报告 · 2026-09-01</title>
<style>
:root{{--bg:#0e1116;--card:#161b22;--line:#21262d;--ink:#e6edf3;--sub:#7d8590;--blue:#58a6ff;--green:#3fb950;--amber:#d29922;--red:#f85149;--purple:#bc8cff;}}
*{{box-sizing:border-box}}body{{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.6}}
.wrap{{max-width:1200px;margin:0 auto;padding:24px 32px}}
h1{{font-size:24px;margin:0 0 8px;color:var(--blue)}}
h2{{font-size:18px;margin:28px 0 12px;color:var(--ink);border-bottom:1px solid var(--line);padding-bottom:6px}}
h3{{font-size:15px;margin:18px 0 8px;color:var(--blue)}}
.sub{{color:var(--sub);font-size:13px;margin:0 0 20px}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px 20px;margin-bottom:12px}}
.grid4{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}}
.kpi{{display:flex;flex-direction:column;padding:14px 18px;background:var(--card);border:1px solid var(--line);border-radius:8px}}
.kpi .v{{font-size:28px;font-weight:700;color:var(--blue)}}
.kpi .l{{font-size:12px;color:var(--sub);margin-top:4px}}
table{{width:100%;border-collapse:collapse;font-size:13px}}
th,td{{border:1px solid var(--line);padding:6px 10px;text-align:left}}
th{{background:#21262d;color:var(--ink);font-weight:600}}
tr:nth-child(even) td{{background:#1c2128}}
.tag{{display:inline-block;font-size:12px;padding:2px 10px;border-radius:12px;background:rgba(88,166,255,.15);color:var(--blue);border:1px solid rgba(88,166,255,.4);margin-right:4px}}
.tag.green{{background:rgba(63,185,80,.15);color:var(--green);border-color:rgba(63,185,80,.4)}}
.tag.amber{{background:rgba(210,153,34,.15);color:var(--amber);border-color:rgba(210,153,34,.4)}}
.tag.red{{background:rgba(248,81,73,.15);color:var(--red);border-color:rgba(248,81,73,.4)}}
.bar{{height:14px;background:#21262d;border-radius:3px;position:relative;overflow:hidden;margin:2px 0}}
.bar .fill{{height:100%;background:var(--blue);border-radius:3px;transition:width .3s}}
.bar.red .fill{{background:var(--red)}}.bar.green .fill{{background:var(--green)}}.bar.amber .fill{{background:var(--amber)}}.bar.purple .fill{{background:var(--purple)}}
.verdict{{background:#1c2128;border-left:3px solid var(--amber);padding:12px 16px;border-radius:4px;margin:16px 0}}
ol,ul{{padding-left:20px}}li{{margin:4px 0}}
code{{background:#0d1117;border:1px solid var(--line);padding:1px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,Consolas,monospace;color:var(--purple)}}
.note{{font-size:12px;color:var(--sub);margin-top:6px}}
</style>
</head>
<body>
<div class="wrap">

<h1>v5 训练集配比报告</h1>
<p class="sub">秸秆 v5 · 2026-09-01 · 含 P3-2a VLM 4 类干扰物分类结果</p>

<div class="grid4">
  <div class="kpi"><span class="v">{total}</span><span class="l">v5_train_merge 总图片</span></div>
  <div class="kpi"><span class="v">{m['targets_per_class'].get('0',0)}</span><span class="l">smoke 目标数</span></div>
  <div class="kpi"><span class="v">{m['targets_per_class'].get('1',0)}</span><span class="l">fire 目标数（v3 偏火根因）</span></div>
  <div class="kpi"><span class="v">{m['targets_per_class'].get('2',0)}</span><span class="l">house 目标数</span></div>
</div>

<h2>1. v5_train_merge 现状（nc=3 · 方案B 第2批）</h2>
<table>
<thead><tr><th>分类</th><th>图片数</th><th>占比</th><th>说明</th></tr></thead>
<tbody>
<tr><td>smoke-only</td><td>{m['single_class'].get('0',0)}</td><td>{fmt_pct(m['single_class'].get('0',0), total)}</td><td>仅含 smoke 标签</td></tr>
<tr><td>fire-only</td><td>{m['single_class'].get('1',0)}</td><td>{fmt_pct(m['single_class'].get('1',0), total)}</td><td>仅含 fire 标签</td></tr>
<tr><td>mixed {{0,1}}</td><td>{m['multi_class'].get('0|1',0)}</td><td>{fmt_pct(m['multi_class'].get('0|1',0), total)}</td><td>同图 smoke+fire</td></tr>
<tr><td>mixed {{0,2}}</td><td>{m['multi_class'].get('0|2',0)}</td><td>{fmt_pct(m['multi_class'].get('0|2',0), total)}</td><td>同图 smoke+house</td></tr>
<tr><td>空标签（纯负样本）</td><td>{m['empty']}</td><td>{fmt_pct(m['empty'], total)}</td><td>无任何标签</td></tr>
<tr><td><b>合计</b></td><td><b>{total}</b></td><td>100%</td><td>train {total-1000} + val 1000</td></tr>
</tbody>
</table>

<h3>来源分布（启发式按文件名）</h3>
<table>
<thead><tr><th>来源</th><th>张数</th><th>备注</th></tr></thead>
<tbody>
"""
    src_notes = {
        "candidate": "v5_candidates/record（视频抽帧）",
        "syn": "v5_syn（合成远烟 30~130px）",
        "dji": "DJI 双光 V 通道（仅 V，T 不入训练）",
        "wechat": "v5_wechat 微信图（12字符 hex 命名）",
        "other": "m4_rtdetr 历史训练集（其余 hex 命名）",
    }
    for src, cnt in m["sources"].items():
        html += f"<tr><td>{src}</td><td>{cnt}</td><td>{src_notes.get(src, '?')}</td></tr>\n"

    html += f"""</tbody></table>

<h2>2. P3-2a VLM 4 类干扰物分类（v5_candidates 359 帧）</h2>
<table>
<thead><tr><th>类别</th><th>张数</th><th>占比</th><th>说明</th></tr></thead>
<tbody>
"""
    cls_desc = {
        "pole": "电线杆/电线塔/通信塔",
        "concrete": "水泥地/硬化地面/道路",
        "cloud": "云彩/云朵/雾霭",
        "building": "民居/建筑物/房屋",
        "none": "画面干净，无典型干扰物",
        "other": "其他干扰物",
    }
    for c, cnt in sorted(nc["single_class"].items(), key=lambda x: -x[1]):
        pct = fmt_pct(cnt, nc["total"])
        html += f"<tr><td>{c}</td><td>{cnt}</td><td>{pct}</td><td>{cls_desc.get(c, '?')}</td></tr>\n"
    html += f"""<tr><td><b>合计</b></td><td><b>{sum(nc['single_class'].values())}</b></td><td>—</td><td>0 错误</td></tr>
</tbody></table>

<p class="note">⚠️ v5_candidates 数据偏向 CCTV 监控视角（pole 88%），与无人机俯瞰正样本视角差异大。建议：pole 全量、building 全量、cloud 抽样 100、concrete 全量、none 全量，共 {neg_picks_total} 张干扰物负样本。</p>

<h2>3. 派生 v5_smoke_v5 配方（nc=1 smoke-only）</h2>
<div class="card">
<h3>3.1 正样本</h3>
<table>
<thead><tr><th>来源</th><th>张数</th></tr></thead>
<tbody>
<tr><td>smoke-only 图</td><td>{m['single_class'].get('0',0)}</td></tr>
<tr><td>mixed {{0,1}} → 删 fire 框保留 smoke 框</td><td>{m['multi_class'].get('0|1',0)}</td></tr>
<tr><td>mixed {{0,2}} → 删 house 框保留 smoke 框</td><td>{m['multi_class'].get('0|2',0)}</td></tr>
<tr><td><b>正样本合计</b></td><td><b>{pos_after}</b></td></tr>
</tbody></table>

<h3>3.2 负样本方案</h3>
<table>
<thead><tr><th>来源</th><th>张数</th><th>类型</th></tr></thead>
<tbody>
<tr><td>fire-only（删 fire 框，保留图作负）</td><td>{m['single_class'].get('1',0)}</td><td>域内（v3 fire 误报集中区）</td></tr>
<tr><td>空标签（纯负）</td><td>{m['empty']}</td><td>已有</td></tr>
<tr><td>v5_syn（删 smoke 框作负）</td><td>{extra['v5_syn']}</td><td>合成远烟背景</td></tr>
<tr><td>v5_wechat（部分作负）</td><td>{extra['v5_wechat']}</td><td>街道办群众图（多样）</td></tr>
<tr><td>4 类干扰物（pole/concrete/building/cloud/none）</td><td>{neg_picks_total}</td><td>P3-2a VLM 分类</td></tr>
<tr><td><b>负样本合计（现实可达）</b></td><td><b>{realistic_neg}</b></td><td>正负比 1:{realistic_ratio}</td></tr>
</tbody></table>
</div>

<div class="verdict">
<strong>⚠️ 目标 1:2~1:3 vs 现实 1:{realistic_ratio}</strong><br>
按计划需要 {target_neg} 张负样本，现实可达 {realistic_neg} 张，**比例 {realistic_ratio}（偏正样本）**。<br>
<strong>建议：</strong>不强制 1:2~1:3，1:{realistic_ratio} 更现实且符合 v3 经验。理由：
<ol>
  <li>正样本 3588 张已含大量背景变化（v3 历史训练集），模型对负样本需求边际递减</li>
  <li>fire-only 4050 张虽然是 v3 旧训练集 fire 误报区，但与 v5 主流场景（无人机俯瞰）视角差异大，过多反而引入域差</li>
  <li>v5_syn 800 + v5_wechat 143 + 4 类干扰物 566 = 1509 张"真实可用"负样本，已能提供足够多样性</li>
</ol>
</div>

<h2>4. 训练推荐</h2>
<ul>
  <li><strong>数据集名</strong>：v5_train_v5（继承 v4 框架，nc=1）</li>
  <li><strong>正样本</strong>：{pos_after} 张（v5_train_merge 派生）</li>
  <li><strong>负样本</strong>：{realistic_neg} 张（4 类干扰物 + 删 fire 框 + 删 house 框 + 空标签 + v5_syn/v5_wechat）</li>
  <li><strong>夜场处理</strong>：v5_syn 已含 800 张合成远烟（多为黄昏/晨雾），夜场默认作负样本</li>
  <li><strong>农田占比</strong>：v5_train_merge 中 m4_rtdetr 训练集主要是 CCTV 监控（非农田）→ <span class="tag amber">需补真农田数据</span></li>
</ul>

<h2>5. 待办（P3-2b 后续）</h2>
<ul>
  <li>[ ] 写 <code>gen_v5_train_v5.py</code>：从 v5_train_merge 派生 nc=1 + 加 4 类干扰物负样本</li>
  <li>[ ] 配比验证：跑 v5_train_v5 拼装 → 检查实际 train/val 正负比</li>
  <li>[ ] 农田占比补强：从 straw_detections 抽 field 场景帧（待 2c 完成后联动）</li>
  <li>[ ] 夜场验证：跑亮度阈值分桶，确认夜场样本作负而非正</li>
</ul>

<p class="note">参考：docs/秸秆场景过滤评估与排期_20260831.html P3-2b · docs/真机联调SOP.md 待同步更新</p>

</div>
</body>
</html>"""

    open(HTML_OUT, "w", encoding="utf-8").write(html)
    print(f"saved -> {HTML_OUT} ({len(html)} bytes)")


if __name__ == "__main__":
    main()