#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_wanzhou_towns.py —— 生成 / 校验 wanzhou_towns.geojson（驾驶舱镇街反查数据）

背景：该文件**只用于**告警坐标的「乡镇归属」判定（Point-in-Polygon 反查），
      决定告警推给哪个街道办。所以：
        · 坐标系必须是 **WGS84**（代码注释明确：geojson 为 WGS84）
        · 名称必须与业务口径一致（area_responsibility.town / 推送文案用）
      **绝不可用近似几何（如中心点+泰森多边形）凑数** —— 会把火点判给错的街道。

支持的取得方式（按推荐顺序）：
  A. --from-amap   KEY            高德 Web服务 key（subdistrict=1，取 polyline，GCJ-02→WGS84 自动转换）
  B. --from-file   xxx.geojson    已有 geojson 直接规范化（统一成 {name, division_code, ring}）
  C. --from-tianditu KEY          天地图（若其边界接口可用；返回 CGCS2000≈WGS84，无需转换）
  D. --verify      xxx.geojson    只校验，不生成

用法示例：
  python3 build_wanzhou_towns.py --from-amap <WEB服务KEY> --out wanzhou_towns.geojson
  python3 build_wanzhou_towns.py --from-file 手头.geojson --out wanzhou_towns.geojson
  python3 build_wanzhou_towns.py --verify wanzhou_towns.geojson

输出格式（后端 reverse-geocode.js / store.replaceBoundaries 期望的形状）：
{
  "type": "FeatureCollection",
  "features": [
    {"type":"Feature",
     "properties": {"name": "<镇街名>", "division_code": "<行政区划代码，可空>"},
     "geometry": {"type":"Polygon","coordinates":[[[lng,lat], ...]]}}
  ]
}
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request

UA = 'wanzhou-towns-builder/1.0'
# 万州区（500101）大致 bbox：用于结果自检，防止把邻区的乡镇混进来
WZ_BBOX = (107.80, 30.35, 108.70, 31.25)


# ─────────────────────────── 坐标转换（高德 GCJ-02 → WGS84）───────────────────────────
_A = 6378245.0
_EE = 0.00669342162296594323


def _out_of_china(lng: float, lat: float) -> bool:
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)


