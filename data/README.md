# data/ —— 万州区乡镇街道边界数据

用于「告警坐标 → 乡镇/街道归属」的离线 Point-in-Polygon 反查（决定告警推给哪个**街道办**）。

| 文件 | 大小 | 说明 |
|---|---|---|
| `wanzhou_towns.geojson` | ~1.5 MB | **成品**（52 个 Polygon，含中文名 + 编号）。后端直接读取的就是它 |
| `vendor/乡镇街道分界.geojson` | ~15 MB | **原始源文件**（只读归档，保留来源痕迹，勿直接给后端用） |

## 部署位置
```
/data/HBJSC/backend/data/wanzhou_towns.geojson
```
（可用环境变量 `WANZHOU_TOWNS_GEOJSON` 指向别处覆盖。）

## 源文件从哪来
《乡镇街道分界.geojson》，2026-09-30 由用户提供。
- `crs: EPSG:4490`（CGCS2000 ≈ WGS84，差 <1 m）
- md5：`91f1af2c7bbf66c212378556ac5fab1a`
- 覆盖万州区，bbox ≈ 107.87–108.91 E / 30.39–31.01 N
- **结构特殊（不是常规格式）**：`FeatureCollection` = **52 个 Point + 52 个 Polygon**
  - **Point**（前 52 个）：`properties.name` = **中文乡镇街道名**（周家坝街道…）
  - **Polygon**（后 52 个）：`properties.name` = **编号** `5001011210000000NN`（01–52 连号）
  - 两者**无显式外键** ⇒ 靠「点在多边形内」配对（实测 **52/52 完美 1:1**）
- 52 个名字构成：**11 街道 + 29 镇 + 12 乡**，与万州区官方口径一致

> ⚠️ **不要把 `vendor/` 里的原始文件直接给后端**：它的 Point 会让后端 seed 把 `ring` 解析成数字 →
> 迭代抛错 → 整个「行政边界初始化失败」。必须先经下面的规范化步骤。

## 再生成成品（一条命令）
```bash
cd deploy/HBJSC/scripts
python3 build_wanzhou_towns.py \
    --from-file "../../../data/vendor/乡镇街道分界.geojson" \
    --names-from-points --simplify-tol 0.0001 \
    --out ../../../data/wanzhou_towns.geojson
```
- `--names-from-points`：丢弃 Point + 用「点在多边形内」把中文名补到每个面上（面原编号挪到 `division_code` 保留来源）
- `--simplify-tol 0.0001`（≈11 m）：Douglas-Peucker 简化 → 顶点 301446 → 26829、体积 15 MB → 1.5 MB、**面积偏差 ≤ 0.12%**
- 不简化也可（去掉该参数），只是文件大 11 倍

## 坐标系（**WGS84 / CGCS2000，不做转换**）
判定依据（三方 + 旁证 + 目视）：
1. 文件声明 `EPSG:4490`（≈WGS84）
2. 后端要求 WGS84 —— `server/index.js`：告警坐标即 **WGS-84（OSD GPS）**，`reverseGeocode(lon,lat)` **直接用原值**
3. 跨源旁证：`coll_map_points`(GCJ-02) − `collected`(政府 API) = `(+0.004359, −0.002155)`，
   与标准 GCJ 偏移 `(+0.004591, −0.002265)` 吻合到 ~20 m ⇒ 政府 API 是 WGS84、手工点录是 GCJ-02；
   而本文件的「周家坝」标注点与政府 API 点仅差 **141 m**（若本文件是 GCJ-02 应约 500 m）
4. ✅ **2026-09-30 人工目视确认：边界与实际乡镇界线完全吻合** → CRS 定案

（若将来换成 GCJ-02 来源的数据，加 `--assume-gcj` 转换。）

## 验收结果（2026-09-30）
- 后端启动日志：「已从 geojson seed 52 个乡镇/街道」+「已加载 52 个乡镇/街道（支持后台热更新）」
- `area_boundary` 表 52 行；原先每次上报刷的 `[straw-workflow] ENOENT` **归零**
- `/api/straw/reverse-geocode`：4 个已知点位 **4/4 命中**（周家坝→周家坝街道、百安坝→百安坝街道、熊家→熊家镇、九池→九池乡）；界外点（重庆解放碑）返回 `null`

## 备注
- `division_code` 保留下的是**源系统的 18 位编号**（`500101121` + `0000000` + `01..52`），**不是 GB/T 2260 的 9 位区划代码**。
  `area_responsibility` 以 **town 名称**为键，故不影响归属；如需真区划代码需另行补。
- 参考：`.workbuddy/memory/REF_驾驶舱重新部署流程.md` §13 ｜ 技能 `admin-boundary-geojson-onboarding`
