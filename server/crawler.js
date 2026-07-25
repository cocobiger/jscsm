'use strict'
/**
 * 网页爬虫采集服务
 * 依据文档 1.3 节实现：模拟HTTP请求 + HTML静态页面解析 + 表格文本提取
 *
 * 使用 Node 18+ 内置 fetch + cheerio 解析（替代 Java 的 HttpClient + Jsoup）。
 * 配置驱动：目标 URL、是否启用真实请求均可配置，默认不自动真实请求外部站点。
 */

let cheerio = null
try { cheerio = require('cheerio') } catch { /* 未安装时降级 */ }

// 污染物国标阈值库（用于反向匹配 standardValue）
const POLLUTANT_STANDARD = {
  PM25: { name: '细颗粒物', unit: 'μg/m³', standard: 75 },
  PM10: { name: '可吸入颗粒物', unit: 'μg/m³', standard: 70 },
  SO2: { name: '二氧化硫', unit: 'μg/m³', standard: 150 },
  NO2: { name: '二氧化氮', unit: 'μg/m³', standard: 80 },
  O3: { name: '臭氧', unit: 'μg/m³', standard: 160 },
  CO: { name: '一氧化碳', unit: 'mg/m³', standard: 4 },
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

// 熔断状态（内存）：{ [url]: { failCount, openUntil } }
const breaker = {}

function isBreakerOpen(url) {
  const b = breaker[url]
  return b && b.openUntil && Date.now() < b.openUntil
}
function recordFail(url) {
  const b = breaker[url] || { failCount: 0, openUntil: 0 }
  b.failCount += 1
  if (b.failCount >= 5) { // 连续失败5次才熔断，避免网络抖动误触发
    b.openUntil = Date.now() + 10 * 60 * 1000
  }
  breaker[url] = b
}
function recordSuccess(url) { breaker[url] = { failCount: 0, openUntil: 0 } }

/**
 * 步骤1：构建模拟浏览器请求，获取网页源码
 */
async function fetchHtml(url, timeout = 10000, retries = 2) {
  if (typeof fetch !== 'function') throw new Error('当前 Node 版本不支持全局 fetch，请升级到 Node 18+')
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController()
      const tid = setTimeout(() => controller.abort(), timeout)
      const resp = await fetch(url, { headers: BROWSER_HEADERS, signal: controller.signal })
      clearTimeout(tid)
      if (resp.status === 404) throw new Error('网页 404')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const buf = await resp.arrayBuffer()
      // 步骤：强制 UTF-8 解码
      return new TextDecoder('utf-8').decode(buf)
    } catch (e) {
      lastErr = e
      if (attempt < retries) await new Promise(r => setTimeout(r, 3000)) // 间隔3s重试
    }
  }
  throw lastErr
}

/**
 * 获取 JSON 接口数据（用于 getThirtySixHourAQI 这类动态接口）
 */
async function fetchJson(url, opts = {}) {
  if (typeof fetch !== 'function') throw new Error('当前 Node 版本不支持全局 fetch，请升级到 Node 18+')
  const { timeout = 10000, retries = 2, method = 'GET', body = null } = opts
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController()
      const tid = setTimeout(() => controller.abort(), timeout)
      const init = { method, headers: { ...BROWSER_HEADERS, 'Accept': 'application/json,*/*' }, signal: controller.signal }
      if (body && method !== 'GET') {
        if (typeof body === 'string' && body.includes('=')) {
          // form-urlencoded
          init.headers['Content-Type'] = 'application/x-www-form-urlencoded'
          init.body = body
        } else {
          init.headers['Content-Type'] = 'application/json'
          init.body = typeof body === 'string' ? body : JSON.stringify(body)
        }
      }
      const resp = await fetch(url, init)
      clearTimeout(tid)
      if (resp.status === 404) throw new Error('接口 404')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const text = await resp.text()
      try { return JSON.parse(text) } catch { throw new Error('返回内容非 JSON') }
    } catch (e) {
      lastErr = e
      if (attempt < retries) await new Promise(r => setTimeout(r, 3000))
    }
  }
  throw lastErr
}

