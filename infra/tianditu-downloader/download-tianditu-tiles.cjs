/**
 * 天地图 (Tianditu) WGS-84 tile downloader
 * 国家测绘局官方 WGS-84 瓦片，国内访问稳定
 * 使用服务器端 API Key（不受浏览器域名限制）
 *
 * 输出目录：backend/src/tiles/tianditu/{z}/{x}/{y}.png
 *
 * Usage: node download-tianditu-tiles.js [KEY]
 *   or set env: TMAP_KEY=your_key node download-tianditu-tiles.js
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ───────────────────────────────────────────────────────────────────
// 多 Key 轮换池：按用户给定顺序排列，每条额度用完（429 熔断）自动切换下一个，
// 全部 Key 都触发限流才退出本轮。argv[2]/env 提供的 Key 优先进池（去重）。
const KEY_POOL = [
  '9d1db3cee7ef547b0b1f4a3edeacd333',
  '28c06e40850a4aaca2ac1cc5210b3d78',
  'f5dfa42b19f9a3869fa2e082c7b6370f',
  'dcd638fbb164fda5a56808a34753d55c',
];
const KEYS = (() => {
  const extra = process.argv[2] || process.env.TMAP_KEY;
  const list = extra && !KEY_POOL.includes(extra) ? [extra] : [];
  return list.concat(KEY_POOL);
})();
let keyIndex = 0;          // 当前使用第几个 Key
let TMAP_KEY   = KEYS[0];
const CENTER_LAT  = 30.807694;   // Wanzhou, Chongqing (WGS-84)
const CENTER_LNG  = 108.396809;
const ZOOM_MIN    = 10;
const ZOOM_MAX    = 16;
const RADIUS_KM   = 48; // 48km radius（2026-08-05 19:05 由 16km 扩大，覆盖万州全域及周边，进一步消除边缘空白）

// 天地图图层
// vec_w  = 矢量底图 (WGS-84), cva_w = 矢量标注 (WGS-84)
// img_w  = 影像底图 (WGS-84), cia_w = 影像标注 (WGS-84)
const LAYERS = [
  { id: 'vec_w', name: '矢量底图',  tileUrl: (z, x, y) => `https://t0.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${TMAP_KEY}` },
  { id: 'cva_w', name: '矢量注记', tileUrl: (z, x, y) => `https://t0.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${TMAP_KEY}` },
];

// ── Lat/Lng → Tile XY (WGS-84 / Web Mercator) ──────────────────────────
function latLngToTile(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

// ── Radius in tiles ─────────────────────────────────────────────────────────
function radiusInTiles(z) {
  const metersPerPixel = (156543.03392 * Math.cos(CENTER_LAT * Math.PI / 180)) / Math.pow(2, z);
  const tilesPerKm = 1000 / (metersPerPixel * 256);
  return Math.ceil(tilesPerKm * RADIUS_KM);
}

// ── Download single tile (一次尝试) ────────────────────────────────────────
// 429 快速熔断：连续 RATE_LIMIT_TRIGGER 次 429 立即终止整轮下载（Key 级限流，
// 继续重试只会空转浪费窗口；下次运行断点续传）
let consecutive429 = 0;
const RATE_LIMIT_TRIGGER = 3;
let rateLimited = false; // 置 true 后所有后续瓦片立即放弃
function downloadOnce(layerId, z, x, y, url) {
  if (rateLimited) return Promise.resolve(false);
  return new Promise((resolve) => {
    const dir  = path.join(__dirname, 'tianditu', layerId, String(z), String(x));
    const file = path.join(dir, `${y}.png`);

    if (fs.existsSync(file) && fs.statSync(file).size > 100) {
      resolve(true);
      return;
    }

    const req = https.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'GasTrace/1.0' },
    }, (res) => {
      // 天地图 403 = Key 无效 or 超过额度（重试无意义，直接失败）
      if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 403) {
          console.error(`  [ERROR] TMAP Key invalid or quota exceeded (403)`);
        }
        if (res.statusCode === 429) {
          consecutive429++;
          if (consecutive429 >= RATE_LIMIT_TRIGGER) {
            rateLimited = true;
            console.error(`  [RATE-LIMIT] ${RATE_LIMIT_TRIGGER}+ consecutive 429 on key ${TMAP_KEY.substring(0, 8)}… → switching/aborting`);
          }
        }
        resolve(false);
        return;
      }
      consecutive429 = 0;

      const ct = res.headers['content-type'] || '';
      if (!ct.includes('image')) {
        res.resume();
        resolve(false);
        return;
      }

      fs.mkdirSync(dir, { recursive: true });
      const ws = fs.createWriteStream(file);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(true); });
      ws.on('error', () => { try { fs.unlinkSync(file) } catch {} resolve(false); });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Key 轮换：当前 Key 熔断后切换到下一个，全部用完返回 false ──
function switchKey() {
  if (keyIndex + 1 >= KEYS.length) return false;
  keyIndex++;
  TMAP_KEY = KEYS[keyIndex];
  consecutive429 = 0;
  rateLimited = false;
  console.error(`  [KEY-SWITCH] → ${keyIndex + 1}/${KEYS.length}: ${TMAP_KEY.substring(0, 8)}…`);
  return true;
}

// ── Download single tile with retry (网络错误/超时重试, 退避 500ms/1.5s/3s) ──
async function downloadTile(layerId, z, x, y, url) {
  const maxTries = 4; // 首次 + 3 次重试
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    if (rateLimited) return false; // 已熔断：不再重试
    const ok = await downloadOnce(layerId, z, x, y, url);
    if (ok) return true;
    if (attempt < maxTries && !rateLimited) await sleep([500, 1500, 3000][attempt - 1] || 2000);
  }
  return false;
}

// ── Sleep helper (be polite to TMAP servers) ──────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const start = Date.now();
  console.log('\n🗺  Tianditu WGS-84 Tile Downloader');
  console.log(`   Center: Wanzhou (${CENTER_LAT}, ${CENTER_LNG})`);
  console.log(`   Zoom: ${ZOOM_MIN}-${ZOOM_MAX}, Radius: ${RADIUS_KM}km`);
  console.log(`   Key pool: ${KEYS.length} keys (${KEYS.map(k => k.substring(0, 8)).join(', ')})`);
  console.log(`   Start key: ${TMAP_KEY.substring(0, 8)}...\n`);

  for (const layer of LAYERS) {
    console.log(`\n📦 Layer: ${layer.name} (${layer.id})`);
    let layerTotal = 0, layerOk = 0;

    for (let z = ZOOM_MIN; z <= ZOOM_MAX; z++) {
      const { x: cx, y: cy } = latLngToTile(CENTER_LAT, CENTER_LNG, z);
      const half = radiusInTiles(z);

      const xMin = Math.max(0, cx - half);
      const xMax = cx + half;
      const yMin = Math.max(0, cy - half);
      const yMax = cy + half;

      const tasks = [];
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          tasks.push({ z, x, y });
          layerTotal++;
        }
      }

      // Concurrent limit: 6 at a time（48km 大范围下载，12 并发会触发限流导致大量失败；6 并发 + 150ms 平衡速度与成功率）
      const CHUNK = 6;
      let zOk = 0;
      let i = 0;
      while (i < tasks.length) {
        if (rateLimited) {
          // 当前 Key 熔断 → 切下一个 Key 后从断点继续（已存在瓦片自动跳过）
          if (!switchKey()) break; // 全部 Key 用完，退出本轮
          console.error(`  ⟳ Retrying from tile #${i} with ${TMAP_KEY.substring(0, 8)}…`);
          continue;
        }
        const batch = tasks.slice(i, i + CHUNK);
        const urls  = batch.map(t => layer.tileUrl(t.z, t.x, t.y));
        const results = await Promise.all(batch.map((t, idx) => downloadTile(layer.id, t.z, t.x, t.y, urls[idx])));
        zOk  += results.filter(Boolean).length;
        layerOk += results.filter(Boolean).length;
        i += CHUNK;
        // Polite delay
        if (i < tasks.length) await sleep(150);
      }

      console.log(`  zoom ${z}: ${tasks.length} tiles, ${zOk} ok`);
      if (rateLimited) {
        console.error(`  ⛔ All keys rate-limited (429) → aborting. Resume next run.`);
        break;
      }
    }

    console.log(`  [${layer.name}] total: ${layerOk}/${layerTotal} tiles`);
    if (rateLimited) break;
  }

  // Calculate total size
  let totalBytes = 0;
  const tdDir = path.join(__dirname, 'tianditu');
  if (fs.existsSync(tdDir)) {
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isDirectory()) walk(fp);
        else totalBytes += fs.statSync(fp).size;
      }
    };
    walk(tdDir);
  }

  console.log(`\n✅ Done! Total: ${(totalBytes / 1e6).toFixed(1)} MB`);
  console.log(`   Time: ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
})();
