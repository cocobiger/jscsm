/**
 * IoTCloud AI 视频分析记录拉取模块
 *
 * 定时从 IoTCloud 物联平台拉取通道分析记录，
 * 转换为标准 warning 格式写入 JSC 驾驶舱告警管道。
 *
 * 集成方式（在 index.js 启动回调中）:
 *   const iotFetcher = require('./iot-fetcher')
 *   iotFetcher.start({ store, log, intervalMs: 30000 })
 */

const http = require('http')

// ── 图片 URL 归一（2026-09-20 修复「存档页看不到图 / 空蓝块」）──────
// picUrl 有两种形态，必须区别对待：
//   ① straw-engine（无人机）源：**站内相对路径** `/api/evidence/<日期>/xxx.jpg`
//      → 由 index.js 的 `app.get('/api/evidence/*')` 静态托管，**直连即 200**（实测 92KB image/jpeg）；
//        若再套 `/api/iot-image?url=` 代理，代理侧 `validatePicUrl` 对非 http(s) 抛 Invalid URL
//        → **HTTP 400** → 前端 <img> onError 隐藏自身 → 用户看到**空蓝块**。
//   ② iotcloud/NVR 源：**绝对 http(s)**（:5001 抓图 / :6882 认证网关），必须走代理（跨域 + 内网可达）。
// 结论：**只对绝对 http(s) 套代理，相对路径原样透传**。
// 口径与前端 `src/app/lib/evidenceImage.ts` 的 `evidenceImgUrl()` 完全一致（全站唯一出处）。
function toDisplayImageUrl(picUrl) {
  if (!picUrl) return null
  const s = String(picUrl).trim()
  if (!s) return null
  return /^https?:\/\//i.test(s) ? `/api/iot-image?url=${encodeURIComponent(s)}` : s
}

// ── 配置 ──────────────────────────────────────────────
// IoTCloud 凭据外置到环境变量（见 systemd 服务文件 Environment= 或部署脚本），
// 不再硬编码在源码中。缺失时给出安全降级：baseUrl/username 退回非敏感默认值，
// password 必须来自环境变量（空串会触发登录失败并被轮询重试捕获，不会崩溃）。
// 🔴 09-16 脱钩（IoTCloud 去依赖）：
//   IOT_SOURCE=own 时改走「我们自己的网关」—— cover_gateway(:7100) 提供 IoTCloud 兼容层
//   （路径/响应形状与 /prod-api/sip/analyse/record/list 完全一致），own 模式下**无需登录/token**。
//   其余业务逻辑（通道白名单、ai_types 算法白名单、去重、图片代理）完全不变。
//   回滚：把 IOT_SOURCE 改回 iotcloud（或删掉）重启 jsc-backend 即回到平台源。
const IOT_SOURCE = (process.env.IOT_SOURCE || 'iotcloud').toLowerCase()
const OWN_BASE_URL = process.env.IOT_OWN_BASE_URL || 'http://172.16.8.11:7100'
const IOT = {
  baseUrl: IOT_SOURCE === 'own'
    ? OWN_BASE_URL
    : (process.env.IOT_CLOUD_BASE_URL || 'http://172.16.8.11:6881/prod-api'),
  source: IOT_SOURCE,
  username: process.env.IOT_CLOUD_USERNAME || 'iot-video',
  password: process.env.IOT_CLOUD_PASSWORD || '',
  // 可扩展多通道
  // streamId 关联驾驶舱视频流（coll_streams.id），用于「地理坐标触发对应」：
  // 通道产生 AI 分析推送时，对应摄像头图标在地图上告警。
  channels: [
    { spid: '56331706881318000004', name: '九龙沙场', deviceId: '50010100001310000001', streamId: '43acf69b-cc6a-4cfc-a140-c6fc21b1fcdb' },
  ],
  // 通道触发后摄像头图标保持告警状态的时长（毫秒），超时后自动熄灭
  alertTtlMs: 30 * 60 * 1000,
}

if (!process.env.IOT_CLOUD_PASSWORD) {
  // 仅打印一次提示，不在日志中泄露凭据；实际登录会在轮询中失败并被捕获
  console.warn('[IoT] 警告: 未设置环境变量 IOT_CLOUD_PASSWORD，IoTCloud 登录将失败。请在 systemd 服务或部署环境中配置。')
}

// AI 类型映射（analyseInfo JSON key → 中文）
const AI_TYPE_MAP = {
  unsoilcover: '堆头未覆盖',
  uncovered: '裸土未覆盖',
  person: '人员入侵',
  vehicle: '车辆违停',
  fire: '烟火检测',
  water: '水位异常',
  garbage: '垃圾堆积',
}

// ── 状态 ──────────────────────────────────────────────
let _token = ''
let _tokenExpire = 0       // token 过期时间戳(ms)
let _store = null
let _log = null
let _timer = null
let _lastRecordIds = new Set()  // 去重：已推送的 recordId（启动时从 iot_record_seen + warnings 历史加载，重启不丢失）
// 通道 → 地理坐标 / 视频流 映射（启动时从 coll_streams 解析）
let _channelGeo = {}      // spid -> { lat, lon }
let _channelStream = {}   // spid -> streamId

// 🔴 2026-09-17 B1：「每通道最新一条」的行级短缓存。
//   实测单次计算 320~360 ms —— 成本来自"**必须解析全部 2.9 万条记录才能判定静音规则**"
//   （alertFilterRuleHit 要看 source/channelName/deviceName/location/aiConfidence/level/createdAt），
//   与是否构建完整存档无关（对照实验：旧 getArchive 路径 319.8 ms vs 新逻辑 358.3 ms，同一量级）。
//   而 /api/iot-analysis/status 是**最高频端点**（60 秒轮询 × 多客户端；nginx 日志窗口内 1,534 次），
//   故对**行结果**加 15 秒 TTL：同一次页面加载的多次并发请求直接命中缓存。
//   ⚠️ 只缓存"行"，**不缓存 alerting** —— alerting 仍按每次请求的当前时间实时计算，不会冻结。
//   15 秒是保守值：远小于 IOT.alertTtlMs（30 分钟），新告警的摄像头图标最多晚亮 15 秒。
//   可用环境变量 IOT_STATUS_CACHE_MS 调整，设 0 = 关闭缓存。
const STATUS_CACHE_TTL_MS = Number(process.env.IOT_STATUS_CACHE_MS || 15000)
let _statusCacheAt = 0
let _statusCacheRows = null
let _statusCacheVer = 0      // 保留策略版本号（改了天数要立刻重算，不能等 TTL）

// ── HTTP 辅助（不走代理，直连局域网） ─────────────────
function iotRequest(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    // 注意：baseUrl 含 /prod-api，而 path 是绝对路径（以 / 开头）。
    // 不能直接 new URL('/login', base)，URL 构造器会用 /login 覆盖掉 base 的 /prod-api 路径！
    // 必须手动拼接，保留 /prod-api 前缀。
    const base = IOT.baseUrl.replace(/\/$/, '')
    const rel = path.startsWith('/') ? path : `/${path}`
    const url = new URL(base + rel)
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...( _token ? { Authorization: `Bearer ${_token}` } : {}),
        ...extraHeaders,
      },
      timeout: 10000,
    }

    const req = http.request(opts, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
        catch { resolve({ status: res.statusCode, body: data }) }
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('IoT request timeout')) })

    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

// ── 登录 + Token 管理 ────────────────────────────────
async function login() {
  // 🔴 09-16 脱钩：自有网关无需鉴权 → 直接置一个长效占位 token，跳过 HTTP 登录
  if (IOT.source === 'own') {
    _token = 'own-mode-no-auth'
    _tokenExpire = Date.now() + 365 * 24 * 3600 * 1000
    if (_log) _log.info('[IoT] 数据源=自有网关(%s)，跳过登录', IOT.baseUrl)
    return true
  }
  try {
    const res = await iotRequest('POST', '/login', {
      username: IOT.username,
      password: IOT.password,
    }, { 'isToken': 'false' })
    if (res.status === 200 && res.body?.token) {
      _token = res.body.token
      // JWT 默认有效期较长，设为 2 小时后刷新
      _tokenExpire = Date.now() + 2 * 3600 * 1000
      if (_log) _log.info('[IoT] 登录成功')
      return true
    }
    if (_log) _log.error(`[IoT] 登录失败: ${JSON.stringify(res.body)}`)
    return false
  } catch (e) {
    if (_log) _log.error(`[IoT] 登录异常: ${e.message}`)
    return false
  }
}

