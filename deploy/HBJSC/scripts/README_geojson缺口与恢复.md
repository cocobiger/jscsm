# wanzhou_towns.geojson 缺口与恢复指引

> ## ✅ 已解决（2026-09-30）
> 用户提供了《乡镇街道分界.geojson》（万州区 52 个乡镇街道，`EPSG:4490`≈WGS84）。
> 该文件结构特殊（**中文名在 Point 上、Polygon 的 name 是编号**）⇒ 用
> `build_wanzhou_towns.py --from-file "乡镇街道分界.geojson" --names-from-points --simplify-tol 0.0001`
> 生成再部署。实测：`area_boundary` seed **52 行**、启动日志「已加载 52 个乡镇/街道」、
> `/api/straw/reverse-geocode` 对 4 个已知点位 **4/4 命中**、界外点返回 null、**ENOENT 归零**。
> **下方内容保留为历史记录与方法论**（含尝试过的公开源、坑、以及工具用法）。
> 详细过程见 `.workbuddy/memory/REF_驾驶舱重新部署流程.md` **§13**。

> 状态：**缺失，待外部数据源**（2026-09-30，<s>历史状态</s>）
> 影响：告警坐标的**乡镇归属判定**（Point-in-Polygon 反查）、`area_boundary` 表 seed、
>       告警按街道推送的对象选择。**不影响**驾驶舱其它功能。

## 为什么没有
该文件**新增于 2026-08~09 月，未进入任何备份**（7/9 的全量备份早于它）。
本机、Git、所有本地压缩包中均**零命中**（`tmp/backup_geojson.sh` 也记录"数据可能只在 SQLite area_boundary 表里"，
而该表随服务器一起被清除）。

## 已尝试过的公开源（全部不可用）
| 源 | 结果 |
|---|---|
| OSM Overpass（kumi.systems 镜像可用） | 万州区 `admin_level=8` **0 条**；`7/10` 层超时、`9` 层 0 条 ⇒ 无乡镇几何 |
| 阿里云 DataV | `areas_v3/bound/500101_full.json` **404**（仅有到区县的 `500101.json`） |
| 天地图（key 有效，服务器端类型） | `v2/administrative` 只回区县基本信息、**无 boundary**；v1 边界接口被 **CloudWAF 418 拦截** |
| 高德 | 现有 key 为「Web端(JS API)」类型 → `USERKEY_PLAT_NOMATCH` / `INVALID_USER_KEY`，**不能调 Web 服务 API** |

## 怎么恢复（三种途径，任一即可）

### 途径 1（最快，约 10 分钟）——申请一个高德「Web服务」key
1. 到 https://lbs.amap.com/ 新建 key，**服务类型选「Web服务」**（不是 Web端 JS API）
2. 执行：
   ```bash
   python3 /data/HBJSC/scripts/build_wanzhou_towns.py --from-amap <WEB服务KEY> \
       --out /data/HBJSC/backend/data/wanzhou_towns.geojson
   systemctl restart jsc-backend
   ```
   脚本会：取街道/镇级 `polyline` → **GCJ-02→WGS84 自动转换**（本项目坐标系是 WGS84）→ 校验 → 落盘。

### 途径 2（最准）——从任何接触过该系统的机器找回原文件
原文件在旧机的 `/opt/jsc/backend/data/wanzhou_towns.geojson`（或 `/opt/jsc/backend/backups/geojson_backup_*/`）。
只要能找到一个副本（同事电脑、移动硬盘、邮件附件、任何导出的 `area_boundary.json`），
直接放到 `/data/HBJSC/backend/data/` 并 `systemctl restart jsc-backend` 即可（1 分钟）。

### 途径 3——官方/主管部门边界数据
从民政或规划部门获取万州区乡镇街道边界（GeoJSON/SHP），用：
```bash
python3 /data/HBJSC/scripts/build_wanzhou_towns.py --from-file 官方.geojson \
    --assume-gcj            # 若源是 GCJ-02（高德/腾讯系）才加此参数
    --out /data/HBJSC/backend/data/wanzhou_towns.geojson
```

## 格式要求（脚本会校验）
```json
{"type":"FeatureCollection","features":[
  {"type":"Feature",
   "properties":{"name":"<镇街名>","division_code":"<行政区划代码，可空>"},
   "geometry":{"type":"Polygon","coordinates":[[[lng,lat],[lng,lat],...,[lng,lat]]]}}
]}
```
- **坐标系必须 WGS84**（高德/腾讯是 GCJ-02，必须转换；天地图 CGCS2000 可当 WGS84 用）
- 单环（MultiPolygon 会自动取最大环）
- 名称必须与业务口径一致（`area_responsibility.town`，推送文案用它）
- 万州区应有 **约 52 个**乡镇街道（11 街道 + 29 镇 + 12 乡）——数量明显偏少要警惕漏项

## ⚠️ 禁止事项
**绝不可用"中心点 + 泰森多边形"之类的近似几何凑数。**
该数据决定告警归属**哪个街道办**，凑出来的边界会把火点判给错的街道 —— 比"暂时没有"危害更大。

## 校验
```bash
python3 /data/HBJSC/scripts/build_wanzhou_towns.py --verify /data/HBJSC/backend/data/wanzhou_towns.geojson
```
