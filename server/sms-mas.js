'use strict'
/**
 * 重庆移动云MAS 短信接口封装
 * 文档：中国移动云MAS平台 HTTP 接口规范（普通短信提交 normsubmit）
 *
 * 提交流程：
 *   1. 组装 JSON：{ ecName, apId, secretKey, mobiles, content, sign, addSerial, mac }
 *   2. mac = md5(ecName + apId + secretKey + mobiles + content + sign + addSerial)
 *      （注意：secretKey 参与签名计算，但部分平台要求 secretKey 字段本身留空提交，
 *       这里通过 keepSecretInBody 选项兼容两种模式，默认保留以适配多数省份网关）
 *   3. 整个 JSON 做 Base64 编码后作为 HTTP body POST 到 normsubmit 接口
 *   4. 返回 JSON：{ rspcod, success, msgGroup } —— rspcod='success' 视为成功
 *
 * 配置（masUrl/ecName/apId/secretKey/sign/addSerial）存于 data/config.json，可热更新。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// 默认指向普通短信提交接口；不同省份网关地址不同，需在系统设置中填写
let cfg = {
  masUrl: 'http://112.35.1.155:1992/sms/norsubmit', // 普通短信提交地址（示例，需按实际网关替换）
  tmpUrl: '',      // 模板短信提交地址；留空则自动由 masUrl 把 norsubmit 替换为 tmpsubmit
  ecName: '',      // 集团名称
  apId: '',        // 接口账号
  secretKey: '',   // 接口密码
  sign: '',        // 签名编码（在 MAS 平台申请，如 zHsmzt）
  addSerial: '',   // 拓展码，可空
  keepSecretInBody: true, // 提交 body 中是否保留 secretKey（按网关要求调整）
  retryCount: 2,   // 网络类失败自动重试次数（业务拒绝不重试）
  retryDelayMs: 1500, // 重试间隔（毫秒）
}
let configFile = null
let log = { info() {}, warn() {}, error() {}, debug() {} }

const CFG_KEYS = ['masUrl', 'tmpUrl', 'ecName', 'apId', 'secretKey', 'sign', 'addSerial', 'keepSecretInBody', 'retryCount', 'retryDelayMs']

function init(dataDir, logger) {
  if (logger) log = logger
  configFile = path.join(dataDir, 'config.json')
  try {
    const c = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    if (c.sms && typeof c.sms === 'object') {
      for (const k of CFG_KEYS) if (c.sms[k] !== undefined) cfg[k] = c.sms[k]
    }
  } catch {}
  return getConfig()
}

// 对外暴露的配置（隐藏 secretKey 明文，仅返回是否已配置）
function getConfig() {
  return {
    masUrl: cfg.masUrl,
    tmpUrl: cfg.tmpUrl || tmpSubmitUrl(),
    ecName: cfg.ecName,
    apId: cfg.apId,
    sign: cfg.sign,
    addSerial: cfg.addSerial,
    keepSecretInBody: cfg.keepSecretInBody,
    retryCount: cfg.retryCount,
    retryDelayMs: cfg.retryDelayMs,
    configured: !!(cfg.ecName && cfg.apId && cfg.secretKey && cfg.sign),
  }
}

// 模板短信地址：优先用显式配置的 tmpUrl，否则把 norsubmit 替换为 tmpsubmit
function tmpSubmitUrl() {
  if (cfg.tmpUrl) return cfg.tmpUrl
  return (cfg.masUrl || '').replace(/norsubmit\b/, 'tmpsubmit')
}

// 更新配置并持久化到 config.json 的 sms 字段（保留 apiKey/zlm 等其它字段）
function setConfig(patch = {}) {
  let full = {}
  try { full = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch {}
  if (!full.sms || typeof full.sms !== 'object') full.sms = {}
  for (const k of CFG_KEYS) {
    if (patch[k] !== undefined) {
      // secretKey 为空字符串时视为"不修改"，避免误清空已配置的密钥
      if (k === 'secretKey' && (patch[k] === '' || patch[k] == null)) continue
      cfg[k] = patch[k]
      full.sms[k] = patch[k]
    }
  }
  try {
    const tmp = configFile + '.tmp.' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(full, null, 2))
    fs.renameSync(tmp, configFile)
  } catch (e) { log.error('保存短信配置失败: ' + e.message) }
  return getConfig()
}

function md5Hex(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}

/**
 * 模板变量替换：把 {key} 替换为 vars[key]
 * @param {string} template 含 {站点}{污染物}{数值}{时间} 等占位符的模板
 * @param {object} vars 变量映射
 */