async function ensureToken() {
  if (_token && Date.now() < _tokenExpire) return true
  return login()
}

// ── 算法类型解析（2026-09-16 P1：字典「单一出处」= 上游网关 /meta 契约）──
// 🔴 P1 三级回退（顺序即契约，任一级失败自动降级，绝不硬崩）：
//    ① 上游网关 /meta/algo-types（**我们的单一出处**，30 分钟热加载）
//       → 解决「渣土车冒装」与「堆头未覆盖」被合并成同一种告警的问题
//    ② 本地 ai_types 表（source_key → 中文名，每轮热加载）
//    ③ 硬编码 AI_TYPE_MAP（DB/网关都不可用时的兜底）
//    ④ 未命中 → 自动登记到 ai_types（原名，sort_order=90 待补中文名）+ 每次 WARN 一次
//  背景：原实现只有 ②③，两套字典互不匹配（仅 unsoilcover 为交集）→ 绝大多数算法中文名无法落地，
//       且未命中会**静默变成英文**。P1 把「权威字典」搬到上游网关，JSC 只做消费者。
//
//  回退开关：IOT_META_ENABLED=0 可整体关掉 ①（等效回到 P1 之前的行为，用于快速回滚）。
//  网关地址：OWN_BASE_URL（与数据源同源）+ IOT_OWN_BASE_URL 一致。
const IOT_META_ENABLED = (process.env.IOT_META_ENABLED || '1') !== '0'
const META_REFRESH_MS = 30 * 60 * 1000   // 30 分钟刷新一次（与通道/字典热加载节奏一致）
let _aiTypeKeyMap = {}
let _metaAlgoMap = {}          // source_key|alias(lower) -> { name_zh, algo_family, ... }
let _metaLoadedAt = 0
let _metaFailCount = 0
const _unmappedKeys = new Set()

// 纯函数：algo_types 数组 → 「键(小写) → 词条」映射（含 aliases）。
// 🔴 单独抽出便于离线自检（不触网、不起 HTTP）。绝不抛异常，脏数据静默跳过。
function buildMetaAlgoMap(arr) {
  const m = {}
  if (!Array.isArray(arr)) return m
  for (const a of arr) {
    if (!a || !a.source_key) continue
    const entry = {
      name_zh: a.name_zh || a.source_key,
      algo_family: a.algo_family || '',
      deprecated: !!a.deprecated,
      input_size: (a.input_size === undefined ? null : a.input_size),
    }
    m[String(a.source_key).toLowerCase()] = entry
    for (const al of (a.aliases || [])) {
      const k = String(al).toLowerCase()
      if (k) m[k] = entry
    }
  }
  return m
}

// 从上游网关拉 /meta/algo-types，建立「键 → 中文名」映射。
// 失败只记日志、保留旧映射（**不阻塞抓取主链**）。
async function refreshMetaAlgoTypes(force) {
  if (!IOT_META_ENABLED) return
  const now = Date.now()
  if (!force && _metaLoadedAt && (now - _metaLoadedAt) < META_REFRESH_MS) return
  try {
    const res = await iotRequest('GET', '/meta/algo-types')
    // ⚠️ iotRequest 返回的是 {status, body}，**不自动解包 body** → 必须逐层取。
    //   两个网关（未来若直连裸端点）都兼容：body.data.algo_types / body.algo_types。
    const b = (res && res.body) || {}
    const arr = (b.data && b.data.algo_types) || b.algo_types || []
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('empty algo_types')
    _metaAlgoMap = buildMetaAlgoMap(arr)
    _metaLoadedAt = now
    _metaFailCount = 0
    if (_log) _log.info(`[IoT] /meta/algo-types 已加载: ${arr.length} 条算法（可区分键 ${Object.keys(_metaAlgoMap).length} 个）`)
  } catch (e) {
    _metaFailCount++
    if (_log) _log.warn(`[IoT] /meta/algo-types 拉取失败(第 ${_metaFailCount} 次)，沿用旧字典/回退本地: ${e.message}`)
  }
}

// 元数据状态快照（供健康检查/运维观测当前生效的字典来源）
function metaStatus() {
  return {
    enabled: IOT_META_ENABLED,
    loaded: Object.keys(_metaAlgoMap).length > 0,
    keyCount: Object.keys(_metaAlgoMap).length,
    loadedAt: _metaLoadedAt ? new Date(_metaLoadedAt).toISOString() : null,
    failCount: _metaFailCount,
    refreshMs: META_REFRESH_MS,
    // 三级回退当前生效级：1=网关字典 2=本地 ai_types 表 3=硬编码
    activeTier: Object.keys(_metaAlgoMap).length > 0 ? 1 : (Object.keys(_aiTypeKeyMap).length > 0 ? 2 : 3),
  }
}

function resolveAiType(key) {
  const k = String(key || '').trim()
  if (!k) return 'AI分析'
  // ① 上游网关 /meta 契约（权威字典，单一出处）
  const fromMeta = _metaAlgoMap[k.toLowerCase()]
  if (fromMeta && fromMeta.name_zh) return fromMeta.name_zh
  // ② 本地 ai_types 表
  const fromDb = _aiTypeKeyMap[k]
  if (fromDb) return fromDb
  // ③ 硬编码兜底
  const fromConst = AI_TYPE_MAP[k]
  if (fromConst) return fromConst
  // ④ 未命中 → 登记原名 + WARN 一次
  let name = k
  if (_store && typeof _store.ensureAiTypeByKey === 'function') {
    try { name = _store.ensureAiTypeByKey(k) || k } catch (e) { /* 降级用原名 */ }
  }
  if (!_unmappedKeys.has(k)) {
    _unmappedKeys.add(k)
    if (_log) _log.warn(`[IoT] 发现未映射算法 key:「${k}」→ 已登记到 ai_types（sort_order=90，待补中文名）；本次以原名入库`)
  }
  return name
}

// P1：拿算法族键（区分用）。网关给 aiType 就用它，否则回退 ai_type 原值。
function algoFamilyKey(rec) {
  const t = rec && (rec.aiType || rec.aiTypeRaw)
  return t ? String(t) : ''
}

// ── analyseInfo 解析 ─────────────────────────────────
// 🔴 P1：优先用网关下发的 rec.aiType（**可区分算法族**）来定中文名；
//    它取不到时才退回现有的「取 analyseInfo 第一个键」老逻辑（完全向后兼容）。
function parseAnalyseInfo(infoStr, rec) {
  // ① P1：网关已给定可区分键（cover_det / stockpile_cover / …）
  const fam = algoFamilyKey(rec)
  try {
    const arr = JSON.parse(infoStr)
    if (!Array.isArray(arr) || arr.length === 0) {
      return { type: fam ? resolveAiType(fam) : 'AI分析', confidence: 0, raw: infoStr,
               family: fam || '' }
    }
    const first = arr[0]
    const key = Object.keys(first)[0]
    const value = first[key]
    // ② 置信度仍从 analyseInfo 数值取（网关的 aiType 只表达"哪类算法"）
    let conf = typeof value === 'number' ? value : 0
    if (typeof value !== 'number') {
      for (const k2 of Object.keys(first)) {
        if (typeof first[k2] === 'number') { conf = first[k2]; break }
      }
    }
    return {
      type: resolveAiType(fam || key),
      confidence: conf,
      raw: infoStr,
      // P1：算法族键透传给前端，便于按业务分色/分层/分统计
      family: fam || '',
      typeRaw: key,
    }
  } catch {
    return { type: fam ? resolveAiType(fam) : 'AI分析', confidence: 0, raw: infoStr,
             family: fam || '' }
  }
}