def _transform_lat(lng: float, lat: float) -> float:
    ret = (-100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat
           + 0.2 * math.sqrt(abs(lng)))
    ret += (20.0 * math.sin(6.0 * lng * math.pi) + 20.0 * math.sin(2.0 * lng * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lat * math.pi) + 40.0 * math.sin(lat / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(lat / 12.0 * math.pi) + 320 * math.sin(lat * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(lng: float, lat: float) -> float:
    ret = (300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat
           + 0.1 * math.sqrt(abs(lng)))
    ret += (20.0 * math.sin(6.0 * lng * math.pi) + 20.0 * math.sin(2.0 * lng * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lng * math.pi) + 40.0 * math.sin(lng / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(lng / 12.0 * math.pi) + 300.0 * math.sin(lng / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def gcj02_to_wgs84(lng: float, lat: float) -> tuple[float, float]:
    """GCJ-02 → WGS84（迭代逼近，精度 < 1e-6°，约 0.1m）。"""
    if _out_of_china(lng, lat):
        return lng, lat
    wlng, wlat = lng, lat
    for _ in range(8):
        dlat = _transform_lat(wlng - 105.0, wlat - 35.0)
        dlng = _transform_lng(wlng - 105.0, wlat - 35.0)
        rad = wlat / 180.0 * math.pi
        magic = math.sin(rad)
        magic = 1 - _EE * magic * magic
        sqrtmagic = math.sqrt(magic)
        dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * math.pi)
        dlng = (dlng * 180.0) / (_A / sqrtmagic * math.cos(rad) * math.pi)
        mlat, mlng = wlat + dlat, wlng + dlng
        wlat += lat - mlat
        wlng += lng - mlng
    return wlng, wlat


# ─────────────────────────── 取数：高德 ───────────────────────────
def fetch_amap(key: str, adcode: str = '500101') -> list[dict]:
    """高德行政区划：subdistrict=1 取到街道/镇级，extensions=all 带回 polyline（GCJ-02）。"""
    q = urllib.parse.urlencode({
        'keywords': adcode, 'subdistrict': 1, 'extensions': 'all', 'key': key,
    })
    url = f'https://restapi.amap.com/v3/config/district?{q}'
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        d = json.loads(r.read().decode('utf-8'))
    if str(d.get('status')) != '1':
        raise SystemExit(f"❌ 高德返回失败：info={d.get('info')} infocode={d.get('infocode')}"
                         f"\n   （USERKEY_PLAT_NOMATCH ⇒ 该 key 是「Web端(JS API)」类型，"
                         f"需换成「Web服务」类型的 key）")
    top = (d.get('districts') or [{}])[0]
    subs = top.get('districts') or []
    if not subs:
        raise SystemExit('❌ 高德未返回下级行政区（检查 adcode 与 subdistrict 参数）')
    feats = []
    for s in subs:
        pl = (s.get('polyline') or '').strip()
        if not pl:
            print(f"  ⚠️ {s.get('name')} 无 polyline，跳过", file=sys.stderr)
            continue
        ring = []
        for pt in pl.split(';'):
            try:
                lng, lat = (float(x) for x in pt.split(','))
            except ValueError:
                continue
            wlng, wlat = gcj02_to_wgs84(lng, lat)      # ★ GCJ-02 → WGS84
            ring.append([round(wlng, 6), round(wlat, 6)])
        if len(ring) < 4:
            print(f"  ⚠️ {s.get('name')} 点数不足({len(ring)})，跳过", file=sys.stderr)
            continue
        if ring[0] != ring[-1]:
            ring.append(ring[0])                        # 闭合环
        feats.append({
            'type': 'Feature',
            'properties': {'name': s.get('name') or '', 'division_code': str(s.get('adcode') or '')},
            'geometry': {'type': 'Polygon', 'coordinates': [ring]},
        })
    return feats


# ─────────────────────────── 取数：已有 geojson 规范化 ───────────────────────────
def from_file(path: str, assume_gcj: bool = False) -> list[dict]:
    with open(path, encoding='utf-8') as f:
        d = json.load(f)
    feats = d.get('features') if d.get('type') == 'FeatureCollection' else [d]
    out = []
    for f in feats or []:
        geom = f.get('geometry') or {}
        props = f.get('properties') or {}
        name = props.get('name') or props.get('town') or props.get('NAME') or ''
        code = props.get('division_code') or props.get('adcode') or props.get('code') or ''
        if not name:
            print('  ⚠️ 跳过无 name 的 feature', file=sys.stderr)
            continue
        coords = geom.get('coordinates') or []
        if geom.get('type') == 'MultiPolygon':
            # 取面积最大的那个环（后端只吃单环）
            best, bestn = None, 0
            for poly in coords:
                if poly and len(poly[0]) > bestn:
                    best, bestn = poly[0], len(poly[0])
            coords = best or []
        elif geom.get('type') == 'Polygon':
            coords = coords[0] if coords else []
        ring = []
        for pt in coords or []:
            try:
                lng, lat = float(pt[0]), float(pt[1])
            except (TypeError, IndexError, ValueError):
                continue
            if assume_gcj:
                lng, lat = gcj02_to_wgs84(lng, lat)
            ring.append([round(lng, 6), round(lat, 6)])
        if len(ring) < 4:
            continue
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        out.append({'type': 'Feature',
                    'properties': {'name': name, 'division_code': str(code)},
                    'geometry': {'type': 'Polygon', 'coordinates': [ring]}})
    return out


# ─────────────────────────── 校验 ───────────────────────────
def verify(feats: list[dict], strict: bool = True) -> int:
    print(f'=== 校验：共 {len(feats)} 个多边形 ===')
    bad = 0
    names, codes = set(), set()
    inside = 0
    for i, f in enumerate(feats, 1):
        nm = f['properties']['name']
        ring = f['geometry']['coordinates'][0]
        names.add(nm)
        if f['properties'].get('division_code'):
            codes.add(f['properties']['division_code'])
        # 环闭合
        if ring[0] != ring[-1]:
            print(f'  ❌ [{i}] {nm} 环未闭合'); bad += 1
        # 点数
        if len(ring) < 4:
            print(f'  ❌ [{i}] {nm} 点数 {len(ring)} < 4'); bad += 1
        # 坐标范围：既要在万州附近，又要是合法经纬度
        lngs = [p[0] for p in ring]; lats = [p[1] for p in ring]
        cx, cy = sum(lngs) / len(lngs), sum(lats) / len(lats)
        if not (WZ_BBOX[0] <= cx <= WZ_BBOX[2] and WZ_BBOX[1] <= cy <= WZ_BBOX[3]):
            print(f'  ⚠️ [{i}] {nm} 质心 ({cx:.4f},{cy:.4f}) 落在万州 bbox 之外 —— 可能是邻区数据')
            bad += 1
        else:
            inside += 1
        # 经度>纬度判断防"经纬颠倒"
        if max(lngs) < 100 or max(lats) > 90:
            print(f'  ⚠️ [{i}] {nm} 经纬度疑似颠倒'); bad += 1
    print(f'  名称唯一数: {len(names)}（重复会导致后写覆盖前写）')
    print(f'  含行政区划代码的: {len(codes)} 个')
    print(f'  质心落在万州范围内的: {inside}/{len(feats)}')
    # 参考：万州区共有 52 个乡镇街道（11 街道 + 29 镇 + 12 乡），数量明显偏少要警惕
    if not (40 <= len(feats) <= 60):
        print(f'  ⚠️ 数量 {len(feats)} 与"万州区约 52 个乡镇街道"的量级不符 —— 请核对是否漏项')
    if bad and strict:
        print(f'  ❌ 校验未通过（{bad} 项问题）')
        return 1
    print(f'  ✅ 校验通过（{bad} 项提示）')
    return 0


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--from-amap')
    g.add_argument('--from-tianditu')
    g.add_argument('--from-file')
    g.add_argument('--verify')
    ap.add_argument('--assume-gcj', action='store_true', help='输入是 GCJ-02（高德/腾讯）时自动转 WGS84')
    ap.add_argument('--out', default='wanzhou_towns.geojson')
    ap.add_argument('--no-strict', action='store_true')
    a = ap.parse_args()

    if a.verify:
        with open(a.verify, encoding='utf-8') as f:
            d = json.load(f)
        feats = d.get('features', [])
        return verify(feats, strict=not a.no_strict)

    if a.from_amap:
        print('▶ 从高德取街道/镇级边界（polyline，GCJ-02 → WGS84 转换）…')
        feats = fetch_amap(a.from_amap)
    elif a.from_tianditu:
        print('▶ 从天地图取…（若其边界接口不可用，请改用 --from-file）')
        raise SystemExit('❌ 天地图边界接口当前对该 key 返回 403/418，暂不可用；请改用 --from-file 或 --from-amap')
    else:
        print(f'▶ 从已有文件规范化：{a.from_file}')
        feats = from_file(a.from_file, assume_gcj=a.assume_gcj)

    if not feats:
        raise SystemExit('❌ 未得到任何多边形')
    rc = verify(feats, strict=not a.no_strict)
    if rc != 0:
        raise SystemExit('❌ 校验未通过，未写出文件（加 --no-strict 可强制写出）')

    out = {'type': 'FeatureCollection',
           '_comment': '万州区乡镇街道边界（WGS84）。由 build_wanzhou_towns.py 生成。'
                       '仅供 reverse-geocode 的 Point-in-Polygon 使用。',
           'features': feats}
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f'✅ 已写出 {a.out}（{len(feats)} 个多边形，{os.path.getsize(a.out)} 字节）')
    print('   部署：cp %s /data/HBJSC/backend/data/wanzhou_towns.geojson && systemctl restart jsc-backend' % a.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