function renderTemplate(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) => {
    return vars[key] != null ? String(vars[key]) : m
  })
}

/**
 * 发送短信
 * @param {string|string[]} mobiles 手机号（单个或数组）
 * @param {string} content 短信正文（不含签名，签名由平台拼接）
 * @param {object} opts { timeout }
 * @returns {Promise<{ok:boolean, raw:any, error?:string}>}
 */
async function sendSms(mobiles, content, opts = {}) {
  if (typeof fetch !== 'function') throw new Error('Node 不支持 fetch，请用 Node 18+')
  if (!cfg.ecName || !cfg.apId || !cfg.secretKey || !cfg.sign) {
    throw new Error('云MAS 短信未配置完整，请先在系统设置中填写 ecName/apId/secretKey/sign')
  }
  const mobileStr = Array.isArray(mobiles) ? mobiles.join(',') : String(mobiles)
  if (!mobileStr) throw new Error('收信手机号为空')
  if (!content) throw new Error('短信内容为空')

  const addSerial = cfg.addSerial || ''
  // mac 签名：ecName+apId+secretKey+mobiles+content+sign+addSerial（无间隔符，32位小写MD5）
  const mac = md5Hex(cfg.ecName + cfg.apId + cfg.secretKey + mobileStr + content + cfg.sign + addSerial)

  const payload = {
    ecName: cfg.ecName,
    apId: cfg.apId,
    secretKey: cfg.keepSecretInBody ? cfg.secretKey : '',
    mobiles: mobileStr,
    content,
    sign: cfg.sign,
    addSerial,
    mac,
  }
  return postWithRetry(cfg.masUrl, payload, opts)
}

/**
 * 发送模板短信（tmpsubmit）
 * @param {string|string[]} mobiles 手机号
 * @param {string} templateId 平台审核通过的模板ID
 * @param {string[]} params 模板变量数组，无变量传 []
 * @param {object} opts { timeout }
 * @returns {Promise<{ok:boolean, raw:any, error?:string}>}
 */
async function sendTemplateSms(mobiles, templateId, params = [], opts = {}) {
  if (typeof fetch !== 'function') throw new Error('Node 不支持 fetch，请用 Node 18+')
  if (!cfg.ecName || !cfg.apId || !cfg.secretKey || !cfg.sign) {
    throw new Error('云MAS 短信未配置完整，请先在系统设置中填写 ecName/apId/secretKey/sign')
  }
  if (!templateId) throw new Error('缺少模板ID（templateId）')
  const mobileStr = Array.isArray(mobiles) ? mobiles.join(',') : String(mobiles)
  if (!mobileStr) throw new Error('收信手机号为空')

  const addSerial = cfg.addSerial || ''
  const arr = Array.isArray(params) ? params : []
  // params 在 JSON body 中需转义引号（JSON.stringify 自动处理）；
  // 但在 mac 计算串里引号【不转义】，即用紧凑 JSON 形式 ["a","b"]
  const paramsForMac = JSON.stringify(arr)            // 形如 ["abcde"]，引号不转义
  const paramsForBody = JSON.stringify(arr)           // body 字段值本身就是这个字符串
  // mac：ecName+apId+secretKey+templateId+mobiles+params+sign+addSerial
  const mac = md5Hex(cfg.ecName + cfg.apId + cfg.secretKey + templateId + mobileStr + paramsForMac + cfg.sign + addSerial)

  const payload = {
    ecName: cfg.ecName,
    apId: cfg.apId,
    secretKey: cfg.keepSecretInBody ? cfg.secretKey : '',
    templateId,
    mobiles: mobileStr,
    params: paramsForBody,   // 平台要求 params 为字符串化的数组
    sign: cfg.sign,
    addSerial,
    mac,
  }
  return postWithRetry(tmpSubmitUrl(), payload, opts)
}

// 业务拒绝码：这些是平台明确拒绝，重试无意义
const NON_RETRYABLE = new Set([
  'IllegalMac', 'IllegalSignId', 'InvalidMessage', 'InvalidUsrOrPwd',
  'NoSignId', 'TooManyMobiles', 'NOT_WHITE_IP',
])