// ── 单条记录 → Warning 对象 ─────────────────────────
function transformToWarning(rec) {
  const ai = parseAnalyseInfo(rec.analyseInfo, rec)
  const level = ai.confidence >= 0.7 ? 3 : ai.confidence >= 0.5 ? 2 : 1  // 3=中度 2=轻度 1=注意
  // 地理坐标来自关联的视频流（coll_streams），实现与驾驶舱摄像头的「坐标触发对应」
  const spid = rec.channelSpid || rec.channelSipId || ''
  const geo = _channelGeo[spid] || {}
  const streamId = _channelStream[spid] || ''

  return {
    id: `iot-${rec.recordId}`,
    createdAt: rec.createTime,
    status: 'pending',
    warning_type: 'iot-video-analysis',   // 供前端 toAlert 识别（data_json 内）
    warningType: 'iot-video-analysis',    // 供 insertWarning 写入 warning_type 列（camelCase）
    // data_json 字段（前端 AlertItem 所需）
    source: 'iotcloud',
    recordId: rec.recordId,
    deviceSipId: rec.deviceSipId,
    channelSipId: rec.channelSipId,
    channelSpid: rec.channelSpid,
    channelName: rec.channelName || '',
    deviceName: rec.deviceName || '',
    picUrl: rec.picUrl || '',
    aiType: ai.type,
    aiTypeFamily: ai.family || '',      // 🔴 P1：算法族键（cover_det/stockpile_cover…），供前端区分
    aiTypeRaw: ai.typeRaw || '',        // 🔴 P1：analyseInfo 原始键，便于排查
    aiConfidence: ai.confidence,
    // 🔴 09-17 P0-2b：门限内外标记（网关下发）。
    //   false = 这条是「低于 min_spill_conf 的全量分析记录」→ 只进「AI分析存档」，
    //   不进「实时告警」（由 store.queryWarningsAggregated 与 warnings-stream 排除）。
    //   undefined（历史记录无此字段）→ 视为已过门限，保持原可见性，不误伤老数据。
    gatePassed: rec.gatePassed,
    ruleId: rec.ruleId,
    streamId,   // 关联视频流 id，供前端地图摄像头图标定位告警
    // 兼容现有 AlertItem 字段
    time: rec.createTime ? rec.createTime.slice(11, 19) : '',
    location: `${rec.channelName || ''} ${rec.deviceName || ''}`.trim(),
    type: `AI视频分析 · ${ai.type}`,
    value: `置信度 ${Math.round(ai.confidence * 100)}%`,
    standard: `阈值 ≥50%`,
    level,
    lat: typeof geo.lat === 'number' ? geo.lat : 30.731352,
    lon: typeof geo.lon === 'number' ? geo.lon : 108.416972,
  }
}

// ── 拉取一轮数据 ─────────────────────────────────────
async function fetchOnce() {
  if (!await ensureToken()) return

  // 从 iot_channels 表热加载启用通道（每轮查表，管理员改动 30s 内生效，免重启）
  const channels = (_store && typeof _store.listIotChannels === 'function')
    ? _store.listIotChannels().filter(c => c.enabled)
    : []
  if (channels.length === 0) return 0

  // 🔴 P1：优先拉上游网关 /meta/algo-types（权威字典）；失败则沿用旧映射，不阻塞主链
  await refreshMetaAlgoTypes(false)

  // 2026-09-15 整改：每轮热加载算法字典（source_key → 中文名，单一出处 ai_types 表）
  _aiTypeKeyMap = (_store && typeof _store.getAiTypeKeyMap === 'function') ? _store.getAiTypeKeyMap() : {}

  // 每轮刷新坐标映射（按 streamId 从 coll_streams 解析）
  resolveChannelGeo(channels.map(c => ({
    spid: c.channelSipId, name: c.channelName, streamId: c.streamId,
  })))

  let totalNew = 0
  let skippedUnreg = 0   // 未登记通道（白名单外）
  let skippedAlgo = 0    // 已登记但算法不在配置内
  for (const ch of channels) {
    try {
      const res = await iotRequest('GET',
        `/sip/analyse/record/list?pageNum=1&pageSize=20&channelSpid=${ch.channelSipId}&deviceId=${ch.deviceSipId}`)

      if (res.status !== 200 || !res.body?.rows) {
        if (_log) _log.warn(`[IoT] 拉取失败 [${ch.channelName}]: HTTP ${res.status}`)
        continue
      }

      const rows = res.body.rows || []
      for (const rec of rows) {
        // 去重
        if (_lastRecordIds.has(rec.recordId)) continue
        _lastRecordIds.add(rec.recordId)

        const warning = transformToWarning(rec)

        // 2026-09-15 整改（通道算法配置「真生效」· 白名单语义）
        //   ⚠️ 实测 IoTCloud 的 /sip/analyse/record/list 对 channelSpid **过滤不严格** ——
        //   请求某通道会返回该 NVR 下其它通道的记录（日志证据：每个登记通道都"新增 1 条"，
        //   而拉到的却是 205/204/305 等未登记通道的记录）。
        //   因此必须按**记录自身的 channelSipId** 去查配置，而不是按"请求的通道"。
        //   规则：① 记录所属通道未登记 → 不收（配置即白名单）
        //        ② 已登记但 aiType 不在该通道 ai_types 配置内 → 不收
        const recCh = channels.find(c => c.channelSipId === warning.channelSipId)
        if (!recCh) {
          skippedUnreg++
          if (typeof _store.iotMarkSeen === 'function') _store.iotMarkSeen(rec.recordId, warning.channelSipId)
          continue
        }
        const allow = recCh.aiTypes || []
        if (allow.length > 0 && !allow.includes(warning.aiType)) {
          skippedAlgo++
          if (typeof _store.iotMarkSeen === 'function') _store.iotMarkSeen(rec.recordId, recCh.channelSipId)
          continue
        }

        if (_store) {
          _store.insertWarning(warning)
          // 入库成功后留痕（DB 持久化，进程重启后不再重拉覆盖 handled 状态）
          if (typeof _store.iotMarkSeen === 'function') _store.iotMarkSeen(rec.recordId, recCh.channelSipId)
        }
        totalNew++
      }

      if (rows.length > 0 && _log) {
        _log.info(`[IoT] 拉取完成 [${ch.channelName}]: 共${rows.length}条, 本轮累计新增${totalNew}条`)
      }
    } catch (e) {
      if (_log) _log.error(`[IoT] 拉取异常 [${ch.channelName}]: ${e.message}`)
    }
  }
  if ((skippedUnreg || skippedAlgo) && _log) {
    _log.info(`[IoT] 通道配置过滤：未登记通道跳过 ${skippedUnreg} 条 · 算法不匹配跳过 ${skippedAlgo} 条（本轮新增 ${totalNew} 条）`)
  }
  return totalNew
}

// ── 通道 → 视频流地理坐标解析 ──────────────────────
// 从驾驶舱视频流（coll_streams）解析每个通道的真实经纬度与 streamId，
// 实现「AI 分析通道 ↔ 地图摄像头」的地理坐标触发对应。
// channels: [{ spid, name, streamId }]（来自 iot_channels 表热加载）
function resolveChannelGeo(channels) {
  _channelGeo = {}
  _channelStream = {}
  if (!_store || typeof _store.collList !== 'function') return
  const streams = _store.collList('streams') || []
  for (const ch of channels) {
    const spid = ch.spid || ch.channelSipId
    if (!spid) continue
    let st = ch.streamId ? streams.find(s => s.id === ch.streamId) : null
    if (!st && ch.name) st = streams.find(s => s.name === ch.name)
    if (st && typeof st.lat === 'number' && typeof st.lon === 'number') {
      _channelGeo[spid] = { lat: st.lat, lon: st.lon }
      _channelStream[spid] = st.id
    } else if (ch.streamId) {
      // 找不到关联视频流时，仍记录 streamId（可能稍后补齐），坐标为空由前端兜底
      _channelStream[spid] = ch.streamId
    }
  }
}

