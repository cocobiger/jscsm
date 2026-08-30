// 局域网静态文件服务器：将 outputs/ 目录发布到局域网
// 监听 0.0.0.0:8080，供局域网其他电脑访问方案文档
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = 'E:/CC work/CC jsc/outputs';
const PORT = 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.md': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  try { p = decodeURIComponent(p); } catch (e) {}
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(ROOT, p));
  // 防目录穿越
  if (!fp.startsWith(path.normalize(ROOT))) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + p);
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`LAN file server running: http://0.0.0.0:${PORT} (root: ${ROOT})`);
});