/**
 * 提交 Base64(JSON) 到指定网关，带网络类失败自动重试。
 * 平台业务拒绝（NON_RETRYABLE）立即返回不重试。
 */
async function postWithRetry(url, payload, opts = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  const timeout = opts.timeout || 10000
  const maxRetry = opts.retryCount != null ? opts.retryCount : (cfg.retryCount || 0)
  const delay = opts.retryDelayMs != null ? opts.retryDelayMs : (cfg.retryDelayMs || 1500)

  let attempt = 0
  let lastResult = { ok: false, error: '未执行' }
  while (attempt <= maxRetry) {
    attempt++
    const r = await postOnce(url, body, timeout)
    lastResult = { ...r, attempts: attempt }
    if (r.ok) return lastResult
    // 平台业务拒绝 → 不重试
    const code = r.raw && r.raw.rspcod
    if (code && NON_RETRYABLE.has(code)) {
      log.warn(`短信被平台拒绝(${code})，不重试`)
      return lastResult
    }
    // 网络类失败 / 未知错误 → 重试
    if (attempt <= maxRetry) {
      log.warn(`短信提交失败(${r.error})，${delay}ms 后第 ${attempt} 次重试`)
      await sleep(delay)
    }
  }
  return lastResult
}

// 单次提交
async function postOnce(url, body, timeout) {
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), timeout)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body,
      signal: ctrl.signal,
    })
    clearTimeout(tid)
    const text = await resp.text()
    let json
    try { json = JSON.parse(text) } catch { json = { rawText: text } }
    if (!resp.ok) return { ok: false, raw: json, error: `MAS HTTP ${resp.status}`, networkError: true }
    const success = json.success === true || json.success === 'true' ||
                    json.rspcod === 'success' || json.rspcod === '0000'
    return { ok: !!success, raw: json, error: success ? undefined : (json.rspcod || json.msg || '平台拒绝，详见 raw') }
  } catch (e) {
    clearTimeout(tid)
    return { ok: false, raw: null, error: e.name === 'AbortError' ? 'MAS 请求超时' : (e.message || String(e)), networkError: true }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/**
 * 连通性测试：用最小化参数尝试一次签名计算（不实际发送），
 * 仅校验配置完整性与网关可达性（HEAD/GET 探测）。
 */
async function testConnect(opts = {}) {
  if (!cfg.ecName || !cfg.apId || !cfg.secretKey || !cfg.sign) {
    return { ok: false, error: '配置不完整：需要 ecName/apId/secretKey/sign' }
  }
  // 仅探测网关 TCP 可达性，避免真实扣费
  const timeout = opts.timeout || 6000
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), timeout)
  try {
    const resp = await fetch(cfg.masUrl, { method: 'POST', body: '', signal: ctrl.signal })
    clearTimeout(tid)
    // 任何 HTTP 响应都说明网关可达（即便 400/500），仅判断网络层
    return { ok: true, reachable: true, httpStatus: resp.status, note: '网关可达；配置完整，可发送测试短信验证账号有效性' }
  } catch (e) {
    clearTimeout(tid)
    return { ok: false, error: e.name === 'AbortError' ? 'MAS 网关连接超时' : (e.message || String(e)) }
  }
}

module.exports = { init, getConfig, setConfig, sendSms, sendTemplateSms, testConnect, renderTemplate, md5Hex, decodeCallback, tmpSubmitUrl }

/**
 * 解析平台回调 body：兼容三种常见形态
 *  1) Base64( JSON )        —— 与提交方向一致，最常见
 *  2) 直接 JSON 字符串 / 对象
 *  3) 表单键值（已由 express.urlencoded 解析为对象）
 * @param {any} body Express 解析后的 req.body（可能是字符串或对象）
 * @returns {{ parsed: any, mode: string }}
 */
function decodeCallback(body) {
  // 已是对象（urlencoded 或 json 解析结果）
  if (body && typeof body === 'object') return { parsed: body, mode: 'object' }
  if (typeof body !== 'string' || !body.trim()) return { parsed: null, mode: 'empty' }
  const raw = body.trim()
  // 尝试当作 JSON
  try { return { parsed: JSON.parse(raw), mode: 'json' } } catch {}
  // 尝试 Base64 解码后再 JSON
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return { parsed: JSON.parse(decoded), mode: 'base64-json' }
  } catch {}
  // 都不行，原样返回文本
  return { parsed: { rawText: raw }, mode: 'text' }
}