// 启动时为已入库的历史记录补齐正确的经纬度与 streamId（避免旧数据坐标错误）
function fixExistingRows() {
  if (!_store || typeof _store.queryWarnings !== 'function') return
  const rows = _store.queryWarnings({ type: 'iot-video-analysis', limit: 5000 }) || []
  let fixed = 0
  for (const w of rows) {
    const spid = w.channelSpid || w.channelSipId || ''
    const geo = _channelGeo[spid]
    const sid = _channelStream[spid] || ''
    if (!geo && !sid) continue
    if (w.lat === geo?.lat && w.lon === geo?.lon && w.streamId === sid) continue
    if (geo) { w.lat = geo.lat; w.lon = geo.lon }
    if (sid) w.streamId = sid
    _store.insertWarning(w)  // INSERT OR REPLACE（以 id 为主键）
    fixed++
  }
  if (fixed > 0 && _log) _log.info(`[IoT] 已修正 ${fixed} 条历史记录的坐标/streamId`)
}

// ── 按通道分类的 AI 历史分析存档 ────────────────────
// 2026-09-17 修复 P0-1：原先 limit:5000 只返回 33 条（配额被过滤规则吃掉），故把上限调大。
// 🔴 2026-09-20 修正（用户报「无人机 4 个机场只看到 3 个」）—— 之前把这件事记成"已改为先过滤后截断"，
//   **那个说法是错的**，实际实现是 `ORDER BY rowid DESC LIMIT N` **在 SQL 层先截断**，
//   之后才做 alertFilterRuleHit 与时间过滤。于是只要表内总量 > N，
//   **最老的那批记录永远进不了后续流程，静默消失**。
//   实测（生产库）：iot-video-analysis 共 29,227 条，N=20000 ⇒ **9,227 条被直接丢弃**，
//      造成「职教中心机场」22 条（rowid 10092~10956，全部在窗口外）**连卡片都没有**，
//      另外三峡科技 55→26、经开区 32→1、环保局 66→5 也被截掉大半。
//   ⇒ 上限提到 40000（有余量地覆盖当前全表）；一旦总量逼近该值，必须改为
//     「按通道/时间分页查询」而**不是**继续调大这个数字（否则同样的问题会再来一次）。
//   ⚠️ 响应体随之变大（实测约 3.6 MB / 7,853 条），但接口带 weak ETag 且支持 If-None-Match，
//      浏览器复访走 304、0 字节 ⇒ 实际流量只在数据变化时发生。
const ARCHIVE_MAX_ROWS = 40000
function getArchive(opts) {
  if (!_store) return { channels: [], total: 0 }
  const o = opts || {}
  // P0-3（2026-09-20）：支持**服务端时间范围过滤**（前端传 from/to，按上海时解析）。
  //   注意：getStatus() 已于 2026-09-17 改为 latestPerChannel() 轻量查询、**不再调用本函数**
  //   ⇒ 地图摄像头告警灯既不受时间筛选影响、也不受「排除模拟流」影响。
  const range = {}
  if (o.from) range.from = String(o.from)
  if (o.to) range.to = String(o.to)
  // P0-1（2026-09-19）：存档页是「原始记录留档」，必须**包含被研判拦下的记录（blocked）**——
  //   研判只决定"要不要进前台实时告警"，绝不代表"这条识别记录不存在"。
  //   故这里显式 includeBlocked:true（前台 /api/warnings 默认不看 blocked）。
  const rows = _store.queryWarnings({ type: 'iot-video-analysis', limit: ARCHIVE_MAX_ROWS, includeBlocked: true, ...range }) || []
  // 2026-09-20：不生成「(模拟·测试流)」这张卡片（联调产物，业务无价值）。
  //   判据就是**归组键本身** == SIM_STREAM_LABEL —— 等价于"去掉那张卡片"，可证明不会碰真实通道：
  //     · 真实通道的记录 key = channelName（自己的名字），永不等于该标签 ⇒ 一定保留；
  //     · 真实机场流 key = 机场名（机场映射优先于 sim 判据）⇒ 也一定保留。
  //   实测（生产库 29227 条）：该卡片共 457 条，**0 条带真实 channelName/SipChannelId**。
  //   只影响本接口展示，**DB 里一行未动**；需要复核它们时加 ?includeSim=1 即可。
  const SIM_LABEL = _store.SIM_STREAM_LABEL || '(模拟·测试流)'
  const byChannel = new Map()
  let simSkipped = 0
  for (const w of rows) {
    // P0-4（2026-09-20）：无人机（straw-engine）记录**没有"通道"概念**（channelName/channelSipId 均为空），
    //   只有 streamId。此前一律落进「未命名通道」，导致列表通道列整片空白。
    //   现按 streamId 兜底出可读名：机场名（尾段/SN 前缀命中）→ '(模拟·测试流)' → 空。
    const fallback = (typeof _store.streamFallbackName === 'function') ? _store.streamFallbackName(w.streamId) : ''
    const key = w.channelName || fallback || w.channelSipId || '未命名通道'
    if (!o.includeSim && key === SIM_LABEL) { simSkipped++; continue }
    const spid = w.channelSpid || w.channelSipId || ''
    if (!byChannel.has(key)) {
      byChannel.set(key, {
        channelName: key,
        spid,
        deviceId: w.deviceSipId || '',
        streamId: w.streamId || _channelStream[spid] || '',
        lat: typeof w.lat === 'number' ? w.lat : (_channelGeo[spid]?.lat ?? null),
        lon: typeof w.lon === 'number' ? w.lon : (_channelGeo[spid]?.lon ?? null),
        records: [],
        latestAt: '',
      })
    }
    const ch = byChannel.get(key)
    const createdAt = w.createdAt || ''
    if (createdAt > ch.latestAt) ch.latestAt = createdAt
    ch.records.push({
      id: w.id,
      createdAt,
      time: w.time || (createdAt ? createdAt.slice(11) : ''),
      fullTime: createdAt,
      aiType: w.aiType || '',
      aiConfidence: w.aiConfidence || 0,
      level: w.level || 1,
      // 只对绝对 http(s) 套代理；/api/evidence/… 相对路径原样透传（否则代理 400 → 空蓝块）
      imageUrl: toDisplayImageUrl(w.picUrl),
      channelName: w.channelName || '',
      // P0-4（2026-09-20）：通道名为空时（无人机记录）的可读兜底名 + 原始 streamId，供列表「通道」列回落显示
      displayName: fallback,
      streamId: w.streamId || '',
      deviceName: w.deviceName || '',
      warningType: w.warning_type || 'iot-video-analysis',
      // P0-4（2026-09-19）：研判留痕（准入/拦下 + 原因），供存档页展示与筛选
      judgeStatus: w.judgeStatus || '',
      judgeReason: w.judgeReason || '',
      judgeRuleId: w.judgeRuleId || '',
    })
  }
  const channels = [...byChannel.values()].map(ch => ({
    ...ch,
    total: ch.records.length,
    records: ch.records.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
  })).sort((a, b) => (b.latestAt || '').localeCompare(a.latestAt || ''))
  return { channels, total: rows.length - simSkipped }
}

