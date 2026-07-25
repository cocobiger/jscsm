// 结案报告编排器：取模板 → 聚合数据 → 填充占位 → 调隔离渲染器出 PDF → 回写 history
// 版式完全由 DB 中的模板决定；本模块不包含任何版式逻辑。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store-db');

const RENDER_JS = path.join(__dirname, 'pdf', 'render.js');
const REPORTS_DIR = path.join(__dirname, 'data', 'reports');
const TMP_DIR = path.join(REPORTS_DIR, '.tmp');
const RENDER_TIMEOUT_MS = 60000;

// 模板变量替换 {{key}} / {{a.b}}；字符串/数字自动 HTML 转义（防XSS）
// 若值为 { __html: string } 对象则原样注入（用于预渲染表格等可信 HTML 片段）
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fillTemplate(html, data) {
  return html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
    if (v == null) return '';
    // 可信原始 HTML（预渲染表格等）——不转义直接注入
    if (typeof v === 'object' && v !== null && '__html' in v) return v.__html;
    return escapeHtml(v);
  });
}

// 预览用样例数据（与 getClosureReportData 同结构）
const SAMPLE_DATA = {
  reportNo: 'JSC-CLOSE-SAMPLE0001',
  genDate: new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }),
  eventType: '堆头未覆盖',
  occurTime: '2026-07-11 14:32:05',
  location: 'XX区XX街道XX路XX号路口',
  lon: '119.123456', lat: '32.654321',
  level: '二级（较重）', value: '—', standard: '—',
  triggerCount: 5, eventCount: 5,
  platformName: '区城运中心', planName: '堆头未覆盖24小时推送规则',
  disposalResult: '现场堆头已清理完毕，路面恢复通畅；已通知属地网格员加强日常巡查，防止问题反复。',
  disposalOperator: '王建国（城运中心坐席）',
  closedAt: '2026-07-11 18:05:42',
  description: '路口堆放建筑垃圾，覆盖路面影响通行。',
  // AI 置信度统计（样例：5 张 AI 分析，最低 0.82 最高 0.95 平均 0.90）
  aiConfidenceMin: '0.82',
  aiConfidenceMax: '0.95',
  aiConfidenceAvg: '0.90',
  aiConfidenceCount: 5,
};