// 区县编码 → 名称（重庆主城及万州，可按需扩展）
const REGION_NAMES = {
  '500101': '万州区', '500102': '涪陵区', '500103': '渝中区', '500104': '大渡口区',
  '500105': '江北区', '500106': '沙坪坝区', '500107': '九龙坡区', '500108': '南岸区',
  '500109': '北碚区', '500110': '綦江区', '500111': '大足区', '500112': '渝北区',
  '500113': '巴南区', '500114': '黔江区', '500115': '长寿区', '500116': '江津区',
  '500117': '合川区', '500118': '永川区', '500119': '南川区',
}

/**
 * 将 getThirtySixHourAQI 单条记录映射为系统标准结构
 * 接口字段：aqi/pm25/pm10/so2/no2/o3/co/monitortime/regioncode/longitude/latitude/pointname
 */
function mapApiRecord(r) {
  const num = v => { const n = Number(v); return isNaN(n) ? null : n }
  const POLL_FIELDS = [
    ['pm25', 'PM25'], ['pm10', 'PM10'], ['so2', 'SO2'],
    ['no2', 'NO2'], ['o3', 'O3'], ['co', 'CO'],
  ]
  const pollutants = []
  for (const [field, code] of POLL_FIELDS) {
    const v = num(r[field])
    if (v == null) continue
    const std = POLLUTANT_STANDARD[code]
    pollutants.push({
      code, name: std ? std.name : code, value: v,
      unit: std ? std.unit : 'μg/m³',
      standardValue: std ? std.standard : null,
      status: std && v > std.standard ? 2 : 1,
    })
  }
  const region = REGION_NAMES[r.regioncode] || ''
  const pointName = (r.pointname || r.positionname || r.stationname || region || r.regioncode || '未知站点').trim()
  const pointCode = (r.regioncode ? `cq_${r.regioncode}` : pointName).replace(/\s/g, '').toLowerCase()
  // 统一时间格式 yyyy-MM-dd HH:mm:ss
  let monitorTime = (r.monitortime || '').trim()
  const m = monitorTime.match(/(\d{4})[-\/](\d{2})[-\/](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (m) monitorTime = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`
  return {
    deviceId: `cq_api_${pointCode}`,
    pointCode,
    pointName: region && !pointName.includes(region) ? `${region} ${pointName}` : pointName,
    monitorTime,
    aqi: num(r.aqi),
    lat: num(r.latitude), lon: num(r.longitude),
    pollutants,
    deviceStatus: num(r.aqi) != null ? 1 : 0,
    sourceType: 'cq_api',
  }
}

/**
 * 调用 getThirtySixHourAQI 接口并返回标准化数据（按时间升序，便于历史窗口判断）
 * 36小时接口每个站点含多个时间点，全部返回，由编排层取最新一条入库 + 历史窗口判断。
 */
async function crawlApi(opts = {}) {
  const url = opts.url
  if (isBreakerOpen(url)) {
    return { ok: false, error: '熔断中（连续失败），10分钟内暂停采集', breaker: true, data: [] }
  }
  try {
    const json = await fetchJson(url, { timeout: opts.timeout || 10000, retries: opts.retries ?? 2, method: opts.method || 'POST', body: opts.body || null })
    // 兼容多种外层包裹：ThirtySixHourAQI / data / list / 直接数组
    const arr = json.ThirtySixHourAQI || json.data || json.list || (Array.isArray(json) ? json : null)
    if (!Array.isArray(arr)) {
      recordFail(url)
      return { ok: false, error: '接口返回结构不符（未找到数据数组）', raw: JSON.stringify(json).slice(0, 300), data: [] }
    }
    let data = arr.map(mapApiRecord).filter(d => d.pollutants.length > 0)
    // 点位过滤
    if (Array.isArray(opts.pointFilter) && opts.pointFilter.length) {
      data = data.filter(d => opts.pointFilter.some(f => d.pointName.includes(f) || d.pointCode.includes(f)))
    }
    recordSuccess(url)
    return { ok: true, count: data.length, data }
  } catch (e) {
    recordFail(url)
    return { ok: false, error: e.message || String(e), data: [] }
  }
}

/**
 * 步骤2+3：解析网页全局信息 + 表格站点数据
 * 默认按四列表格（区县/站点/AQI/首要污染物）解析。
 * 选择器可通过 selectors 配置覆盖，适配页面改版。
 */
function parseHtml(html, selectors = {}) {
  if (!cheerio) throw new Error('cheerio 未安装，请在 server/ 执行 npm install cheerio')
  const $ = cheerio.load(html)

  // 全局更新时间：尝试常见容器，无则用当前整点
  const timeSel = selectors.updateTime || '.update-time, .updateTime, #updateTime, .time, .date'
  let monitorTime = $(timeSel).first().text().trim()
  let m = monitorTime.match(/(\d{4})[-\/](\d{2})[-\/](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) {
    // 兜底：在整页文本里搜一个时间戳
    m = $('body').text().match(/(\d{4})[-\/](\d{2})[-\/](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/)
  }
  if (m) {
    monitorTime = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`
  } else {
    const d = new Date()
    const pad = n => String(n).padStart(2, '0')
    monitorTime = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00:00`
  }

  const rows = []
  const pushRow = cells => {
    if (cells.length >= 4) rows.push({ area: cells[0], pointName: cells[1], aqi: cells[2], primaryPollutant: cells[3] })
    else if (cells.length === 3) rows.push({ area: '', pointName: cells[0], aqi: cells[1], primaryPollutant: cells[2] })
  }

  // 策略1：自定义/标准 table 行（含无 tbody 的情况）
  const rowSel = selectors.row || 'table tr'
  $(rowSel).each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get()
    if (cells.length) pushRow(cells)
  })

  // 策略2：div 网格布局（table 无结果时尝试）
  if (rows.length === 0 && selectors.gridRow) {
    $(selectors.gridRow).each((_, el) => {
      const cells = $(el).find(selectors.gridCell || '> *').map((__, c) => $(c).text().trim()).get()
      if (cells.length) pushRow(cells)
    })
  }

  return { monitorTime, rows }
}

/**
 * 步骤4：数据映射与标准化转换
 */
function standardize(row, monitorTime) {
  // "-" 统一视为无污染物/数据正常
  const dash = v => v === '-' || v === '—' || v === '' || v == null
  const aqiRaw = dash(row.aqi) ? null : Number(String(row.aqi).replace(/[^\d.]/g, ''))
  const primary = dash(row.primaryPollutant) ? null : row.primaryPollutant

  // 首要污染物代码归一
  let code = null
  if (primary) {
    const p = primary.replace(/\s/g, '').toUpperCase()
    if (p.includes('PM2.5') || p.includes('PM₂.₅') || p.includes('PM25')) code = 'PM25'
    else if (p.includes('PM10') || p.includes('PM₁₀')) code = 'PM10'
    else if (p.includes('SO')) code = 'SO2'
    else if (p.includes('NO')) code = 'NO2'
    else if (p.includes('O3') || p.includes('O₃')) code = 'O3'
    else if (p.includes('CO')) code = 'CO'
  }

  const pollutants = []
  if (code && aqiRaw != null) {
    const std = POLLUTANT_STANDARD[code]
    pollutants.push({
      code,
      name: std ? std.name : code,
      value: aqiRaw, // 网页仅给 AQI 与首要污染物，以 AQI 近似首要污染物浓度
      unit: std ? std.unit : 'μg/m³',
      standardValue: std ? std.standard : null,
      status: std && aqiRaw > std.standard ? 2 : 1,
    })
  }

  const pointCode = `${row.area || ''}_${row.pointName || ''}`.replace(/\s/g, '').toLowerCase() || 'unknown'
  return {
    deviceId: `html_crawl_${pointCode}`,
    pointCode,
    pointName: `${row.area || ''} ${row.pointName || ''}`.trim(),
    monitorTime,
    aqi: aqiRaw,
    pollutants,
    deviceStatus: aqiRaw != null ? 1 : 0,
    sourceType: 'html_crawl',
  }
}

/**
 * 主入口：爬取并返回标准化数据列表
 * @param {object} opts { url, timeout, retries, selectors, pointFilter }
 *   pointFilter: 仅保留指定区县/站点（数组，匹配 area 或 pointName 包含），空则全部
 * @returns {Promise<{ ok, monitorTime, data, error }>}
 */
async function crawl(opts = {}) {
  const url = opts.url || 'https://hbyw.sthjj.cq.gov.cn/shouye/template/aqiHour.html'
  // JSON 接口模式：显式 mode='api' 或 URL 看起来像接口
  const looksLikeApi = opts.mode === 'api' || /\.(json)(\?|$)|\/api\/|get[A-Z]|aqi.*hour|hour.*aqi/i.test(url)
  if (looksLikeApi) return crawlApi(opts)
  if (isBreakerOpen(url)) {
    return { ok: false, error: '熔断中（连续失败），10分钟内暂停爬取', breaker: true, data: [] }
  }
  try {
    const html = await fetchHtml(url, opts.timeout || 10000, opts.retries ?? 2)
    if (!html || html.trim().length === 0) {
      return { ok: false, error: '网页源码为空，判定数据源无更新', data: [] }
    }
    const { monitorTime, rows } = parseHtml(html, opts.selectors || {})
    if (rows.length === 0) {
      recordFail(url)
      return { ok: false, error: '表格解析失败/DOM节点缺失，疑似网页结构变更', rawLen: html.length, data: [] }
    }
    let data = rows.map(r => standardize(r, monitorTime))
    // 点位过滤（如仅万州区周家坝/百安坝）
    if (Array.isArray(opts.pointFilter) && opts.pointFilter.length) {
      data = data.filter(d => opts.pointFilter.some(f => d.pointName.includes(f)))
    }
    recordSuccess(url)
    return { ok: true, monitorTime, data }
  } catch (e) {
    recordFail(url)
    return { ok: false, error: e.message || String(e), data: [] }
  }
}

/**
 * 诊断：抓取页面并返回结构信息，用于定位选择器（不解析业务数据）
 */
async function diagnose(opts = {}) {
  const url = opts.url || 'https://hbyw.sthjj.cq.gov.cn/shouye/template/aqiHour.html'
  try {
    const html = await fetchHtml(url, opts.timeout || 10000, 0)
    const info = { ok: true, htmlLength: html.length }
    if (cheerio) {
      const $ = cheerio.load(html)
      info.tableCount = $('table').length
      info.trCount = $('table tr').length
      info.tbodyCount = $('table tbody').length
      // 列出前几个 table 的首行单元格，帮助判断列结构
      info.tableSamples = $('table').slice(0, 3).map((i, t) => {
        const firstRow = $(t).find('tr').first()
        return {
          index: i,
          cols: firstRow.find('th,td').map((_, c) => $(c).text().trim()).get(),
          rowCount: $(t).find('tr').length,
        }
      }).get()
      // 是否疑似 JS 动态渲染（body 文本极少）
      info.bodyTextLength = $('body').text().replace(/\s+/g, '').length
      info.likelyDynamic = info.tableCount === 0 && info.bodyTextLength < 200

      // 探测非 table 容器：找含已知站点/区县关键词的元素，回溯其父结构
      const KEYWORDS = ['周家坝', '百安坝', '万州', '渝中', '江北', 'AQI', '首要污染物']
      const hits = []
      $('*').each((_, el) => {
        if (hits.length >= 8) return false
        const $el = $(el)
        // 只看直接文本，避免大容器命中
        const own = $el.clone().children().remove().end().text().trim()
        if (own && KEYWORDS.some(k => own.includes(k)) && own.length < 30) {
          hits.push({
            tag: el.tagName,
            class: ($el.attr('class') || '').slice(0, 60),
            text: own.slice(0, 30),
            parentTag: el.parent && el.parent.tagName,
            parentClass: (($el.parent().attr('class')) || '').slice(0, 60),
          })
        }
      })
      info.keywordHits = hits

      // 列出 body 下层级较高的容器标签+class，了解整体骨架
      info.topContainers = $('body > *, body > * > *').slice(0, 15).map((_, el) => ({
        tag: el.tagName, class: ($(el).attr('class') || '').slice(0, 50),
      })).get()

      // 常见数据容器计数
      info.divCount = $('div').length
      info.ulCount = $('ul').length
      info.liCount = $('li').length
    } else {
      info.warning = 'cheerio 未安装，仅返回 HTML 长度'
    }
    // 截取 HTML 头部片段供人工查看
    info.htmlHead = html.slice(0, 2000)
    return info
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}

module.exports = { crawl, crawlApi, fetchJson, mapApiRecord, parseHtml, standardize, fetchHtml, diagnose, REGION_NAMES, POLLUTANT_STANDARD, breaker }