// ── P0-3（2026-09-17 B1）「每通道最新一条」轻量查询 ─────────────────────
// 🔴 背景：getStatus() 原实现调用 getArchive()，而 getArchive() → _store.queryWarnings()
//   会取最多 20,000 行、逐条 JSON.parse 并**构建完整记录对象**（含 picUrl/type/value/standard 等长字段，
//   还要为每条通道维护 records 数组并逐通道排序），最后只用到**每条通道的最新一条**。
//   而 /api/iot-analysis/status 是**最高频端点**（nginx 日志窗口内 1,534 次，archive 只有 103 次），
//   响应体仅 ~3 KB，耗时却全花在全量构建上（基线实测 0.31~0.40 s）。
// 做法：**每行只解析一次 JSON**，只保留"判定可见性 + 取最新 + 输出状态"所需的 8 个字段，
//   最终只产出 ~14 个对象 —— 不再构建 7,818 条完整记录、不再逐通道排序、不再走 20,000 行配额。
//   ⚠️ 这里**刻意不用 SQL 的 json_extract 做字段投影**：SQLite 每次 json_extract 都会重新解析
//      JSON 文本，18 个字段 × 29,134 行 ≈ 52 万次解析，实测反而比"JS 里解析 2.9 万次"更慢（0.54s vs 0.32s）。
//   · 必须复刻 getArchive→queryWarnings 的可见性口径 —— 它会过 alertFilterRuleHit（静音规则）。
//     ⚠️ 实测若不过这一步会多出 4 个被静音的通道（18 vs 14），故不可省；
//        而过它就必须解析记录（规则要看 source/channelName/deviceName/location/aiConfidence/level/createdAt）。
//   · 分组键与"择新"口径严格复刻 getArchive()：channelName || channelSipId || '未命名通道'，
//     用**字符串比较** created_at 取最大（与 getArchive 的 latestAt 比较方式一致）。
function latestPerChannel() {
  if (!_store || typeof _store.getDb !== 'function') return []
  // 短缓存命中：直接返回上一轮的行（alerting 由调用方按当前时间实时算，不受影响）
  // 缓存键之一：保留策略版本号 —— 管理员改了天数要立刻重算，不能等 TTL
  const ver = (typeof _store.retentionVersion === 'function') ? _store.retentionVersion() : 0
  if (_statusCacheRows && STATUS_CACHE_TTL_MS > 0
      && _statusCacheVer === ver && (Date.now() - _statusCacheAt) < STATUS_CACHE_TTL_MS) {
    return _statusCacheRows
  }
  let rows
  try {
    rows = _store.getDb().prepare(
      "SELECT created_at AS createdAt, data_json AS dataJson FROM warnings WHERE warning_type = 'iot-video-analysis'"
    ).all()
  } catch (e) {
    // 查询失败不抛（地图不应因此不可用），留日志便于排查
    if (typeof console !== 'undefined') console.error('[iot-fetcher] latestPerChannel 查询失败:', e && e.message)
    return []
  }
  // 静音规则：与 getArchive→queryWarnings 完全同一口径（规则集合取一次整批复用，避免 N+1）
  const rules = (typeof _store.loadEnabledFilterRules === 'function') ? _store.loadEnabledFilterRules() : []
  const hit = (typeof _store.alertFilterRuleHit === 'function') ? _store.alertFilterRuleHit : null
  const expired = (typeof _store.warningRetentionExpired === 'function') ? _store.warningRetentionExpired : null
  const nowMs = Date.now()
  const best = new Map()
  for (const r of rows) {
    let w
    try { w = JSON.parse(r.dataJson) } catch (e) { continue }
    if (hit && hit(w, rules)) continue
    // 2026-09-24：保留期软归档 —— 超过该算法保留天数的记录不再驱动告警灯（与前台列表同口径）。
    //   🔴 实测（生产库 2026-09-24 18:47，29,974 条）：**不是空操作**
    //     ① 状态列表通道数 19 → 7（12 个通道的"最新一条"已超期 ⇒ 整条不再出现在状态列表）
    //     ② 但 alerting 集合**完全不变**（灯的 TTL 30 分钟，远短于任何 ≥1 天保留期）
    //        ⇒ 地图摄像头告警灯无变化；后台通道卡片的"告警中"圆点也无变化。
    //     结论：影响的是"状态列表里还有没有这个通道"，不影响"灯亮不亮"。
    if (expired && expired(w, nowMs)) continue
    const key = w.channelName || w.channelSipId || '未命名通道'
    const at = r.createdAt || ''
    const cur = best.get(key)
    if (!cur || String(at) > String(cur.createdAt || '')) {
      best.set(key, {
        createdAt: at,
        channelName: key,
        channelSpid: w.channelSpid,
        channelSipId: w.channelSipId,
        streamId: w.streamId,
        lat: w.lat,
        lon: w.lon,
        aiType: w.aiType,
      })
    }
  }
  const out = Array.from(best.values())
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  _statusCacheRows = out
  _statusCacheAt = Date.now()
  _statusCacheVer = ver
  return out
}

// 告警时间 → epoch ms（显式上海时，与 store-db.js 的 warningTimeMs 同一口径）
//   'YYYY-MM-DD HH:MM:SS' 无时区后缀 ⇒ 补 +08:00（**不能依赖机器本地时区**）
//   ISO 带 Z / 带偏移 ⇒ 原样交给 Date 解析
function eventMs(s) {
  const v = String(s || '')
  if (!v) return NaN
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(v)) return Date.parse(v.replace(' ', 'T') + '+08:00')
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return Date.parse(v + 'T00:00:00+08:00')
  return Date.parse(v)
}

// ── 通道实时触发状态（驱动地图摄像头图标告警）────────
// 🔴 2026-09-17 B1：不再调用 getArchive()（全量构建）；改为只查每条通道最新一条。
//   输出结构与字段语义与改造前**完全一致**，仅去掉了不必要的全量构建。
function getStatus() {
  const now = Date.now()
  const channels = latestPerChannel().map(r => {
    const spid = r.channelSpid || r.channelSipId || ''
    const lastEventAt = r.createdAt || ''
    const t = eventMs(lastEventAt)
    return {
      spid,
      name: r.channelName,
      streamId: r.streamId || _channelStream[spid] || '',
      lat: typeof r.lat === 'number' ? r.lat : (_channelGeo[spid]?.lat ?? null),
      lon: typeof r.lon === 'number' ? r.lon : (_channelGeo[spid]?.lon ?? null),
      alerting: !isNaN(t) && (now - t) < IOT.alertTtlMs,
      lastEventAt,
      lastEventType: r.aiType || '',
    }
  })
  return { channels, ttlMinutes: IOT.alertTtlMs / 60000, serverTime: new Date().toISOString() }
}



// ── 图片代理（解决跨域，供前端调用） ────────────────
// 简易内存 LRU 缓存：同一张图（如聚合告警预览、通道快照）在 5 分钟内被多张卡片重复请求时，
// 命中缓存直接返回字节，避免反复回源 IoTCloud，显著降低驾驶舱告警图片加载耗时。
const _imageCache = new Map() // key: picUrl -> { buf, contentType, expire }
const IMAGE_CACHE_TTL = 5 * 60 * 1000
const IMAGE_CACHE_MAX = 300
function _cacheGet(url) {
  const e = _imageCache.get(url)
  if (!e) return null
  if (Date.now() > e.expire) { _imageCache.delete(url); return null }
  // LRU touch：移到队尾
  _imageCache.delete(url); _imageCache.set(url, e)
  return e
}
function _cacheSet(url, buf, contentType) {
  if (_imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = _imageCache.keys().next().value // Map 保留插入顺序，首条即最旧
    if (oldest !== undefined) _imageCache.delete(oldest)
  }
  _imageCache.set(url, { buf, contentType, expire: Date.now() + IMAGE_CACHE_TTL })
}

// ── 图片 URL 白名单校验（IoTCloud 限定路径前缀 + 城运平台域名放宽）──
function validatePicUrl(picUrl) {
  const IOT_CLOUD_HOSTS = ['111.10.220.226', '172.16.8.11']
  const CHENGYUN_IMG_HOSTS = (process.env.CHENGYUN_IMG_HOSTS || '10.120.49.14').split(',').map(s => s.trim()).filter(Boolean)
  const ALLOWED_HOSTS = Array.from(new Set([...IOT_CLOUD_HOSTS, ...CHENGYUN_IMG_HOSTS]))
  try {
    const u = new URL(picUrl)
    if (!ALLOWED_HOSTS.includes(u.hostname)) return { status: 403, msg: 'Forbidden' }
    if (IOT_CLOUD_HOSTS.includes(u.hostname)) {
      const pathOk = u.pathname.includes('/images/') || u.pathname.includes('/profile/snap/')
      if (!pathOk) return { status: 403, msg: 'Forbidden' }
    }
    return null
  } catch {
    return { status: 400, msg: 'Invalid URL' }
  }
}