// 调隔离渲染器：写临时 HTML → spawn node pdf/render.js → 产出 PDF
function renderHtmlToPdf(html, pdfPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const tmpHtml = path.join(TMP_DIR, `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
    fs.writeFileSync(tmpHtml, html, 'utf8');
    const child = spawn(process.execPath, [RENDER_JS, tmpHtml, pdfPath], {
      env: { ...process.env, PATH: `/home/jsc/.nvm/versions/node/v22.22.3/bin:${process.env.PATH || ''}` },
    });
    let out = '';
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, RENDER_TIMEOUT_MS);
    child.on('error', err => { clearTimeout(timer); cleanup(tmpHtml); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      cleanup(tmpHtml);
      const lastLine = out.split('\n').map(s => s.trim()).filter(Boolean).pop();
      let parsed = null;
      try { parsed = lastLine ? JSON.parse(lastLine) : null; } catch {}
      if (code === 0 && parsed && parsed.ok) return resolve(parsed);
      reject(new Error((parsed && parsed.error) || `渲染器退出码 ${code}：${out.slice(-500)}`));
    });
  });
}
function cleanup(p) { try { fs.unlinkSync(p); } catch {} }

// 为指定推送记录生成结案报告 PDF（可指定模板，否则用默认模板）
async function generateClosureReport(historyId, templateId) {
  const data = store.getClosureReportData(historyId);
  if (!data) { const e = new Error('推送记录不存在'); e.code = 404; throw e; }
  const tpl = templateId ? store.getReportTemplate(templateId) : store.getDefaultReportTemplate();
  if (!tpl) { const e = new Error('未配置结案报告模板'); e.code = 400; throw e; }
  const html = fillTemplate(tpl.content, data);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const pdfPath = path.join(REPORTS_DIR, `${historyId}.pdf`);
  await renderHtmlToPdf(html, pdfPath);
  store.setHistoryReportPath(historyId, pdfPath);
  return { ok: true, path: pdfPath, generated_at: data.genDate, template_id: tpl.id };
}

// 预览：用样例数据渲染模板内容，返回临时 PDF 路径（调用方负责删除）
async function previewReport(content) {
  const html = fillTemplate(content, SAMPLE_DATA);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const pdfPath = path.join(TMP_DIR, `preview-${Date.now()}.pdf`);
  await renderHtmlToPdf(html, pdfPath);
  return pdfPath;
}

// ── 工作报表 PDF：聚合数据 → 预渲染 4 张表格 → 填模板 → 渲染 PDF ──
const WR_LABEL = { pushed: '已推送', processing: '受理中', closed: '已结案' };

// 由二维行数据生成表格 HTML（cols: [{label, num?}]）
function buildGridTable(rows, cols) {
  const head = '<tr>' + cols.map(c => `<th>${escapeHtml(c.label)}</th>`).join('') + '</tr>';
  const body = rows.map(r =>
    '<tr>' + cols.map((c, i) => `<td${c.num ? ' class="num"' : ''}>${escapeHtml(r[i])}</td>`).join('') + '</tr>'
  ).join('');
  return `<table class="grid">${head}${body}</table>`;
}

// 生成工作报表 PDF（可指定 kind='workreport' 模板，否则用默认工作报表模板）
// contentOverride：直接传入 HTML（如区块编辑器实时合成），跳过取模板，便于编辑器"预览当前所见"
async function generateWorkReport(params, templateId, contentOverride) {
  const data = store.getWorkReportData(params || {});
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' });
  const byTypeTable = buildGridTable(
    data.summary.byType.map(r => [r.event_type, r.count]),
    [{ label: '事件类型' }, { label: '推送数', num: true }]
  );
  const byStatusTable = buildGridTable(
    data.summary.byStatus.map(r => [r.label, r.count]),
    [{ label: '处置状态' }, { label: '推送数', num: true }]
  );
  const trendTable = buildGridTable(
    data.trend.map(r => [r.bucket, r.count]),
    [{ label: '时间段' }, { label: '推送数', num: true }]
  );
  const recordsTable = buildGridTable(
    data.records.map(r => [
      r.created_at, r.event_type, r.location, r.platform_name,
      WR_LABEL[r.status] || r.status, r.trigger_count, r.closed_at || '—',
      r.hasReport ? '已生成' : '未生成',
    ]),
    [
      { label: '推送时间' }, { label: '事件类型' }, { label: '地点' }, { label: '平台' },
      { label: '状态' }, { label: '触发次数', num: true }, { label: '结案时间' }, { label: '结案报告' },
    ]
  );
  const vars = {
    periodLabel: data.period.label,
    reportTitle: '智慧治理推送处置工作报表',
    unitName: '万州区生态环保局',
    genDate: now,
    totalCount: data.summary.total,
    closedCount: data.summary.closed,
    processingCount: data.summary.processing,
    pushedCount: data.summary.pushed,
    // 预渲染表格为可信 HTML，用 {__html} 包装跳过 fillTemplate 转义
    byTypeTable: { __html: byTypeTable },
    byStatusTable: { __html: byStatusTable },
    trendTable: { __html: trendTable },
    recordsTable: { __html: recordsTable },
  };
  const tpl = templateId ? store.getReportTemplate(templateId) : store.getDefaultReportTemplate('workreport');
  if (!contentOverride && !tpl) { const e = new Error('未配置工作报表模板'); e.code = 400; throw e; }
  const html = fillTemplate(contentOverride || (tpl && tpl.content), vars);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = now.replace(/[^0-9]/g, '').slice(0, 14);
  const periodSlug = (data.period.label || 'report').replace(/[^\w一-龥]/g, '_');
  const pdfPath = path.join(REPORTS_DIR, `workreport-${periodSlug}-${ts}.pdf`);
  await renderHtmlToPdf(html, pdfPath);
  return { ok: true, path: pdfPath, generated_at: now, template_id: tpl.id, period: data.period };
}

module.exports = { fillTemplate, renderHtmlToPdf, generateClosureReport, previewReport, generateWorkReport, SAMPLE_DATA, REPORTS_DIR };
