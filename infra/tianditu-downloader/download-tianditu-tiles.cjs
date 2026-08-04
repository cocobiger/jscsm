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
const TMAP_KEY    = process.argv[2] || process.env.TMAP_KEY || '0b1c7dc07167064978ace71a3bd5914b';
const CENTER_LAT  = 30.807694;   // Wanzhou, Chongqing (WGS-84)
const CENTER_LNG  = 108.396809;
const ZOOM_MIN    = 10;
const ZOOM_MAX    = 16;
const RADIUS_KM   = 8; // 8km radius

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

// ── Download single tile ────────────────────────────────────────────────────
function downloadTile(layerId, z, x, y, url) {
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
      // 天地图 403 = Key 无效 or 超过额度
      if (res.statusCode !== 200) {
        res.resume();
        if (res.statusCode === 403) {
          console.error(`  [ERROR] TMAP Key invalid or quota exceeded (403)`);
        }
        resolve(false);
        return;
      }

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
      ws.on('error', () => { fs.unlinkSync(file); resolve(false); });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Sleep helper (be polite to TMAP servers) ──────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const start = Date.now();
  console.log('\n🗺  Tianditu WGS-84 Tile Downloader');
  console.log(`   Center: Wanzhou (${CENTER_LAT}, ${CENTER_LNG})`);
  console.log(`   Zoom: ${ZOOM_MIN}-${ZOOM_MAX}, Radius: ${RADIUS_KM}km`);
  console.log(`   Key: ${TMAP_KEY.substring(0, 8)}...\n`);

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

      // Concurrent limit: 4 at a time (be polite to TMAP)
      const CHUNK = 4;
      let zOk = 0;
      for (let i = 0; i < tasks.length; i += CHUNK) {
        const batch = tasks.slice(i, i + CHUNK);
        const urls  = batch.map(t => layer.tileUrl(t.z, t.x, t.y));
        const results = await Promise.all(batch.map((t, i) => downloadTile(layer.id, t.z, t.x, t.y, urls[i])));
        zOk  += results.filter(Boolean).length;
        layerOk += results.filter(Boolean).length;
        // Polite delay
        if (i + CHUNK < tasks.length) await sleep(200);
      }

      console.log(`  zoom ${z}: ${tasks.length} tiles, ${zOk} ok`);
    }

    console.log(`  [${layer.name}] total: ${layerOk}/${layerTotal} tiles`);
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