// ── 图片源站候选解析（2026-09-03 双源回退）──
// 上游 9/2 19:32 起 picUrl host 从 :5001(nginx 静态免认证) 切到 :6882(认证网关，裸请求返回 HTTP 200 包裹的 JSON 401)；
// 实测同路径 :5001 HIT 200 → 遇 6882 网关形态时先试 :5001，失败再回退 :6882 原样（保留真实状态码供留痕/跟踪上游）。
function sourceCandidates(picUrl) {
  const purl = new URL(picUrl)
  // JSC 服务器内部无法访问公网 IP（111.10.220.226），改写为局域网 IP（172.16.8.11）
  const host = purl.hostname === '111.10.220.226' ? '172.16.8.11' : purl.hostname
  const path = purl.pathname + purl.search
  const is6882 = host === '172.16.8.11' && (String(purl.port) === '6882')
  if (is6882) {
    return [
      { hostname: host, port: 5001, path, tag: '5001' },   // 首选：nginx 静态免认证
      { hostname: host, port: 6882, path, tag: '6882' },   // 回退：认证网关原样（401 留痕，防 5001 无副本的新图）
    ]
  }
  return [{ hostname: host, port: purl.port || 80, path, tag: 'origin' }]
}

// 拉取图片源站字节（遍历候选：5001 优先 → 6882 回退；非 200 或 content-type 非 image/* 视为该源失败）
function fetchImageBytes(picUrl) {
  return new Promise((resolve, reject) => {
    let cands
    try { cands = sourceCandidates(picUrl) } catch (e) { return reject(e) }
    const attempt = (i, errs) => {
      if (i >= cands.length) {
        console.error(`[img-proxy] 6882/5001 双源均失败 url=${picUrl} (${errs.join('; ')})`)
        return reject(new Error('双源均失败: ' + errs.join('; ')))
      }
      const c = cands[i]
      let settled = false
      const fail = (reason) => { if (settled) return; settled = true; attempt(i + 1, errs.concat(reason)) }
      const req = http.get({ hostname: c.hostname, port: c.port, path: c.path, timeout: 15000 }, (proxyRes) => {
        // 6882 网关对任意路径返回 HTTP 200 + application/json {"code":401} → 需按 content-type 判图，非 image/* 视为失败
        const ct = String(proxyRes.headers['content-type'] || '').toLowerCase()
        if (proxyRes.statusCode !== 200 || !ct.startsWith('image/')) {
          proxyRes.resume()
          return fail(`${c.tag}:${proxyRes.statusCode} ${ct || 'no-ct'}`)
        }
        settled = true
        const chunks = []
        proxyRes.on('data', d => chunks.push(d))
        proxyRes.on('end', () => resolve(Buffer.concat(chunks)))
      })
      req.on('error', (e) => fail(`${c.tag}:ERR ${e.code || e.message}`))
      req.on('timeout', () => { req.destroy(); fail(`${c.tag}:timeout`) })
    }
    attempt(0, [])
  })
}

// ── 缩略图服务：sharp 缩放 + webp 压缩（缩略图不再加载原图，大幅降低流量）──
let _sharp = null
function loadSharp() {
  if (_sharp !== null) return _sharp
  try { _sharp = require('sharp') } catch { _sharp = false }
  return _sharp
}

async function thumbImage(req, res) {
  const picUrl = req.query.url
  if (!picUrl) return res.status(400).send('Missing url param')
  const w = Math.min(Math.max(parseInt(req.query.w) || 200, 50), 800)
  const sharp = loadSharp()
  if (!sharp) return proxyImage(req, res)   // 无 sharp 降级原图
  const v = validatePicUrl(picUrl)
  if (v) return res.status(v.status).send(v.msg)
  const cacheKey = `thumb:${w}:${picUrl}`
  const cached = _cacheGet(cacheKey)
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Content-Type', 'image/webp')
    res.setHeader('X-Cache', 'HIT')
    return res.end(cached.buf)
  }
  try {
    const buf = await fetchImageBytes(picUrl)
    const out = await sharp(buf).resize({ width: w, withoutEnlargement: true }).webp({ quality: 70 }).toBuffer()
    _cacheSet(cacheKey, out, 'image/webp')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Content-Type', 'image/webp')
    res.setHeader('X-Cache', 'MISS')
    res.setHeader('X-Thumb', `w${w}`)
    res.end(out)
  } catch (e) {
    res.status(502).send('Thumb failed: ' + e.message)
  }
}

async function proxyImage(req, res) {
  const picUrl = req.query.url
  if (!picUrl) return res.status(400).send('Missing url param')
  const v = validatePicUrl(picUrl)
  if (v) return res.status(v.status).send(v.msg)

  // 命中缓存：直接返回字节（带 X-Cache 头便于联调观察）
  const cached = _cacheGet(picUrl)
  if (cached) {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Content-Type', cached.contentType || 'image/jpeg')
    res.setHeader('X-Cache', 'HIT')
    return res.end(cached.buf)
  }

  let cands
  try { cands = sourceCandidates(picUrl) } catch (e) { return res.status(400).send('Invalid URL') }

  // 遍历候选源（5001 优先 → 6882 回退）：首个「200 且 content-type 为 image/*」的源即转发成功
  const attempt = (i, errs) => {
    if (i >= cands.length) {
      console.error(`[img-proxy] 6882/5001 双源均失败 url=${picUrl} (${errs.join('; ')})`)
      return res.status(502).send('Image source error: ' + errs.join('; '))
    }
    const c = cands[i]
    let settled = false
    const fail = (reason) => { if (settled) return; settled = true; attempt(i + 1, errs.concat(reason)) }
    const proxyReq = http.get({ hostname: c.hostname, port: c.port, path: c.path, timeout: 15000 }, (proxyRes) => {
      // 6882 网关对任意路径返回 HTTP 200 + application/json {"code":401} → 按 content-type 判图，非 image/* 视为该源失败
      const ct = String(proxyRes.headers['content-type'] || '').toLowerCase()
      if (proxyRes.statusCode !== 200 || !ct.startsWith('image/')) {
        proxyRes.resume() // 丢弃错误响应体
        return fail(`${c.tag}:${proxyRes.statusCode} ${ct || 'no-ct'}`)
      }
      settled = true
      const contentType = proxyRes.headers['content-type'] || 'image/jpeg'
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.setHeader('Content-Type', contentType)
      res.setHeader('X-Cache', 'MISS')
      res.setHeader('X-Img-Source', c.tag) // 联调观察：图实际取自 5001 静态 / 6882 网关 / origin
      // 边转发边收集字节，结束后再写入缓存
      const chunks = []
      proxyRes.on('data', (d) => { chunks.push(d); res.write(d) })
      proxyRes.on('end', () => {
        try { _cacheSet(picUrl, Buffer.concat(chunks), contentType) } catch {}
        res.end()
      })
    })
    proxyReq.on('error', (e) => fail(`${c.tag}:ERR ${e.code || e.message}`))
    proxyReq.on('timeout', () => { proxyReq.destroy(); fail(`${c.tag}:timeout`) })
  }
  attempt(0, [])
}

// ── API 路由注册 ─────────────────────────────────────
function registerRoutes(app) {
  // IoT 分析历史查询
  app.get('/api/iot-analysis', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100)
    if (!_store) return res.json({ rows: [], total: 0 })

    const warnings = _store.queryWarnings({ type: 'iot-video-analysis', limit })
    res.json({
      rows: warnings.map(w => ({
        id: w.id,
        time: w.time,
        fullTime: w.createdAt,
        type: w.type,
        location: w.location,
        value: w.value,
        level: w.level,
        // 只对绝对 http(s) 套代理；/api/evidence/… 相对路径原样透传（否则代理 400 → 空蓝块）
        imageUrl: toDisplayImageUrl(w.picUrl),
        channelName: w.channelName,
        deviceName: w.deviceName,
        aiType: w.aiType,
        aiConfidence: w.aiConfidence,
        createdAt: w.createdAt,
      })),
      total: warnings.length,
    })
  })

  // 图片代理
  app.get('/api/iot-image', proxyImage)
  app.get('/api/thumb', thumbImage)

  // 按通道分类的 AI 历史分析存档
  // 🔴 2026-09-20：加一层**响应短缓存**。原因（实测）：
  //   修复「SQL 预截断」后本接口需同步解析 ~2.9 万行（实测 ~1.0s / 3.57MB），
  //   而 node:sqlite 是**同步** API ⇒ 这 1s 会**阻塞事件循环**：
  //   实测 archive 在跑时 `/api/iot-analysis/status` 由 0.002s 被拖到 **0.680s**。
  //   存档是历史数据、非实时视图 ⇒ 用 90s 全局缓存把「每个标签页每分钟算一次」
  //   收敛为「全局最多 90s 算一次」，多开标签页/前后台复访只付一次代价。
  //   代价：新记录最多滞后 90s 才出现在存档页（对历史留档无影响）。
  //   注：`res.send(字符串)` 与 res.json 一样会计算 ETag ⇒ 内容未变时浏览器仍收 304、0 字节。
  const ARC_CACHE_TTL_MS = 90000
  const ARC_CACHE_MAX = 24
  const _arcCache = new Map()   // key -> { at, body }
  app.get('/api/iot-analysis/archive', (req, res) => {
    // P0-3：透传时间范围（?from=YYYY-MM-DD&to=YYYY-MM-DD 或 datetime-local）
    // 2026-09-20：默认排除「模拟/测试流」；?includeSim=1 可把它们放回来（排障用，无需发版）
    const includeSim = req.query.includeSim === '1' || req.query.includeSim === 'true'
    const key = `${req.query.from || ''}|${req.query.to || ''}|${includeSim ? 1 : 0}`
    const now = Date.now()
    const hit = _arcCache.get(key)
    if (hit && now - hit.at < ARC_CACHE_TTL_MS) {
      res.type('application/json').send(hit.body)
      return
    }
    const body = JSON.stringify(getArchive({
      from: req.query.from,
      to: req.query.to,
      includeSim,
    }))
    if (_arcCache.size >= ARC_CACHE_MAX) _arcCache.clear()
    _arcCache.set(key, { at: now, body })
    res.type('application/json').send(body)
  })

  // 通道实时触发状态（地理坐标对应摄像头图标告警）
  app.get('/api/iot-analysis/status', (req, res) => {
    res.json(getStatus())
  })

  // 手动触发一次拉取（调试用）
  app.post('/api/iot-fetch/now', async (req, res) => {
    const count = await fetchOnce()
    res.json({ ok: true, newRecords: count })
  })

  // 🔴 2026-09-17 D4：/simulate 与 /simulate-closure 是「**往生产库注入假数据**」的入口
  //   （09-07/09-10 那 529 条合成数据即源于此）。
  //   现状核实：两者均为 POST，且不在 index.js 的 PUBLIC_PATHS / ANY_USER_WRITES /
  //     OPERATOR_WRITE_PREFIXES 中 ⇒ requiredRoleForWrite 默认返回 'admin'，
  //     **已要求管理员会话**（实测：不带 token POST → 401 UNAUTHORIZED）。
  //   本次加固：再加一道**默认关闭**的环境开关 —— 生产环境不再"登录管理员就能点"，
  //     必须显式设置 ALLOW_SIMULATE=1 才可用，把"误点 / 误用 / 被诱导点击"的可能性清零。
  //   回滚：在服务环境里设 ALLOW_SIMULATE=1（或删除该判断）。
  const ALLOW_SIMULATE = process.env.ALLOW_SIMULATE === '1'
  function _simulateGuard(res) {
    if (ALLOW_SIMULATE) return true
    res.status(403).json({
      ok: false,
      code: 'SIMULATE_DISABLED',
      error: '演示/注入接口已在生产环境关闭；如需启用，请在服务环境变量中显式设置 ALLOW_SIMULATE=1 并重启',
    })
    return false
  }

  // 演示/验证用：为指定通道注入一条「当前时间」的 AI 分析记录，触发摄像头图标告警
  app.post('/api/iot-analysis/simulate', async (req, res) => {
    if (!_simulateGuard(res)) return
    const spid = String(req.body?.spid || '')
    const channels = (_store && typeof _store.listIotChannels === 'function') ? _store.listIotChannels() : []
    const ch = channels.find(c => c.channelSipId === spid) || channels[0]
    if (!ch) return res.status(400).json({ error: '无已接入通道' })
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    // 模拟记录尽量附带一张真实图片，避免前端缩略图裂图
    let fallbackPicUrl = ''
    if (_store && typeof _store.queryWarnings === 'function') {
      const samples = _store.queryWarnings({ type: 'iot-video-analysis', limit: 1 })
      if (samples.length && samples[0].picUrl) fallbackPicUrl = samples[0].picUrl
    }
    const rec = {
      recordId: `sim-${Date.now()}`,
      deviceSipId: ch.deviceSipId,
      channelSipId: ch.channelSipId,
      channelSpid: ch.channelSipId,
      channelName: ch.channelName,
      deviceName: ch.deviceName,
      picUrl: fallbackPicUrl,
      analyseInfo: JSON.stringify([{ unsoilcover: 0.82 }]),
      createTime: createdAt,
    }
    const w = transformToWarning(rec)
    if (_store) _store.insertWarning(w)
    _lastRecordIds.add(rec.recordId)
    if (_log) _log.info(`[IoT] 模拟触发通道 [${ch.channelName}]，摄像头图标进入告警`)
    res.json({ ok: true, warning: w, status: getStatus() })
  })

  // 模拟走完「AI分析存档 → 智治推送结案」全流程（验证 AI 置信度范围/均值变量用）
  // 注入 N 张 AI 分析图（不同置信度）→ 聚合为带 memberIds 的一条事件 → 直插推送历史(pushed)
  // → 模拟城运回执(processing) → 一键结案(closed) → 生成结案 PDF。全程真实落库，跳过真实 HTTP 推送。
  app.post('/api/iot-analysis/simulate-closure', async (req, res) => {
    if (!_simulateGuard(res)) return
    try {
      if (!_store) return res.status(500).json({ error: '存储未就绪' })
      const channels = (typeof _store.listIotChannels === 'function') ? _store.listIotChannels() : []
      const spid = String(req.body?.spid || channels[0]?.channelSipId || '')
      const ch = channels.find(c => c.channelSipId === spid) || channels[0]
      if (!ch) return res.status(400).json({ error: '无已接入通道' })

      // 事件类型：默认「堆头未覆盖」（AI_TYPE_MAP.key=unsoilcover）
      const aiKey = 'unsoilcover'
      const aiTypeLabel = AI_TYPE_MAP[aiKey] || 'AI分析'
      const imageCount = Math.min(Math.max(parseInt(req.body?.count) || 5, 1), 20)

      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const createdAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

      // 取一张真实图片作缩略图，避免前端裂图
      let fallbackPicUrl = ''
      const samples = _store.queryWarnings({ type: 'iot-video-analysis', limit: 1 })
      if (samples.length && samples[0].picUrl) fallbackPicUrl = samples[0].picUrl

      // 1) 注入 N 张 AI 分析存档记录（每张不同置信度，铺开在 [0.76, 0.95]）
      const confs = []
      const memberIds = []
      for (let i = 0; i < imageCount; i++) {
        const conf = Number((0.76 + (0.95 - 0.76) * (i / Math.max(1, imageCount - 1))).toFixed(2))
        confs.push(conf)
        const recordId = `simc-${Date.now()}-${i}-${Math.floor(Math.random() * 1e4)}`
        const rec = {
          recordId,
          deviceSipId: ch.deviceSipId,
          channelSipId: ch.channelSipId,
          channelSpid: ch.channelSipId,
          channelName: ch.channelName,
          deviceName: ch.deviceName,
          picUrl: fallbackPicUrl,
          analyseInfo: JSON.stringify([{ [aiKey]: conf }]),
          createTime: createdAt,
        }
        const w = transformToWarning(rec)
        _store.insertWarning(w)
        _lastRecordIds.add(recordId)
        memberIds.push(w.id)
      }

      // 2) 聚合为一条带 memberIds 的推送事件（与前端 DashboardContext 推送 raw_json 同构）
      const geo = _channelGeo[ch.channelSipId] || {}
      const eventId = `simevt-${Date.now()}`
      const eventRaw = {
        memberIds,
        channelSipId: ch.channelSipId,
        channelSpid: ch.channelSipId,
        channelName: ch.channelName,
        deviceName: ch.deviceName,
        aiType: aiTypeLabel,
        event_type: aiTypeLabel,
      }
      _store.getDb().prepare(`INSERT INTO smart_push_events (id, event_type, location, lat, lon, level, value, standard, description, image_url, raw_json, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(eventId, aiTypeLabel, ch.channelName || '',
          typeof geo.lat === 'number' ? geo.lat : 30.731352,
          typeof geo.lon === 'number' ? geo.lon : 108.416972,
          3, '多张 AI 分析图像', '阈值 ≥50%',
          `模拟聚合：${imageCount} 张「${aiTypeLabel}」AI 分析图，置信度 ${Math.min(...confs)}~${Math.max(...confs)}`,
          '', JSON.stringify(eventRaw), 'iot-simulate', createdAt)

      // 3) 直插推送历史（跳过真实 HTTP 推送），状态 pushed
      const historyId = require('crypto').randomUUID()
      _store.getDb().prepare(`INSERT INTO smart_push_history (id, rule_id, plan_id, event_type, event_ids, location, trigger_count, api_url, api_method, request_body, response_status, response_body, success, error_message, created_at, status, platform_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(historyId, null, null, `（模拟）${aiTypeLabel}`, JSON.stringify([eventId]),
          ch.channelName || '', imageCount, 'SIMULATE-LOCAL', 'POST', JSON.stringify(eventRaw),
          200, '模拟推送成功', 1, null, createdAt, 'pushed', null)

      // 4) 模拟城运中心回执（受理中）
      _store.recordSmartPushCallback({
        pushId: historyId,
        status: 'processing',
        disposalResult: `经 AI 视频分析确认，${ch.channelName || '该通道'} 存在「${aiTypeLabel}」问题，已派单属地网格员现场核查处置。`,
        disposalOperator: '模拟坐席（演示）',
        disposalTime: createdAt,
        body: { simulated: true, source: 'iot-analysis-simulate-closure', event_type: aiTypeLabel, memberCount: imageCount },
      })

      // 5) 一键结案
      _store.closeSmartPushHistory(historyId, '模拟结案（演示）')

      // 6) 生成结案 PDF
      const reportRenderer = require('./report-renderer')
      const report = await reportRenderer.generateClosureReport(historyId)

      // 7) 取回置信度统计，便于前端即时提示
      const evt = _store.getDb().prepare('SELECT * FROM smart_push_events WHERE id = ?').get(eventId)
      const conf = _store.computeAiConfidenceStats([evt])

      if (_log) _log.info(`[IoT] 模拟结案流程完成：historyId=${historyId}, 图片=${imageCount}, conf=${JSON.stringify(conf)}`)
      res.json({
        ok: true,
        historyId,
        reportPath: report.path,
        reportUrl: `/api/smart-push/history/${historyId}/report`,
        eventType: `（模拟）${aiTypeLabel}`,
        imageCount,
        memberIds,
        conf,
      })
    } catch (e) {
      if (_log) _log.error(`[IoT] 模拟结案流程异常: ${e.message}\n${e.stack}`)
      res.status(500).json({ error: e.message })
    }
  })
}

// ── 首次种子迁移：iot_channels 表完全为空（含软删行）时，把硬编码 IOT.channels 写入一次 ──
function seedIfEmpty() {
  if (!_store || typeof _store.countIotChannelsAll !== 'function') return
  if (_store.countIotChannelsAll() > 0) return
  for (const ch of IOT.channels) {
    _store.upsertIotChannel({
      channelSipId: ch.spid, channelName: ch.name, deviceSipId: ch.deviceId,
      deviceName: '', streamId: ch.streamId, enabled: true, remark: '种子迁移',
    })
  }
  if (_log && IOT.channels.length) _log.info(`[IoT] 首次启动：已种子 ${IOT.channels.length} 条通道到 iot_channels 表`)
}

// ── T5: 启动时把「已见过的 recordId」加载进内存去重集合 ──
// 重启后若内存 Set 为空，IoTCloud 最近 20 条会被重新拉取，INSERT OR REPLACE 会把
// 已标记 handled 的记录打回 pending（"已处理告警复活"）。加载两个来源：
//   ① iot_record_seen 表（本次及历史运行留痕）
//   ② warnings 表既有 iot-video-analysis 历史记录（首次部署兼容旧数据）
// 同时清理 90 天前的留痕，防止去重表无限膨胀。
function loadSeenIds() {
  _lastRecordIds = new Set()
  try {
    const fromSeen = (_store && typeof _store.iotSeenAll === 'function') ? _store.iotSeenAll() : []
    const fromWarnings = (_store && typeof _store.getDb === 'function')
      ? (_store.getDb().prepare("SELECT json_extract(data_json,'$.recordId') rid FROM warnings WHERE warning_type='iot-video-analysis' AND json_extract(data_json,'$.recordId') IS NOT NULL").all().map(r => r.rid).filter(Boolean))
      : []
    _lastRecordIds = new Set([...fromSeen, ...fromWarnings])
    if (_lastRecordIds.size > 0 && _log) _log.info(`[IoT] 去重集加载完成: ${_lastRecordIds.size} 条历史 recordId`)
  } catch (e) {
    if (_log) _log.warn(`[IoT] 去重集加载失败(降级为仅内存去重): ${e.message}`)
    _lastRecordIds = new Set()
  }
  if (_store && typeof _store.iotSeenPrune === 'function') {
    try { _store.iotSeenPrune(90) } catch (e) { if (_log) _log.warn(`[IoT] 去重留痕清理失败: ${e.message}`) }
  }
}

// ── 启动 / 停止 ───────────────────────────────────────
function start(opts = {}) {
  _store = opts.store
  _log = opts.log || console
  const intervalMs = opts.intervalMs || 30000

  // 初始登录
  login().then(ok => {
    if (ok) {
      // 首次种子迁移（表为空时）
      seedIfEmpty()
      // T5: 启动即加载历史 recordId 去重集（重启不重复入库、不复活已处理告警）
      loadSeenIds()
      // 🔴 P1：启动即强刷一次 /meta/algo-types（权威算法字典），拿到后才开始拉数
      refreshMetaAlgoTypes(true).catch(() => {})
      // 解析通道→视频流地理坐标，并修正历史记录
      const channels = (_store && typeof _store.listIotChannels === 'function')
        ? _store.listIotChannels().filter(c => c.enabled) : []
      resolveChannelGeo(channels.map(c => ({ spid: c.channelSipId, name: c.channelName, streamId: c.streamId })))
      fixExistingRows()
      // 立即拉取一次
      fetchOnce()
      // 定时轮询（每轮从表热加载通道）
      _timer = setInterval(fetchOnce, intervalMs)
      _log.info(`[IoT] 启动成功，每 ${(intervalMs / 1000)}s 拉取一次（通道来源 iot_channels 表）`)
      _log.info(`[IoT] 算法字典来源: /meta/algo-types ${IOT_META_ENABLED ? '已启用' : '已禁用(IOT_META_ENABLED=0)'}`)
    } else {
      _log.error('[IoT] 启动失败：无法登录 IoTCloud')
    }
  })
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null }
  _token = ''
  _lastRecordIds.clear()
}

module.exports = {
  start, stop, registerRoutes, fetchOnce, IOT,
  // 图片 URL 归一（只对绝对 http(s) 套 /api/iot-image 代理，相对路径原样透传）
  // 供 index.js 的城运推送桥等处复用，保证全站同一口径。
  toDisplayImageUrl,
  // 🔴 P1 导出（供离线自检与运维观测）：
  //   _p1 是**测试专用**入口，业务代码请勿依赖其内部实现。
  _p1: {
    buildMetaAlgoMap,
    metaStatus,
    // 用当前已加载的字典走一遍完整解析链（等价于线上处理一条记录）
    parseAnalyseInfo,
    transformToWarning,
    resolveAiType,
    AI_TYPE_MAP,
    _setMetaMapForTest(map) { _metaAlgoMap = map || {}; _metaLoadedAt = Date.now(); _metaFailCount = 0 },
    _setAiTypeKeyMapForTest(map) { _aiTypeKeyMap = map || {} },
  },
}
