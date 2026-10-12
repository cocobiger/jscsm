/**
 * cyzx.js —— 「三级城运中心贯通」模块（批次 0 骨架）· 2026-10-11
 *
 * 定位：在驾驶舱后台「智治推送」栏目下，把 AI 事件贯通到**三级城运中心（事件中心）**。
 *
 * 设计原则（务必先读）：
 *   ① **纯新增、最小侵入**：本文件自建表、自管配置、自注册路由；
 *      index.js 只加 **1 行 require**（必须放在 adminOnly 定义之后，const TDZ 会崩进程）。
 *   ② **不改研判闸门**：`judgeWarning` / `isGateExemptWarning` / `queryWarningsAggregated` 一律不碰。
 *      改它们会同时改变**前台实时告警量**与 SSOT 口径。
 *   ③ **双口径 = 双路径**：
 *      · aggregate（聚合，如「堆头未覆盖」）→ 复用现有链：研判准入 + push_rules.action='front_and_push'
 *      · per_record（逐条，如「渣土车冒装」）→ **本模块独立的扫描式触发点，不经研判闸门**
 *      🔴 逐条**绝不能**复用现有推送钩子：冒装低位点（一天 1~2 条）永远攒不到
 *         「N 小时 ≥ M 条」阈值 ⇒ 会被静默 blocked ⇒ 永久漏推且前台看不出来。
 *   ④ **出站禁止兜底**：映射未命中 = 不上报（⛔ 不像入站那样 `|| '未知事件N'`）。
 *        错码值进政府系统且事件单难以撤回。
 *   ⑤ **配置真源在 DB（kv_config）**，env 只作首次初始化。后台填完即生效，**无需重启**。
 *   ⑥ 时间一律**上海时 UTC+8**（getUTC* + 8h），禁用 toLocaleString / 本地时区。
 *
 * 命名隔离（🔴）：
 *   `CHENGYUN_EVENT_TYPE_MAP`（store-db.js）是**入站**映射（全景平台 → 我方），语义不可复用；
 *   本模块一律用 **CYZX_** 前缀。
 *
 * 批次划分：
 *   批次 0（本文件当前实现）：表 / 配置 / 映射 / 码表 / 自检 / dry-run / 逐条触发点骨架（**不发送**）
 *   批次 1：灌码表 + 连通性 + 灰度
 *   批次 2：上报器（4.1/4.7）+ 入站接收（4.2）+ 处置工作台 + 反馈（4.3/4.8）+ 查询（4.4）
 *   批次 2.5：上报前门控 + 「应推未推」对账告警
 *   批次 3：4.9 / 4.10 / 4.11 / 4.5 / 4.12 / 4.13
 */
'use strict'

// ════════════════════════════════════════════════════════════
//  常量
// ════════════════════════════════════════════════════════════
const KV_CONFIG = 'cyzx_config'
const KV_ENUMS = 'cyzx_enums'

/** 上报模式：inherit=跟随全局缺省 · eventReport=4.1 派单闭环 · selfReport=4.7 自闭环 */
const REPORT_MODES = ['inherit', 'eventReport', 'selfReport']
/** 上报口径：aggregate=聚合事件 · per_record=逐条直出 */
const GRANULARITIES = ['aggregate', 'per_record']
/** 逐条口径的上报前门控（批次 2.5 会补全，此处先实现 off / min_confidence 两种） */
const PER_RECORD_GATES = ['off', 'min_confidence', 'review', 'llm']

/** 配置默认值。库里没有该键时用它，并在首次写入时落库（此后 DB 是唯一真源）。 */
const DEFAULT_CONFIG = {
  enabled: false,                 // 🔴 总开关，默认关
  baseUrl: '',                    // 业务协同网关地址（城运给）
  sourceSystemCode: '',           // 应用识别码（三级平台分配）
  reportModeDefault: 'eventReport', // 映射表 report_mode='inherit' 时用它
  authMode: 'none',               // none | token | sign
  token: '',                      // 🔴 GET 只回掩码，不下发明文
  eventNature: '1',               // 1测试 / 2演练 / 3正常（联调期=1）
  isTest: true,                   // 联调期 true
  coordMode: '84',                // 84 | 2000（按城运答复）
  callbackUrl: '',                // 我方接收地址（注册给城运的 4.2/4.5/4.12/4.13）
  timeoutMs: 10000,
  retry: 3,
  // ── 逐条口径 ──
  perRecordEnabled: false,        // 逐条扫描器开关（独立于总开关）
  perRecordIntervalMs: 30000,     // 扫描周期
  perRecordLookbackH: 6,          // 每次回看窗口（小时）
  perRecordBatch: 200,            // 单次最多处理条数
  perRecordGate: 'off',           // off | min_confidence | review | llm
  perRecordGateConf: 0.8,         // perRecordGate='min_confidence' 时的阈值（0~1）
  llmUrl: '',                     // 空 ⇒ 用 env CYZX_LLM_URL 或默认 http://127.0.0.1:11434
  llmModel: 'qwen2.5vl:7b',
  llmTimeoutMs: 25000,
  // ── 4.11 撤销（Q5 决策：复核判定为 AI 误报 ⇒ 自动撤销）──
  cancelOnReviewFalse: true,      // 复核结论 review='false'（误报）⇒ 自动撤销已上报的事件单
  systemYkzUserId: '',            // ⛔ 待城运给：撤销接口必传的渝快政人员ID
  systemYkzUserName: '驾驶舱系统（自动撤销）',
  cancelReasonTemplate: 'AI识别复核确认为误报，撤销该事件单',
  // ── 4.9 附件下载落地目录（相对 __dirname/data）──
  fileDownloadDir: 'cyzx-files',
  // ── 聚合口径 ──
  aggregateRuleHint: '需把对应 push_rules.action 改为 front_and_push，否则永不推送',
  // ── 验收状态 ──
  connectTest: null,              // { at, ok, httpStatus, ms, error }
  updatedAt: null,
  updatedBy: null,
}

/** 未映射 / 未就绪类型的计数（供自检与告警，避免"静默不报"） */
const counters = {
  scanned: 0,          // 逐条扫描累计命中
  loggedPending: 0,    // 写入待上报记录数
  skippedUnmapped: 0,  // 因未映射/未就绪被跳过
  skippedGate: 0,      // 被上报前门控拦下
  lastScanAt: null,
  lastScanHit: 0,
  lastError: null,
}

// ════════════════════════════════════════════════════════════
//  工具
// ════════════════════════════════════════════════════════════
/** 上海时 'YYYY-MM-DD HH:mm:ss'，禁用 toLocaleString / 本地时区。 */
function shNow(ms) {
  const d = new Date((ms === undefined || ms === null) ? Date.now() : ms)
  const t = new Date(d.getTime() + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
         `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
}
/** 上海时 → epoch(ms)。兼容 'YYYY-MM-DD HH:mm:ss'（无时区，按 +08:00）、ISO/Z、带偏移 ISO。 */
function shParse(v) {
  const s = String(v || '').trim()
  if (!s) return NaN
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const t = s.length === 16 ? s + ':00' : s
    return Date.parse(t.replace(' ', 'T') + '+08:00')
  }
  let t = s.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) t += ':00'
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(t)) t += '+08:00'
  return Date.parse(t)
}
/** 任意时间值 → 上海时字符串（无法解析返回空串，由校验层报错，不静默兜底成"现在"）。 */
function toShStr(v) {
  const ms = shParse(v)
  return Number.isFinite(ms) ? shNow(ms) : ''
}
function maskSecret(s) {
  const v = String(s || '')
  if (!v) return ''
  if (v.length <= 6) return '******'
  return v.slice(0, 3) + '******' + v.slice(-2)
}
/** 宽松 CSV/TSV 解析：自动识别分隔符（英文逗号 / 制表符），跳过表头与空行。 */
function parseTable(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!raw) return []
  const lines = raw.split('\n').filter(l => l.trim())
  const delim = (lines[0].split('\t').length > lines[0].split(',').length) ? '\t' : ','
  const rows = lines.map(l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, '')))
  return rows
}
function isHeaderRow(cells) {
  const h = (cells[0] || '')
  return /^(我方类型|ai_type|参数名|参数描述|区划码|code|orgid|org_id|编号)$/i.test(h)
}
function nowIso() { return new Date().toISOString() }
function tryJson(s) { try { return JSON.parse(s) } catch { return null } }

// ════════════════════════════════════════════════════════════
//  建表（幂等）
// ════════════════════════════════════════════════════════════
function ensureSchema(store, log) {
  const db = store.getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS cyzx_eventtype_map (
      ai_type       TEXT PRIMARY KEY,          -- 我方 ai_types.name（唯一关联口径）
      source_key    TEXT NOT NULL DEFAULT '',  -- 我方算法 key（辅助核对）
      cy_lv1        TEXT NOT NULL DEFAULT '',  -- 城运一级目录（人读）
      cy_lv2        TEXT NOT NULL DEFAULT '',  -- 城运二级目录
      cy_lv3        TEXT NOT NULL DEFAULT '',  -- 城运三级目录
      cy_event_type TEXT NOT NULL DEFAULT '',  -- 城运 eventType 码值（唯一上报值）⛔待城运给
      report_mode   TEXT NOT NULL DEFAULT 'inherit',   -- inherit | eventReport | selfReport
      granularity   TEXT NOT NULL DEFAULT 'aggregate', -- aggregate | per_record
      scene_code    TEXT NOT NULL DEFAULT '',  -- selfReport 必需：预案编目编码（YABM 开头）
      enabled       INTEGER NOT NULL DEFAULT 0,-- 🔴 默认关：码值到齐 + 人工确认后才置 1
      note          TEXT NOT NULL DEFAULT '',
      created_at    TEXT,
      updated_at    TEXT
    );
    CREATE TABLE IF NOT EXISTS cyzx_area_code (
      code        TEXT PRIMARY KEY,            -- 行政区划码
      name        TEXT NOT NULL DEFAULT '',
      level       TEXT NOT NULL DEFAULT '',    -- county | street | community | grid
      parent_code TEXT NOT NULL DEFAULT '',
      updated_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS cyzx_org_code (
      org_id     TEXT PRIMARY KEY,             -- 渝快政组织机构 ID
      name       TEXT NOT NULL DEFAULT '',
      type       TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS cyzx_report_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_num       TEXT NOT NULL UNIQUE,    -- 🔴 幂等键（逐条='cyzx-<warningId>'）
      warning_id      TEXT,
      ai_type         TEXT NOT NULL DEFAULT '',
      cy_event_type   TEXT NOT NULL DEFAULT '',
      report_mode     TEXT NOT NULL DEFAULT '',
      granularity     TEXT NOT NULL DEFAULT '',
      member_ids      TEXT NOT NULL DEFAULT '[]',
      request_body    TEXT,
      response_status INTEGER,
      response_body   TEXT,
      success         INTEGER NOT NULL DEFAULT 0,
      state           TEXT NOT NULL DEFAULT 'pending', -- pending|sent|failed|skipped
      skip_reason     TEXT,
      retry_count     INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT,
      updated_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cyzx_log_created ON cyzx_report_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_cyzx_log_state   ON cyzx_report_log(state);
  `)
  // 老库补列（幂等；本模块首次上线即新表，此处只为将来加列留位）
  for (const [col, ddl] of [
    ['scene_code', "TEXT NOT NULL DEFAULT ''"],
    ['report_mode', "TEXT NOT NULL DEFAULT 'inherit'"],
    ['granularity', "TEXT NOT NULL DEFAULT 'aggregate'"],
  ]) {
    try {
      const cols = db.prepare('PRAGMA table_info(cyzx_eventtype_map)').all().map(c => String(c.name))
      if (!cols.includes(col)) db.exec(`ALTER TABLE cyzx_eventtype_map ADD COLUMN ${col} ${ddl};`)
    } catch (e) { if (log) log.warn(`[cyzx] 补列 ${col} 失败: ${e.message}`) }
  }
  return true
}

// ════════════════════════════════════════════════════════════
//  种子映射（28 行；**enabled 全 0、码值全空** —— 要等城运给码表）
// ════════════════════════════════════════════════════════════
const SEED_MAP = [
  ['渣土车冒装', 'cover_det', '城市管理', '渣土运输', '渣土车冒装', 'per_record', '判罚证据类；逐条直出（决策 Q3）'],
  ['渣土车帽盖', 'cover_det', '城市管理', '渣土运输', '渣土车冒装', 'per_record', '口语别名，通常与「渣土车冒装」合并'],
  ['车辆冒装', '', '城市管理', '渣土运输', '渣土车冒装', 'per_record', '全景平台 eventType=16；待确认是否同码'],
  ['堆头未覆盖', 'unsoilcover', '生态环保', '扬尘治理', '物料堆场未覆盖', 'aggregate', '决策 Q3：走聚合（现有 24h≥M 链路）'],
  ['裸土未覆盖', 'uncovered', '生态环保', '扬尘治理', '裸露地未覆盖', 'aggregate', ''],
  ['堆场扬尘', '', '生态环保', '扬尘治理', '堆场扬尘', 'aggregate', ''],
  ['道路扬尘', '', '生态环保', '扬尘治理', '道路扬尘', 'aggregate', ''],
  ['扬尘', '', '生态环保', '扬尘治理', '扬尘', 'aggregate', '全景平台 eventType=7'],
  ['秸秆燃烧', '', '生态环保', '露天焚烧', '秸秆焚烧', 'aggregate', ''],
  ['烟火检测', 'fire', '生态环保', '露天焚烧', '烟（火）点', 'aggregate', ''],
  ['生物质燃烧', '', '生态环保', '露天焚烧', '生物质燃烧', 'aggregate', '全景平台 eventType=5'],
  ['烟囱烟雾', '', '生态环保', '工业排放', '烟囱冒黑烟', 'aggregate', '全景平台 eventType=6'],
  ['烟尘', '', '生态环保', '工业排放', '烟尘', 'aggregate', '全景平台 eventType=3'],
  ['工业烟羽', '', '生态环保', '工业排放', '工业烟羽', 'aggregate', '全景平台 eventType=17'],
  ['违规排污', '', '生态环保', '水环境', '违规排污', 'aggregate', ''],
  ['侵占岸线与水面漂浮物', '', '生态环保', '水环境', '岸线侵占·水面漂浮物', 'aggregate', ''],
  ['水位异常', 'water', '生态环保', '水环境', '水位异常', 'aggregate', ''],
  ['固废与危废违规倾倒', '', '生态环保', '固废', '违规倾倒', 'aggregate', ''],
  ['固废运输违规', '', '生态环保', '固废', '运输违规', 'aggregate', ''],
  ['垃圾堆积', 'garbage', '城市管理', '市容环卫', '垃圾堆积', 'aggregate', ''],
  ['人员入侵', 'person', '城市管理', '秩序管理', '人员入侵', 'aggregate', '全景平台 eventType=8'],
  ['车辆违停', 'vehicle', '城市管理', '交通秩序', '车辆违停', 'aggregate', ''],
  ['建渣未覆盖', '', '城市管理', '渣土运输', '建渣未覆盖', 'aggregate', '全景平台 eventType=12'],
  ['车辆遗撒', '', '城市管理', '渣土运输', '车辆遗撒', 'aggregate', '全景平台 eventType=11'],
  ['卡车脏车', '', '城市管理', '渣土运输', '脏车', 'aggregate', '全景平台 eventType=9'],
  ['脏车', '', '城市管理', '渣土运输', '脏车', 'aggregate', '全景平台 eventType=10'],
  ['工程车作业', '', '城市管理', '工地管理', '工程车作业', 'aggregate', '全景平台 eventType=1'],
  ['工程车数量', '', '城市管理', '工地管理', '工程车数量', 'aggregate', '全景平台 eventType=2'],
]

function seedMapIfNeeded(store, log) {
  try {
    const db = store.getDb()
    const stmt = db.prepare(`INSERT OR IGNORE INTO cyzx_eventtype_map
      (ai_type, source_key, cy_lv1, cy_lv2, cy_lv3, cy_event_type, report_mode, granularity, scene_code, enabled, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    const t = nowIso()
    let n = 0
    for (const [ai, key, l1, l2, l3, gran, note] of SEED_MAP) {
      // ⚠️ cy_event_type 一律留空：码值只能来自城运官方码表，**绝不猜**
      const r = stmt.run(ai, key || '', l1, l2, l3, '', 'inherit', gran, '', 0, note || '', t, t)
      n += (r && r.changes) || 0
    }
    if (n > 0 && log) log.info(`[cyzx] 已灌入种子映射 ${n} 行（码值为空、enabled=0，等城运码表）`)
    return n
  } catch (e) {
    if (log) log.error(`[cyzx] 种子映射失败（不影响启动）: ${e.message}`)
    return 0
  }
}

// ════════════════════════════════════════════════════════════
//  配置读写（10s 缓存 + 写即失效 ⇒ 后台填完即生效，无需重启）
// ════════════════════════════════════════════════════════════
const CFG_TTL_MS = 10 * 1000
let _cfg = null
let _cfgAt = 0
let _cfgVersion = 0

/** env 兜底：**只在库里没有该键时**用一次（之后 DB 是唯一真源，避免"改了 env 没改库"的分叉）。 */
function envSeed() {
  const e = {}
  if (process.env.CYZX_BASE_URL) e.baseUrl = String(process.env.CYZX_BASE_URL).trim()
  if (process.env.CYZX_SOURCE_SYSTEM_CODE) e.sourceSystemCode = String(process.env.CYZX_SOURCE_SYSTEM_CODE).trim()
  if (process.env.CYZX_TOKEN) e.token = String(process.env.CYZX_TOKEN).trim()
  if (process.env.CYZX_ENABLED === '1') e.enabled = true
  return e
}

function getConfig(store, force) {
  const now = Date.now()
  if (!force && _cfg && (now - _cfgAt) < CFG_TTL_MS) return _cfg
  let raw = null
  try { raw = store.kvGet(KV_CONFIG, null) } catch { raw = null }
  const fromDb = (raw && typeof raw === 'object') ? raw : null
  _cfg = Object.assign({}, DEFAULT_CONFIG, fromDb || envSeed())
  _cfg._source = fromDb ? 'db' : (Object.keys(envSeed()).length ? 'env(未落库)' : 'default')
  _cfgAt = now
  return _cfg
}
function setConfig(store, patch, who) {
  const cur = getConfig(store, true)
  const next = Object.assign({}, cur, patch || {})
  next.updatedAt = shNow()
  next.updatedBy = who || '?'
  // 类型护栏：这些键必须是布尔 / 数字，避免前端传字符串导致"配了不生效"
  for (const k of ['enabled', 'isTest', 'perRecordEnabled']) next[k] = (next[k] === true || next[k] === 'true' || next[k] === 1 || next[k] === '1')
  for (const k of ['timeoutMs', 'retry', 'perRecordIntervalMs', 'perRecordLookbackH', 'perRecordBatch']) {
    const n = Number(next[k]); next[k] = Number.isFinite(n) ? n : DEFAULT_CONFIG[k]
  }
  next.perRecordGateConf = Number(next.perRecordGateConf)
  if (!Number.isFinite(next.perRecordGateConf)) next.perRecordGateConf = DEFAULT_CONFIG.perRecordGateConf
  if (!REPORT_MODES.includes(next.reportModeDefault)) next.reportModeDefault = DEFAULT_CONFIG.reportModeDefault
  if (!PER_RECORD_GATES.includes(next.perRecordGate)) next.perRecordGate = DEFAULT_CONFIG.perRecordGate
  store.kvSet(KV_CONFIG, next)
  _cfg = next; _cfgAt = Date.now(); _cfgVersion++   // 写即失效
  return next
}
function configVersion() { return _cfgVersion }
function publicConfig(store) {
  const c = getConfig(store, true)
  return Object.assign({}, c, { token: maskSecret(c.token), tokenSet: !!c.token })
}

// ════════════════════════════════════════════════════════════
//  映射 / 码表 CRUD
// ════════════════════════════════════════════════════════════
/** 映射列表：与我方 ai_types 左连接，标出「我方有但未映射」的项 ⇒ 前端置顶标红 */
function listEventTypeMap(store) {
  const db = store.getDb()
  const rows = db.prepare('SELECT * FROM cyzx_eventtype_map').all()
  const byAi = new Map(rows.map(r => [String(r.ai_type), r]))
  let aiTypes = []
  try { aiTypes = store.listAiTypes() || [] } catch { aiTypes = [] }
  const out = aiTypes.map(t => {
    const r = byAi.get(String(t.name))
    if (r) { byAi.delete(String(t.name)); return shapeMap(r) }
    return {
      ai_type: t.name, source_key: t.sourceKey || '', cy_lv1: '', cy_lv2: '', cy_lv3: '',
      cy_event_type: '', report_mode: 'inherit', granularity: 'aggregate', scene_code: '',
      enabled: 0, note: '', mapped: false, ready: false,
    }
  })
  // 我方 ai_types 里没有、但映射表里有的（历史/改名残留）也返回，避免"看不见的死行"
  for (const r of byAi.values()) out.push(shapeMap(r))
  // 未映射 & 未就绪的排前面，便于后台先处理
  out.sort((a, b) => (a.ready === b.ready) ? String(a.ai_type).localeCompare(String(b.ai_type), 'zh') : (a.ready ? 1 : -1))
  return out
}
function shapeMap(r) {
  return {
    ai_type: r.ai_type, source_key: r.source_key || '', cy_lv1: r.cy_lv1, cy_lv2: r.cy_lv2, cy_lv3: r.cy_lv3,
    cy_event_type: r.cy_event_type || '', report_mode: r.report_mode || 'inherit',
    granularity: r.granularity || 'aggregate', scene_code: r.scene_code || '',
    enabled: !!r.enabled, note: r.note || '', mapped: true,
    ready: !!(r.enabled && r.cy_event_type),   // 🔴 可上报 = 启用 且 码值非空
    created_at: r.created_at, updated_at: r.updated_at,
  }
}
/** 行输入归一（供单条 upsert 与批量导入共用） */
function normMapRow(b) {
  const aiType = String(b.ai_type ?? b.aiType ?? '').trim()
  if (!aiType) throw new Error('ai_type 必填')
  let rm = String(b.report_mode ?? b.reportMode ?? 'inherit').trim()
  if (!REPORT_MODES.includes(rm)) rm = 'inherit'
  let gr = String(b.granularity ?? '').trim()
  if (!GRANULARITIES.includes(gr)) gr = 'aggregate'
  return {
    ai_type: aiType,
    source_key: String(b.source_key ?? b.sourceKey ?? '').trim(),
    cy_lv1: String(b.cy_lv1 ?? '').trim(),
    cy_lv2: String(b.cy_lv2 ?? '').trim(),
    cy_lv3: String(b.cy_lv3 ?? '').trim(),
    cy_event_type: String(b.cy_event_type ?? b.cyEventType ?? '').trim(),
    report_mode: rm,
    granularity: gr,
    scene_code: String(b.scene_code ?? b.sceneCode ?? '').trim(),
    enabled: (b.enabled === true || b.enabled === 1 || b.enabled === '1' || b.enabled === 'true') ? 1 : 0,
    note: String(b.note ?? '').trim(),
  }
}
function upsertEventTypeMap(store, body, partial) {
  const db = store.getDb()
  const row = normMapRow(body)
  // 🔴 默认**局部更新**（partial=true）：只改传了的字段。
  //   "整行覆盖"极易把后台已填好的三级目录/口径清空，必须显式传 partial:false。
  const isPartial = (partial === undefined || partial === null) ? true : !!partial
  const t = nowIso()
  const cur = db.prepare('SELECT * FROM cyzx_eventtype_map WHERE ai_type = ?').get(row.ai_type)
  if (!cur) {
    db.prepare(`INSERT INTO cyzx_eventtype_map
      (ai_type, source_key, cy_lv1, cy_lv2, cy_lv3, cy_event_type, report_mode, granularity, scene_code, enabled, note, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.ai_type, row.source_key, row.cy_lv1, row.cy_lv2, row.cy_lv3, row.cy_event_type,
        row.report_mode, row.granularity, row.scene_code, row.enabled, row.note, t, t)
    return { created: true, item: shapeMap(db.prepare('SELECT * FROM cyzx_eventtype_map WHERE ai_type = ?').get(row.ai_type)) }
  }
  // 局部更新：partial=true 时未传字段保持原值（前端只改「码值 / 启用」时不会清空目录）
  const sent = (k, alt) => (body[k] !== undefined) || (alt && body[alt] !== undefined)
  const next = isPartial ? {
    source_key: sent('source_key', 'sourceKey') ? row.source_key : cur.source_key,
    cy_lv1: sent('cy_lv1') ? row.cy_lv1 : cur.cy_lv1,
    cy_lv2: sent('cy_lv2') ? row.cy_lv2 : cur.cy_lv2,
    cy_lv3: sent('cy_lv3') ? row.cy_lv3 : cur.cy_lv3,
    cy_event_type: sent('cy_event_type', 'cyEventType') ? row.cy_event_type : cur.cy_event_type,
    report_mode: sent('report_mode', 'reportMode') ? row.report_mode : cur.report_mode,
    granularity: sent('granularity') ? row.granularity : cur.granularity,
    scene_code: sent('scene_code', 'sceneCode') ? row.scene_code : cur.scene_code,
    enabled: sent('enabled') ? row.enabled : cur.enabled,
    note: sent('note') ? row.note : cur.note,
  } : row
  db.prepare(`UPDATE cyzx_eventtype_map SET source_key=?, cy_lv1=?, cy_lv2=?, cy_lv3=?, cy_event_type=?,
      report_mode=?, granularity=?, scene_code=?, enabled=?, note=?, updated_at=? WHERE ai_type=?`)
    .run(next.source_key, next.cy_lv1, next.cy_lv2, next.cy_lv3, next.cy_event_type,
      next.report_mode, next.granularity, next.scene_code, next.enabled ? 1 : 0, next.note, t, row.ai_type)
  return { created: false, item: shapeMap(db.prepare('SELECT * FROM cyzx_eventtype_map WHERE ai_type = ?').get(row.ai_type)) }
}
function deleteEventTypeMap(store, aiType) {
  const db = store.getDb()
  return db.prepare('DELETE FROM cyzx_eventtype_map WHERE ai_type = ?').run(String(aiType || '').trim()).changes
}
/**
 * 批量导入映射（后台"粘贴导入"）。
 * 列顺序：我方类型[,算法key],一级,二级,三级,码值[,报告模式][,口径][,场景码][,启用][,备注]
 * 也接受带表头（`我方类型,...`）的行，自动跳过。
 * ⚠️ 只覆盖**传了值**的字段；空字符串=清空该字段（这是导入的显式语义）。
 */
function bulkImportEventTypeMap(store, text) {
  const rows = parseTable(text)
  const result = { total: 0, created: 0, updated: 0, failed: [], enabledRows: 0 }
  for (const cells of rows) {
    if (!cells.length || !cells[0] || isHeaderRow(cells)) continue
    result.total++
    try {
      const body = {
        ai_type: cells[0], source_key: cells[1], cy_lv1: cells[2], cy_lv2: cells[3], cy_lv3: cells[4],
        cy_event_type: cells[5], report_mode: cells[6], granularity: cells[7], scene_code: cells[8],
        enabled: cells[9], note: cells[10],
      }
      const r = upsertEventTypeMap(store, body, false)
      r.created ? result.created++ : result.updated++
      if (r.item && r.item.ready) result.enabledRows++
    } catch (e) {
      result.failed.push({ row: cells.join(','), error: e.message })
    }
  }
  return result
}
function listAreas(store, limit) {
  return store.getDb().prepare('SELECT * FROM cyzx_area_code ORDER BY code LIMIT ?').all(Number(limit) || 2000)
}
function bulkImportAreas(store, text) {
  const rows = parseTable(text)
  const db = store.getDb()
  const stmt = db.prepare('INSERT OR REPLACE INTO cyzx_area_code (code, name, level, parent_code, updated_at) VALUES (?,?,?,?,?)')
  const t = nowIso(); let n = 0
  for (const c of rows) {
    if (!c[0] || isHeaderRow(c)) continue
    stmt.run(c[0], c[1] || '', c[2] || '', c[3] || '', t); n++
  }
  return { imported: n, total: db.prepare('SELECT COUNT(*) c FROM cyzx_area_code').get().c }
}
function listOrgs(store, limit) {
  return store.getDb().prepare('SELECT * FROM cyzx_org_code ORDER BY org_id LIMIT ?').all(Number(limit) || 2000)
}
function bulkImportOrgs(store, text) {
  const rows = parseTable(text)
  const db = store.getDb()
  const stmt = db.prepare('INSERT OR REPLACE INTO cyzx_org_code (org_id, name, type, updated_at) VALUES (?,?,?,?)')
  const t = nowIso(); let n = 0
  for (const c of rows) {
    if (!c[0] || /^(orgid|org_id|参数名)$/i.test(c[0])) continue
    stmt.run(c[0], c[1] || '', c[2] || '', t); n++
  }
  return { imported: n, total: db.prepare('SELECT COUNT(*) c FROM cyzx_org_code').get().c }
}

// ════════════════════════════════════════════════════════════
//  配置自检（8 条）—— "填过了" ≠ "能跑"
// ════════════════════════════════════════════════════════════
/** 状态：pass 通过 · fail 阻断 · warn 影响 · unknown 无法判定（**不得当成通过**） */
function healthCheck(store) {
  const db = store.getDb()
  const cfg = getConfig(store, true)
  const items = []
  const add = (id, name, status, detail, hint) => items.push({ id, name, status, detail, hint: hint || '' })

  // ① 总开关
  add('enabled', '总开关', cfg.enabled ? 'pass' : 'fail',
    cfg.enabled ? '已开启' : '未开启', '联调通过后再开')

  // ② 网关地址
  const ct = cfg.connectTest
  add('baseUrl', '网关地址', !cfg.baseUrl ? 'fail' : (ct && ct.ok ? 'pass' : 'warn'),
    !cfg.baseUrl ? '未填写' : (ct ? `上次测试 ${ct.ok ? '成功' : '失败'}（${ct.at}${ct.httpStatus ? ' HTTP ' + ct.httpStatus : ''}${ct.ms ? ' ' + ct.ms + 'ms' : ''}）` : '已填写，但尚未做连通性测试'),
    '点卡片 1 的「连通性测试」')

  // ③ 应用识别码
  add('sourceSystemCode', '应用识别码', cfg.sourceSystemCode ? 'pass' : 'fail',
    cfg.sourceSystemCode ? '已填写' : '未填写（城运分配）', '')

  // ④ 至少 1 条可上报映射（启用 且 码值非空）
  const ready = db.prepare("SELECT COUNT(*) c FROM cyzx_eventtype_map WHERE enabled = 1 AND cy_event_type <> ''").get().c
  const mapped = db.prepare("SELECT COUNT(*) c FROM cyzx_eventtype_map WHERE cy_event_type <> ''").get().c
  add('mapReady', '可上报事件类型', ready > 0 ? 'pass' : 'fail',
    `可上报 ${ready} 个 / 已填码值 ${mapped} 个 / 共 ${db.prepare('SELECT COUNT(*) c FROM cyzx_eventtype_map').get().c} 行`,
    '需「启用=1」且「码值非空」同时满足')

  // ⑤ 自闭环类型必须配 sceneCode
  const selfRows = db.prepare("SELECT ai_type FROM cyzx_eventtype_map WHERE report_mode = 'selfReport' AND enabled = 1 AND (scene_code IS NULL OR scene_code = '')").all()
  add('sceneCode', '自闭环 sceneCode', selfRows.length === 0 ? 'pass' : 'fail',
    selfRows.length === 0 ? '无需补（或已配齐）' : `${selfRows.length} 个自闭环类型缺 scene_code：${selfRows.map(r => r.ai_type).join('、')}`,
    'sceneCode=预案编目编码（YABM 开头）')

  // ⑥ 区划码表
  const areaCnt = db.prepare('SELECT COUNT(*) c FROM cyzx_area_code').get().c
  add('areaCode', '行政区划码表', areaCnt > 0 ? 'pass' : 'fail',
    areaCnt > 0 ? `已导入 ${areaCnt} 条` : '未导入（belongCounty/belongStreet 必传且强校验）',
    '卡片 3 粘贴城运区划码表')

  // ⑦ 渝快政组织码表
  const orgCnt = db.prepare('SELECT COUNT(*) c FROM cyzx_org_code').get().c
  add('orgCode', '渝快政组织码表', orgCnt > 0 ? 'pass' : 'warn',
    orgCnt > 0 ? `已导入 ${orgCnt} 条` : '未导入（suggestDealUnit/copyToUnit 需要；不填则不传该字段）',
    '卡片 4 粘贴 orgId 码表')

  // ⑧ 事件等级映射（enums）
  const enums = (() => { try { return store.kvGet(KV_ENUMS, null) } catch { return null } })()
  add('levelMap', '事件等级映射', enums && enums.eventLevel ? 'pass' : 'warn',
    enums && enums.eventLevel ? '已配置' : '未配置（默认按 0 一般 上报）', '可在卡片 1 配置')

  // ⑨ 对账缺口（排期 2.5-2：把「应推未推」变成可见告警，而不是只在「上报记录」页里躺着）
  try {
    const rc = reconcile(store, 24)
    const bad = rc.gap > 0
    add('reconcile', '近24h对账缺口', bad ? 'fail' : 'pass',
      `应推 ${rc.should} / 已推 ${rc.sent} / 缺口 ${rc.gap} · 配置未就绪被跳过 ${rc.skippedByConfig}`,
      bad ? '有应推未推的记录 → 去「上报记录」按「只看问题」排查' : '')
  } catch (e) {
    add('reconcile', '近24h对账缺口', 'warn', `对账失败：${e.message}`, '')
  }

  const fail = items.filter(i => i.status === 'fail').length
  const warn = items.filter(i => i.status === 'warn').length
  return {
    ok: fail === 0,
    summary: { fail, warn, pass: items.filter(i => i.status === 'pass').length, total: items.length },
    items,
    counters: Object.assign({}, counters),
    version: configVersion(),
    checkedAt: shNow(),
  }
}

// ════════════════════════════════════════════════════════════
//  报文组装 + 校验（dry-run 用；批次 2 的发送器复用同一组装函数）
// ════════════════════════════════════════════════════════════
/** 取一条 warning（含被研判拦下的），返回解析后的对象 */
function getWarning(store, id) {
  const r = store.getDb().prepare('SELECT id, created_at, status, data_json FROM warnings WHERE id = ?').get(String(id || ''))
  if (!r) return null
  const o = tryJson(r.data_json) || {}
  o.id = r.id
  if (!o.createdAt) o.createdAt = r.created_at
  return o
}
/** 取最近一条「已映射且启用」的类型对应的告警（dry-run 没指定 id 时用） */
function pickLatestWarningFor(store, aiType) {
  const db = store.getDb()
  const rows = db.prepare("SELECT id, data_json FROM warnings WHERE COALESCE(json_extract(data_json,'$.aiType'),'') = ? ORDER BY rowid DESC LIMIT 1").all(aiType)
  return rows.length ? getWarning(store, rows[0].id) : null
}
/** 区划解析：用码表反查名称包含关系（城运码表到位后由批次 2.5 换成地址服务） */
function resolveArea(store, locStr) {
  const db = store.getDb()
  const s = String(locStr || '')
  if (!s) return { county: null, street: null }
  const hit = (level) => {
    const rows = db.prepare("SELECT code, name FROM cyzx_area_code WHERE level = ?").all(level)
    return rows.find(r => r.name && s.includes(r.name)) || null
  }
  const county = hit('county')
  let street = null
  if (county) {
    // 🔴 必须带上 county.code：漏参数会静默返回空集（曾在本地单测中被抓出）
    const rows = db.prepare('SELECT code, name, parent_code FROM cyzx_area_code WHERE level = ? AND parent_code = ?').all('street', county.code)
    street = rows.find(r => r.name && s.includes(r.name)) || null
  }
  return { county, street, streetInCounty: !!(street && county && street.parent_code === county.code) }
}
/**
 * 组装 4.1 事件单上报报文（**只组装、不发送**）。
 * @returns {{ payload, checks, missing, ready }}
 */
function buildEventReportPayload(store, w, opts) {
  const cfg = getConfig(store, true)
  const db = store.getDb()
  const map = db.prepare('SELECT * FROM cyzx_eventtype_map WHERE ai_type = ?').get(String(w.aiType || ''))
  const checks = []
  const missing = []
  const chk = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: detail || '' }); if (!ok) missing.push(name) }

  chk('映射存在', !!map, map ? '' : `aiType「${w.aiType || '?'}」不在映射表`)
  chk('映射已启用', !!(map && map.enabled), map && map.enabled ? '' : 'enabled=0（未确认）')
  chk('码值非空', !!(map && map.cy_event_type), (map && map.cy_event_type) ? map.cy_event_type : '城运 eventType 码值未填')
  chk('应用识别码', !!cfg.sourceSystemCode, cfg.sourceSystemCode ? '' : 'sourceSystemCode 未配')
  chk('网关地址', !!cfg.baseUrl, cfg.baseUrl || 'baseUrl 未配')

  const happenTime = toShStr(w.createdAt || w.time)
  chk('事发时间可解析', !!happenTime, happenTime || `createdAt 无法解析：${w.createdAt || ''}`)
  // 🔴 城运硬规则：happenTime 不得大于上报时间
  const nowSh = shNow()
  chk('事发时间 ≤ 上报时间', !!happenTime && String(happenTime) <= nowSh, `${happenTime || '-'} ≤ ${nowSh}`)

  const lon = Number(w.lon), lat = Number(w.lat)
  const hasLonLat = Number.isFinite(lon) && Number.isFinite(lat)
  checks.push({ name: '经纬度', ok: hasLonLat, detail: hasLonLat ? `${lon},${lat}` : '告警无经纬度（城运该字段非必传，可缺）' })

  const locStr = [w.location, w.channelName, w.deviceName].filter(Boolean).join(' ')
  const area = resolveArea(store, locStr)
  chk('所属区县可解析', !!area.county, area.county ? `${area.county.code} ${area.county.name}` : `无法从「${locStr || '-'}」解析（需区划码表）`)
  chk('所属街道可解析', !!area.street, area.street ? `${area.street.code} ${area.street.name}` : '无法解析（城运要求县/街道上下级必须匹配）')
  if (area.street && area.county) chk('街道属于该区县', area.street.parent_code === area.county.code, `${area.street.parent_code} vs ${area.county.code}`)

  const pic = String(w.picUrl || w.imageUrl || '')
  checks.push({ name: '附件地址', ok: !!pic && /^https?:\/\//.test(pic), detail: pic || '无图片；城运 listFile 非必传' })

  const reportMode = (map && map.report_mode && map.report_mode !== 'inherit') ? map.report_mode : cfg.reportModeDefault
  if (reportMode === 'selfReport') chk('sceneCode', !!(map && map.scene_code), (map && map.scene_code) || '自闭环模式必需')

  // 我方 level(1~4) → 城运 eventLevel(0/1/2/3)，缺省 0 一般
  const enums = (() => { try { return store.kvGet(KV_ENUMS, null) } catch { return null } })() || {}
  const levelMap = enums.eventLevel || { 1: '0', 2: '1', 3: '2', 4: '3' }
  const cyLevel = String(levelMap[Number(w.level) || 1] ?? '0')

  const payload = {
    sourceSystemCode: cfg.sourceSystemCode,
    eventNum: opts && opts.eventNum ? opts.eventNum : `cyzx-${w.id}`,
    eventTitle: `${w.channelName || w.location || 'AI告警'} ${w.aiType || ''}`.trim(),
    eventType: (map && map.cy_event_type) || '',
    eventContent: [
      `AI视频识别：${w.aiType || '未知类型'}`,
      w.channelName ? `点位：${w.channelName}` : '',
      w.aiConfidence !== undefined && w.aiConfidence !== null ? `置信度：${w.aiConfidence}` : '',
      w.plate ? `车牌：${w.plate}` : '',
      w.triggerCount ? `触发次数：${w.triggerCount}` : '',
    ].filter(Boolean).join('；'),
    happenTime: happenTime || '',
    eventLevel: cyLevel,
    eventAddress: locStr || '',
    belongCounty: area.county ? area.county.code : '',
    belongStreet: area.street ? area.street.code : '',
    belongCommunity: '',
    belongGrid: '',
    lon: hasLonLat ? String(lon) : '',
    lat: hasLonLat ? String(lat) : '',
    dealContent: '',
    remark: `来源：环保局驾驶舱（JSC）；告警ID ${w.id}`,
    listFile: pic ? [{ url: pic, fileType: '01', attachmentType: '0', fileName: '现场图.jpg' }] : [],
    appealName: '', appealTel: '', appealTime: '',
    effects: { peopleNumber: 0, deathNumber: 0, injuredNumber: 0, missingNumber: 0, economicLoss: 0, otherEffects: '' },
    suggestDealUnit: [], copyToUnit: [], eventExtendedFieldList: [],
    isTest: !!cfg.isTest,
    eventNature: String(cfg.eventNature || '3'),
  }
  if (reportMode === 'selfReport' && map && map.scene_code) payload.sceneCode = map.scene_code

  // ⛔ 缺必传即判定"不可上报"（不静默降级）
  const blockers = missing.filter(n => !/^经纬度$/.test(n))
  return {
    reportMode,
    payload,
    checks,
    missing,
    ready: blockers.length === 0,
    blockers,
    note: blockers.length
      ? '存在阻断项，报文不完整 ⇒ 不可上报（未映射=不报，出站禁止兜底）'
      : '校验通过（⚠️ 干跑只组装报文，未发送任何请求）',
  }
}

// ════════════════════════════════════════════════════════════
//  逐条口径 · 独立触发点（扫描式，**不经研判闸门**）
// ════════════════════════════════════════════════════════════
/**
 * 扫一条 = 「窗口内、granularity=per_record、映射 enabled=1」的告警，
 * 幂等写入 cyzx_report_log（state=pending）。
 *
 * 🔴 本函数**只做记账，不发请求**（发送是批次 2 的上报器职责）。
 *    总开关 / 逐条开关任一关闭 ⇒ 直接 return，保证"开关关=零副作用"。
 * 🔴 为什么扫描式而不是挂入库钩子：
 *    ① 逐条类型（冒装）**必须绕过研判闸门**，而现有钩子挂在"准入 + front_and_push"上；
 *    ② 扫描式天然可回放 ⇒ 「应推未推」对账容易做（重启/异常都不丢）。
 */
async function scanPerRecordOnce(store, log, opts) {
  const cfg = getConfig(store, true)
  if (!cfg.perRecordEnabled) return { skipped: 'perRecordEnabled=false' }
  const db = store.getDb()
  counters.lastScanAt = shNow()
  counters.lastScanError = null

  const rows = db.prepare("SELECT ai_type FROM cyzx_eventtype_map WHERE granularity = 'per_record' AND enabled = 1 AND cy_event_type <> ''").all()
  const types = rows.map(r => String(r.ai_type))
  if (!types.length) return { skipped: '无 per_record 且就绪的映射' }

  const nowMs = Date.now()
  const sinceMs = nowMs - (Number(cfg.perRecordLookbackH) || 6) * 3600 * 1000
  const limit = Number((opts && opts.limit) || cfg.perRecordBatch) || 200
  let hit = 0, logged = 0, skippedUnmapped = 0, skippedGate = 0

  for (const aiType of types) {
    const list = db.prepare(
      "SELECT id, created_at, data_json FROM warnings WHERE COALESCE(json_extract(data_json,'$.aiType'),'') = ? ORDER BY rowid DESC LIMIT ?"
    ).all(aiType, limit)
    for (const r of list) {
      const t = shParse(r.created_at)
      if (!Number.isFinite(t) || t < sinceMs || t > nowMs + 60000) continue
      hit++
      const w = tryJson(r.data_json) || {}
      w.id = r.id
      // 🔴 门控拦截**也要留痕**（否则"为什么没推"无法回答；且拦截不计入「应推未推」缺口）
      const gd = await gateDecision(store, log, w)
      if (!gd.pass) {
        skippedGate++; counters.skippedGate++
        const en = `cyzx-${r.id}`
        const dup = db.prepare('SELECT id FROM cyzx_report_log WHERE event_num = ?').get(en)
        if (!dup) {
          db.prepare(`INSERT INTO cyzx_report_log
            (event_num, warning_id, ai_type, cy_event_type, report_mode, granularity, member_ids,
             request_body, success, state, skip_reason, retry_count, created_at, updated_at)
            VALUES (?,?,?,?,'', 'per_record', ?, NULL, 0, 'skipped', ?, 0, ?, ?)`)
            .run(en, r.id, aiType, '', JSON.stringify([r.id]), `上报前门控拦截：${gd.reason}`, shNow(), shNow())
        }
        continue
      }
      const eventNum = `cyzx-${r.id}`
      const exists = db.prepare('SELECT id FROM cyzx_report_log WHERE event_num = ?').get(eventNum)
      if (exists) continue   // 🔴 幂等：同一条告警只登记一次
      const built = buildEventReportPayload(store, Object.assign({ id: r.id }, w), { eventNum })
      const state = built.ready ? 'pending' : 'skipped'
      db.prepare(`INSERT INTO cyzx_report_log
        (event_num, warning_id, ai_type, cy_event_type, report_mode, granularity, member_ids,
         request_body, success, state, skip_reason, retry_count, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(eventNum, r.id, aiType, built.payload.eventType || '', built.reportMode, 'per_record', JSON.stringify([r.id]),
          JSON.stringify(built.payload), 0, state, built.ready ? '' : built.blockers.join('、'), 0, shNow(), shNow())
      if (built.ready) {
        logged++; counters.loggedPending++
        // 批次 2：总开关打开时**真正上报**（关闭时到此为止 ⇒ 零请求不变式）
        if (cfg.enabled) {
          const sent = await sendReportRecord(store, log, {
            event_num: eventNum, warning_id: r.id, ai_type: aiType,
            report_mode: built.reportMode, granularity: 'per_record', state: 'pending',
          })
          if (sent && sent.state === 'sent') counters.sentOk = (counters.sentOk || 0) + 1
          else if (sent && sent.state === 'failed') counters.sentFail = (counters.sentFail || 0) + 1
        }
      } else { skippedUnmapped++; counters.skippedUnmapped++ }
    }
  }
  counters.scanned += hit
  counters.lastScanHit = hit
  // 批次 2：顺手补发积压 pending（仅总开关打开时；关闭时 flushPending 自身短路）
  if (cfg.enabled) {
    try {
      counters.lastFlush = await flushPending(store, log, Math.min(limit, 50))
      // 排期 2.5-2：对账缺口主动告警（不是只在页面上躺着）
      const rc = reconcile(store, 24)
      counters.lastGap = rc.gap
      // 批次 3：自动撤销（复核判定误报 ⇒ 撤单）
      try { counters.lastAutoCancel = await autoCancelScan(store, log, 100) } catch (e) { if (log) log.error(`[cyzx] 自动撤销异常: ${e.message}`) }
      if (rc.gap > 0 && log) log.warn(`[cyzx] ⚠️ 应推未推：近24h 应推 ${rc.should} / 已推 ${rc.sent} / 缺口 ${rc.gap} ⇒ 请检查「上报记录」失败原因`)
    } catch (e) { if (log) log.error(`[cyzx] 补发/对账异常: ${e.message}`) }
  }
  if (log && (hit || logged)) log.info(`[cyzx] 逐条扫描：命中 ${hit}，登记待上报 ${logged}，跳过 ${skippedUnmapped + skippedGate}（未就绪 ${skippedUnmapped} / 门控 ${skippedGate}）`)
  return { hit, logged, skippedUnmapped, skippedGate }
}

/**
 * 补发通道：把 `state='pending'` 的积压记录发出去。
 * 🔴 为什么必须有：扫描器只处理**新**告警，而在「总开关关闭」期间登记为 pending 的记录
 *    在开关打开后不会被扫到 ⇒ 若不补发，这批记录会永久卡在 pending，
 *    而「应推未推」对账会一直报缺口（此前这正是缺失的一环）。
 * 幂等由 event_num 唯一约束 + 状态机（只取 pending）保证。
 */
async function flushPending(store, log, limit) {
  const cfg = getConfig(store, true)
  if (!cfg.enabled) return { skipped: '总开关关闭 ⇒ 不发送' }
  const db = store.getDb()
  const rows = db.prepare("SELECT * FROM cyzx_report_log WHERE state = 'pending' ORDER BY id LIMIT ?")
    .all(Math.min(Number(limit) || 50, 200))
  let sent = 0, failed = 0, skipped = 0
  for (const r of rows) {
    const rr = await sendReportRecord(store, log, r)
    if (rr.state === 'sent') sent++
    else if (rr.state === 'failed') failed++
    else skipped++
  }
  if (rows.length && log) log.info(`[cyzx] 补发扫描：待发 ${rows.length}，成功 ${sent}，失败 ${failed}，跳过 ${skipped}`)
  return { pending: rows.length, sent, failed, skipped }
}

let _scanTimer = null
function startPerRecordScanner(store, log) {
  if (_scanTimer) return
  // 周期固定 10s 轮询；实际是否干活由 perRecordIntervalMs + 配置开关决定
  _scanTimer = setInterval(() => {
    try {
      const cfg = getConfig(store)
      if (!cfg.perRecordEnabled) return
      Promise.resolve(scanPerRecordOnce(store, log)).catch(e => { if (log) log.error(`[cyzx] 扫描异常: ${e.message}`) })
    } catch (e) {
      counters.lastError = String(e && e.message || e)
      if (log) log.error(`[cyzx] 逐条扫描异常（已隔离，不影响主流程）: ${counters.lastError}`)
    }
  }, 10000)
  if (_scanTimer.unref) _scanTimer.unref()
  if (log) log.info('[cyzx] 逐条口径扫描器已启动（默认关闭，需 perRecordEnabled=true；实际出站另受总开关约束）')
}
function stopPerRecordScanner() { if (_scanTimer) { clearInterval(_scanTimer); _scanTimer = null } }

/**
 * 「应推未推」对账（批次 2.5 会把 gap>0 做成告警）。
 * 口径（必须单列，禁与 smart_push 统计混算）：
 *   should  = 已通过「映射就绪 + 上报前门控」的条数 = pending + sent + failed
 *   sent    = 成功条数
 *   gap     = should - sent   ← 真正的「应推未推」
 *   skippedByConfig = 因映射未就绪/自闭环缺 sceneCode 被跳过的条数（**这不是漏推，是配置没配完**，
 *                     但必须可见，否则"以为在推其实没推"）
 */
function reconcile(store, hours) {
  const db = store.getDb()
  const h = Number(hours) || 24
  const since = shNow(Date.now() - h * 3600 * 1000)
  const q = (sql) => db.prepare(sql).get(since).c
  const pending = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE granularity='per_record' AND state='pending'  AND created_at >= ?")
  const sent    = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE granularity='per_record' AND success=1      AND created_at >= ?")
  const failed  = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE granularity='per_record' AND state='failed'   AND created_at >= ?")
  const skipped = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE granularity='per_record' AND state='skipped'  AND created_at >= ?")
  const should = pending + sent + failed
  return {
    windowHours: h, since,
    should, sent, pending, failed, gap: Math.max(0, should - sent),
    skippedByConfig: skipped,
    note: 'gap>0 = 应推未推（需告警）；skippedByConfig>0 = 映射未就绪/缺 sceneCode（需补配置）',
  }
}

// ════════════════════════════════════════════════════════════
//  批次 2：上报器 / 双模式分派 / 4.2 接收 / 4.3·4.8 反馈 / 4.4 查询
//  🔴 三条不变式：
//    ① 总开关 closed ⇒ **绝不发任何请求**（扫描/上报/反馈全部短路）
//    ② 出站禁止兜底：映射未就绪 / 缺必填 ⇒ 不报（记 skipped + 原因）
//    ③ 幂等：event_num 唯一；已 sent 的绝不重发
// ════════════════════════════════════════════════════════════

/** 城运接口路径（来自《新话语体系-接口文档》） */
const CY_PATH = {
  eventReport: '/push/eventReport/v1',
  selfReport: '/push/selfEventReport/push',
  feedback: '/push/dealLogPush/v1',
  selfFeedback: '/push/selfTaskOrderResult/push',
  query: '/orderquery/module/data/accept/api/exter/queryCompleteInfo',
  cancel: '/exchange/data/accept/api/outSystemCancelEvent',
  update: '/exchange/data/accept/api/exter/event/updateEvent',
  fileDownload: '/exchange/data/accept/api/event/fileDownload',
}

/** 建「事项单 / 处置记录」两张表（幂等） */
function ensureBatch2Schema(store, log) {
  const db = store.getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS cyzx_task_order (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      task_order_id  TEXT NOT NULL UNIQUE,
      event_num      TEXT NOT NULL DEFAULT '',
      task_code      TEXT NOT NULL DEFAULT '',
      task_name      TEXT NOT NULL DEFAULT '',
      department_id  TEXT NOT NULL DEFAULT '',
      payload_json   TEXT,
      state          TEXT NOT NULL DEFAULT 'open',   -- open | disposed | fed
      received_at    TEXT,
      updated_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS cyzx_disposal (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      task_order_id    TEXT NOT NULL DEFAULT '',
      event_num        TEXT NOT NULL DEFAULT '',
      executor_id      TEXT NOT NULL DEFAULT '',
      executor         TEXT NOT NULL DEFAULT '',
      executor_phone   TEXT NOT NULL DEFAULT '',
      execute_dept_id  TEXT NOT NULL DEFAULT '',
      execute_dept     TEXT NOT NULL DEFAULT '',
      execute_time     TEXT NOT NULL DEFAULT '',
      execute_content  TEXT NOT NULL DEFAULT '',
      execute_node     TEXT NOT NULL DEFAULT '办理',
      attachments      TEXT NOT NULL DEFAULT '[]',
      is_last          INTEGER NOT NULL DEFAULT 1,
      sync_state       TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed
      sync_at          TEXT,
      sync_error       TEXT,
      created_at       TEXT,
      created_by       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cyzx_to_event ON cyzx_task_order(event_num);
    CREATE INDEX IF NOT EXISTS idx_cyzx_disp_event ON cyzx_disposal(event_num);
    CREATE TABLE IF NOT EXISTS cyzx_event_update (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_num    TEXT NOT NULL DEFAULT '',
      event_status TEXT NOT NULL DEFAULT '',
      payload_json TEXT,
      received_at  TEXT
    );
    CREATE TABLE IF NOT EXISTS cyzx_copy_notice (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_num    TEXT NOT NULL DEFAULT '',
      kind         TEXT NOT NULL DEFAULT 'info',   -- info(4.12 信息抄告) | log(4.13 日志抄告)
      payload_json TEXT,
      received_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cyzx_eu_event ON cyzx_event_update(event_num);
    CREATE INDEX IF NOT EXISTS idx_cyzx_cn_event ON cyzx_copy_notice(event_num);
  `)
  // 批次 3：给上报日志补「撤销留痕」列（幂等）
  for (const [col, ddl] of [
    ['cancel_state', "TEXT NOT NULL DEFAULT ''"],   // '' | sent | failed
    ['cancel_at', 'TEXT'],
    ['cancel_reason', 'TEXT'],
    ['cancel_by', 'TEXT'],
    ['update_state', "TEXT NOT NULL DEFAULT ''"],   // 4.10 更新留痕
    ['update_at', 'TEXT'],
  ]) {
    try {
      const cols = db.prepare('PRAGMA table_info(cyzx_report_log)').all().map(c => String(c.name))
      if (!cols.includes(col)) db.exec(`ALTER TABLE cyzx_report_log ADD COLUMN ${col} ${ddl};`)
    } catch (e) { if (log) log.warn(`[cyzx] report_log 补列 ${col} 失败: ${e.message}`) }
  }
  return true
}

/** 门控判定缓存（避免同一条告警被反复调 LLM） */
function ensureGateCache(store) {
  try {
    store.getDb().exec(`
      CREATE TABLE IF NOT EXISTS cyzx_gate_cache (
        warning_id TEXT PRIMARY KEY, gate TEXT NOT NULL DEFAULT '',
        pass INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT '', decided_at TEXT
      );`)
  } catch (e) { /* 建表失败不影响主流程 */ }
}

/**
 * 上报前门控（排期 2.5-1）。四档：
 *   off            —— 纯逐条，全量上报
 *   min_confidence —— 置信度阈值（低于则不报）
 *   review         —— 复核门控：只有**人工复核确认为真**（`review === 'true'`）才报
 *   llm            —— LLM 影子门控：调用本地大模型判一张图，判否则不报
 *
 * 🔴 两条红线：
 *   ① **判定失败一律放行**（告警安全高于降噪 —— 宁可多发，不可漏发判罚证据）；
 *   ② 无论放行还是拦截，**都必须留痕**（拦截记 skipped+原因，见 scanPerRecordOnce）。
 */
async function gateDecision(store, log, w) {
  const cfg = getConfig(store, true)
  const gate = cfg.perRecordGate
  if (!gate || gate === 'off') return { pass: true, reason: 'off（不门控）' }

  const wid = String(w && w.id || '')
  try {
    const c = store.getDb().prepare('SELECT gate, pass, reason FROM cyzx_gate_cache WHERE warning_id = ?').get(wid)
    if (c && c.gate === gate) return { pass: !!c.pass, reason: `${c.reason}（缓存）` }
  } catch (e) { /* 缓存不可用则继续判定 */ }

  let res = { pass: true, reason: '' }
  if (gate === 'min_confidence') {
    const conf = Number(w.aiConfidence)
    const th = Number(cfg.perRecordGateConf)
    if (!Number.isFinite(conf)) res = { pass: true, reason: `置信度缺失 ⇒ 保守放行` }
    else res = { pass: conf >= th, reason: `置信度 ${conf} ${conf >= th ? '≥' : '<'} ${th}` }
  } else if (gate === 'review') {
    const rv = String((w && w.review) || '')
    if (rv === 'true') res = { pass: true, reason: '人工复核确认为真' }
    else if (rv === 'false') res = { pass: false, reason: '人工复核判定为误报' }
    else if (rv === 'miss') res = { pass: false, reason: '人工复核判定为漏检' }
    else res = { pass: false, reason: '尚未人工复核（review 门控下需先复核）' }
  } else if (gate === 'llm') {
    res = await llmVerdict(cfg, log, w)
  }

  try {
    store.getDb().prepare('INSERT OR REPLACE INTO cyzx_gate_cache (warning_id, gate, pass, reason, decided_at) VALUES (?,?,?,?,?)')
      .run(wid, gate, res.pass ? 1 : 0, String(res.reason).slice(0, 200), shNow())
  } catch (e) { /* 缓存写失败不影响判定结果 */ }
  return res
}

/** LLM 影子门控：把现场图送本地多模态模型判定（🔴 任何失败都放行） */
async function llmVerdict(cfg, log, w) {
  const prompt = String(process.env.CYZX_LLM_PROMPT ||
    '这是一张道路监控抓拍。请判断：画面中的渣土车/货车是否存在"车厢未苫盖、物料外露、冒装"的情况？只回答一个字：是 或 否。')
  const base = String(cfg.llmUrl || process.env.CYZX_LLM_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = String(cfg.llmModel || process.env.CYZX_LLM_MODEL || 'qwen2.5vl:7b')
  const pic = String((w && (w.picUrl || w.imageUrl)) || '')
  if (!pic) return { pass: true, reason: 'LLM 门控：无图 ⇒ 保守放行' }
  try {
    // 取图（本地图床；限 4MB，超时 6s）
    const ir = await fetch(pic, { signal: AbortSignal.timeout(6000) })
    if (!ir.ok) return { pass: true, reason: `LLM 门控：取图 HTTP ${ir.status} ⇒ 保守放行` }
    const buf = Buffer.from(await ir.arrayBuffer())
    if (!buf.length || buf.length > 4 * 1024 * 1024) return { pass: true, reason: `LLM 门控：图大小 ${buf.length}B 不适用 ⇒ 保守放行` }
    const r = await fetch(base + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, images: [buf.toString('base64')], stream: false, options: { temperature: 0 } }),
      signal: AbortSignal.timeout(Math.min(Number(cfg.llmTimeoutMs) || 25000, 60000)),
    })
    const j = await r.json().catch(() => null)
    const txt = String((j && j.response) || '').trim()
    if (!txt) return { pass: true, reason: 'LLM 门控：空响应 ⇒ 保守放行' }
    const isNo = /^否|不是|没有|未冒装|无冒装/.test(txt)
    const isYes = /^是|冒装|未苫盖/.test(txt)
    if (isYes && !isNo) return { pass: true, reason: `LLM 判定：是（${txt.slice(0, 30)}）` }
    if (isNo && !isYes) return { pass: false, reason: `LLM 判定：否（${txt.slice(0, 30)}）` }
    return { pass: true, reason: `LLM 回答不明确（${txt.slice(0, 30)}）⇒ 保守放行` }
  } catch (e) {
    if (log) log.warn(`[cyzx] LLM 门控异常（保守放行）: ${String(e && e.message || e).slice(0, 120)}`)
    return { pass: true, reason: 'LLM 门控异常 ⇒ 保守放行：' + String(e && e.message || e).slice(0, 80) }
  }
}

// ── 4.11 撤销 ──
/**
 * 撤销一条已上报的事件单（4.11）。
 * Q5 决策：**复核判定为 AI 误报（`review==='false'`）时自动撤销**。
 */
async function cancelRemoteEvent(store, log, eventNums, opts) {
  const cfg = getConfig(store, true)
  const nums = (Array.isArray(eventNums) ? eventNums : [eventNums]).map(x => String(x || '').trim()).filter(Boolean)
  if (!nums.length) return { ok: false, error: 'eventNums 为空' }
  if (!cfg.enabled) return { ok: false, error: '总开关关闭 ⇒ 不发送' }
  if (!cfg.systemYkzUserId) return { ok: false, error: '未配置 systemYkzUserId（城运撤销接口必传渝快政人员ID）⇒ 请先填写' }

  const reason = String((opts && opts.reason) || cfg.cancelReasonTemplate || 'AI识别复核确认为误报，撤销该事件单')
  const by = String((opts && opts.by) || cfg.systemYkzUserName || '驾驶舱系统')
  const payload = {
    eventNums: nums.join(','),          // 城运要求：多个用英文逗号分隔
    sourceSystemCode: cfg.sourceSystemCode,
    cancelReason: reason,
    cancelUserYkzId: cfg.systemYkzUserId,
    cancelUserName: by,
    files: (opts && opts.files) || [],
  }
  const r = await postWithRetry(cfg, CY_PATH.cancel, payload, log)
  const st = r.ok ? 'sent' : 'failed'
  const db = store.getDb()
  for (const n of nums) {
    try {
      db.prepare('UPDATE cyzx_report_log SET cancel_state=?, cancel_at=?, cancel_reason=?, cancel_by=? WHERE event_num=?')
        .run(st, shNow(), r.ok ? reason : (r.error || `HTTP ${r.httpStatus}`), by, n)
    } catch (e) { /* 单条记账失败不影响其它 */ }
  }
  if (log) log.info(`[cyzx] 撤销 ${nums.length} 条 → ${CY_PATH.cancel} ${r.ok ? 'OK' : 'FAIL'} http=${r.httpStatus}`)
  return { ok: r.ok, httpStatus: r.httpStatus, body: r.body, error: r.error, eventNums: nums, payload }
}

/**
 * 自动撤销扫描（Q5）：找出「已上报成功 + 该告警复核判定为误报」的记录，逐条撤销。
 * 🔴 触发判据写死为 `warnings.data_json.review === 'false'`（复核结论=误报）。
 *    `review==='miss'`（漏检）**不撤** —— 那是"没检出来"，与"误报"是两回事。
 */
async function autoCancelScan(store, log, limit) {
  const cfg = getConfig(store, true)
  if (!cfg.enabled) return { skipped: '总开关关闭 ⇒ 不发送' }
  if (!cfg.cancelOnReviewFalse) return { skipped: '自动撤销开关关闭（cancelOnReviewFalse=false）' }
  const db = store.getDb()
  const rows = db.prepare(`SELECT event_num, warning_id FROM cyzx_report_log
      WHERE success = 1 AND COALESCE(cancel_state,'') = '' ORDER BY id LIMIT ?`)
    .all(Math.min(Number(limit) || 100, 500))
  const hit = []
  for (const r of rows) {
    if (!r.warning_id) continue
    let w = null
    try { w = db.prepare('SELECT data_json FROM warnings WHERE id = ?').get(r.warning_id) } catch (e) { w = null }
    if (!w) continue
    let o = null; try { o = JSON.parse(w.data_json) } catch (e) { continue }
    if (String((o && o.review) || '') === 'false') hit.push(r.event_num)
  }
  if (!hit.length) return { candidates: 0, cancelled: 0, note: '没有「已上报且复核判误报」的记录' }
  const rr = await cancelRemoteEvent(store, log, hit, { reason: `复核判定为 AI 误报，自动撤销（${hit.length} 条）`, by: '自动撤销（复核误报）' })
  return { candidates: hit.length, cancelled: rr.ok ? hit.length : 0, ok: rr.ok, httpStatus: rr.httpStatus, error: rr.error, eventNums: hit }
}

// ── 4.10 事件单更新（经纬度/地址/标题/内容）──
async function updateRemoteEvent(store, log, p) {
  const cfg = getConfig(store, true)
  if (!cfg.enabled) return { ok: false, error: '总开关关闭 ⇒ 不发送' }
  const eventNum = String((p && p.eventNum) || '').trim()
  if (!eventNum) return { ok: false, error: 'eventNum 必填' }
  const lon = String((p && p.lon) || '').trim()
  const lat = String((p && p.lat) || '').trim()
  const addr = String((p && p.eventAddress) || '').trim()
  // 🔴 城运要求：eventNum / lon / lat / eventAddress 均必传
  const miss = []
  if (!lon) miss.push('lon'); if (!lat) miss.push('lat'); if (!addr) miss.push('eventAddress')
  if (miss.length) return { ok: false, error: '缺少必传字段：' + miss.join('、') }
  const body = { eventNum, lon, lat, eventAddress: addr }
  if (p.eventTitle) body.eventTitle = String(p.eventTitle)
  if (p.eventContent) body.eventContent = String(p.eventContent)
  const r = await postWithRetry(cfg, CY_PATH.update, body, log)
  try {
    store.getDb().prepare('UPDATE cyzx_report_log SET update_state=?, update_at=? WHERE event_num=?')
      .run(r.ok ? 'sent' : 'failed', shNow(), eventNum)
  } catch (e) { /* 忽略 */ }
  if (log) log.info(`[cyzx] 4.10 更新 ${eventNum} ${r.ok ? 'OK' : 'FAIL'} http=${r.httpStatus}`)
  return { ok: r.ok, httpStatus: r.httpStatus, body: r.body, error: r.error, payload: body }
}

// ── 4.9 附件下载 ──
async function downloadRemoteFile(store, log, p, dataDir) {
  const cfg = getConfig(store, true)
  if (!cfg.enabled) return { ok: false, error: '总开关关闭 ⇒ 不发送' }
  const url = String((p && p.url) || '').trim()
  if (!url) return { ok: false, error: 'url 必填' }
  const fileName = String((p && p.fileName) || '').trim() || url.split('/').pop() || `file-${Date.now()}`
  const r = await postWithRetry(cfg, CY_PATH.fileDownload, { url, fileName }, log)
  if (!r.ok) return { ok: false, httpStatus: r.httpStatus, error: r.error || 'HTTP ' + r.httpStatus }
  // 落盘留证（目录可配；文件名做安全化处理，禁止路径穿越）
  try {
    const path = require('node:path'); const fs = require('node:fs')
    const base = dataDir || process.cwd()
    const dir = path.join(base, String(cfg.fileDownloadDir || 'cyzx-files'))
    fs.mkdirSync(dir, { recursive: true })
    const safe = fileName.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').replace(/\.{2,}/g, '_').slice(0, 120) || `file-${Date.now()}`
    const fp = path.join(dir, safe)
    fs.writeFileSync(fp, r.body, 'utf8')
    return { ok: true, httpStatus: r.httpStatus, saved: fp, bytes: Buffer.byteLength(r.body || '') }
  } catch (e) {
    return { ok: true, httpStatus: r.httpStatus, saved: null, error: '落盘失败：' + e.message, body: (r.body || '').slice(0, 500) }
  }
}

// ── 4.5 / 4.12 / 4.13 入站订阅 ──
function ingestEventUpdate(store, log, payload) {
  try {
    const b = payload || {}
    const info = b.eventInfo || b
    const eventNum = String(info.eventNum || b.eventNum || '')
    store.getDb().prepare('INSERT INTO cyzx_event_update (event_num, event_status, payload_json, received_at) VALUES (?,?,?,?)')
      .run(eventNum, String(info.eventStatus || ''), JSON.stringify(b), shNow())
    if (log) log.info(`[cyzx] 4.5 收到事件单更新广播 eventNum=${eventNum} status=${info.eventStatus || ''}`)
    return { ok: true, eventNum }
  } catch (e) { if (log) log.error(`[cyzx] 4.5 落库失败: ${e.message}`); return { ok: false, error: e.message } }
}

function ingestCopyNotice(store, log, payload, kind) {
  try {
    const b = payload || {}
    const eventNum = String(b.eventNum || (b.eventInfo && b.eventInfo.eventNum) || '')
    store.getDb().prepare('INSERT INTO cyzx_copy_notice (event_num, kind, payload_json, received_at) VALUES (?,?,?,?)')
      .run(eventNum, kind === 'log' ? 'log' : 'info', JSON.stringify(b), shNow())
    if (log) log.info(`[cyzx] 4.${kind === 'log' ? '13' : '12'} 收到抄告（${kind}）eventNum=${eventNum}`)
    return { ok: true, eventNum, kind }
  } catch (e) { if (log) log.error(`[cyzx] 抄告落库失败: ${e.message}`); return { ok: false, error: e.message } }
}

/** 3-4 对账日报（口径单列，不与 smart_push 统计混算） */
function dailyReport(store, days) {
  const db = store.getDb()
  const n = Math.min(Math.max(Number(days) || 7, 1), 30)
  const out = []
  for (let i = 0; i < n; i++) {
    const day = shNow(Date.now() - i * 86400000).slice(0, 10)
    const q = (sql) => db.prepare(sql).get(day + ' %').c
    const sent = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE success=1 AND created_at LIKE ?")
    const failed = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE state='failed' AND created_at LIKE ?")
    const pending = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE state='pending' AND created_at LIKE ?")
    const skipped = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE state='skipped' AND created_at LIKE ?")
    const gated = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE state='skipped' AND skip_reason LIKE '%门控拦截%' AND created_at LIKE ?")
    const cancelled = q("SELECT COUNT(*) c FROM cyzx_report_log WHERE COALESCE(cancel_state,'')='sent' AND cancel_at LIKE ?")
    out.push({ date: day, should: sent + failed + pending, sent, failed, pending, skipped, gated, cancelled, gap: failed + pending })
  }
  return { days: n, rows: out.reverse(), note: '口径单列：只统计城运通道（cyzx_*），不与智治推送统计混算' }
}

function buildUrl(cfg, path) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '')
  return base + path
}

/** 单次出站（唯一发请求的地方之一；另一个是 test-connect） */
async function postOnce(cfg, path, payload) {
  const url = buildUrl(cfg, path)
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.authMode === 'token' && cfg.token) headers['X-Callback-Token'] = cfg.token
  const t0 = Date.now()
  try {
    const r = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.min(Number(cfg.timeoutMs) || 10000, 30000)),
    })
    const txt = await r.text()
    let j = null; try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { ok: r.ok, httpStatus: r.status, body: txt.slice(0, 4000), json: j, ms: Date.now() - t0, error: null }
  } catch (e) {
    return { ok: false, httpStatus: null, body: '', json: null, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 300) }
  }
}

/** 带重试的出站（指数退避）；仅在总开关打开时被调用 */
async function postWithRetry(cfg, path, payload, log) {
  const max = Math.max(1, Math.min(Number(cfg.retry) || 3, 5))
  let last = null
  for (let i = 0; i < max; i++) {
    last = await postOnce(cfg, path, payload)
    if (last.ok) return Object.assign(last, { attempts: i + 1 })
    if (last.httpStatus && last.httpStatus >= 400 && last.httpStatus < 500) break   // 4xx 重试无意义
    if (i < max - 1) await new Promise(r => setTimeout(r, 400 * Math.pow(2, i)))
  }
  return Object.assign(last || {}, { attempts: max })
}

// ── 4.7 自闭环：从处置记录组装 taskOrderOutPuts ──
function buildTaskOrderOutPuts(store, eventNum, mapRow) {
  const db = store.getDb()
  const disp = db.prepare('SELECT * FROM cyzx_disposal WHERE event_num = ? ORDER BY id').all(eventNum)
  if (!disp.length) return null
  const taskOrderId = disp[0].task_order_id || `self-${eventNum}`
  const logs = disp.map(d => ({
    isLastTaskOrderLog: !!d.is_last,
    eventProcessId: `cyzx-log-${d.id}`,
    executorId: d.executor_id || undefined,
    executor: d.executor || undefined,
    executorPhone: d.executor_phone || undefined,
    executeDeptId: d.execute_dept_id || '',
    executeDept: d.execute_dept || '',
    executeTime: d.execute_time || shNow(),
    executeContent: d.execute_content || '',
    executeNode: d.execute_node || '办理',
    listFile: (() => { try { return JSON.parse(d.attachments || '[]') } catch { return [] } })(),
  }))
  const last = disp[disp.length - 1]
  return [{
    taskCode: (mapRow && mapRow.task_code) || '',
    taskName: (mapRow && mapRow.task_name) || 'AI事件处置',
    taskOrderId,
    taskDeptId: last.execute_dept_id || '',
    taskOrderOutputArray: [{ fieldCode: 'executeContent', fieldName: '处置意见', fieldValue: [last.execute_content || ''], isAddToExtends: false }],
    logList: logs,
  }]
}

/**
 * 组装 + 发送一条上报（4.1 或 4.7）。
 * @param {object} rec cyzx_report_log 行（含 event_num / warning_id / ai_type）
 * @returns {{state, reason, httpStatus?}}
 */
/** 把「不上报」的原因写回日志（🔴 必须写库：否则记录永远停在 pending，「应推未推」会持续报缺口而看不到原因） */
function markSkipped(store, eventNum, reason) {
  try {
    store.getDb().prepare("UPDATE cyzx_report_log SET state='skipped', skip_reason=?, updated_at=? WHERE event_num=?")
      .run(String(reason || ''), shNow(), eventNum)
  } catch (e) { /* 记账失败不影响主流程 */ }
}

async function sendReportRecord(store, log, rec) {
  const cfg = getConfig(store, true)
  // 总开关关闭 = "暂不发送"，**不改状态**（保持 pending，开开关后可续发）
  if (!cfg.enabled) return { state: rec.state, reason: '总开关关闭 ⇒ 不发送' }

  const w = getWarning(store, rec.warning_id) || { id: rec.warning_id, aiType: rec.ai_type }
  const built = buildEventReportPayload(store, w, { eventNum: rec.event_num })
  if (!built.ready) {
    const reason = built.blockers.join('、')
    markSkipped(store, rec.event_num, reason)
    return { state: 'skipped', reason }
  }

  const path = built.reportMode === 'selfReport' ? CY_PATH.selfReport : CY_PATH.eventReport
  let payload = built.payload

  if (built.reportMode === 'selfReport') {
    // 4.7 必须内嵌 taskOrderOutPuts（含至少 1 条 logList）⇒ 需要先录入处置
    const mapRow = (() => { try { return store.getDb().prepare('SELECT * FROM cyzx_eventtype_map WHERE ai_type = ?').get(String(w.aiType || '')) } catch { return null } })()
    const to = buildTaskOrderOutPuts(store, rec.event_num, { task_code: '', task_name: w.aiType })
    if (!to) {
      const reason = '自闭环(4.7)需先录入处置记录后再上报'
      markSkipped(store, rec.event_num, reason)
      return { state: 'skipped', reason }
    }
    payload = Object.assign({}, payload, { taskOrderOutPuts: to })
  }

  const r = await postWithRetry(cfg, path, payload, log)
  const state = r.ok ? 'sent' : 'failed'
  store.getDb().prepare(`UPDATE cyzx_report_log SET request_body=?, response_status=?, response_body=?, success=?,
      state=?, skip_reason=?, retry_count=?, updated_at=? WHERE event_num=?`)
    .run(JSON.stringify(payload), r.httpStatus, (r.body || r.error || '').slice(0, 4000), r.ok ? 1 : 0,
      state, r.ok ? '' : (r.error || `HTTP ${r.httpStatus}`), (r.attempts || 1) - 1, shNow(), rec.event_num)
  if (log) log.info(`[cyzx] 上报 ${rec.event_num} → ${path} ${r.ok ? 'OK' : 'FAIL'} http=${r.httpStatus} 尝试${r.attempts}次`)
  return { state, httpStatus: r.httpStatus, attempts: r.attempts, error: r.error }
}

/** 4.3 / 4.8：反馈处置结果 */
async function sendFeedback(store, log, eventNum) {
  const cfg = getConfig(store, true)
  if (!cfg.enabled) return { ok: false, error: '总开关关闭 ⇒ 不发送' }
  const db = store.getDb()
  const disp = db.prepare('SELECT * FROM cyzx_disposal WHERE event_num = ? ORDER BY id').all(eventNum)
  if (!disp.length) return { ok: false, error: '没有处置记录' }
  const logRow = db.prepare('SELECT * FROM cyzx_report_log WHERE event_num = ?').get(eventNum)
  const mode = (logRow && logRow.report_mode) || cfg.reportModeDefault
  const last = disp[disp.length - 1]
  const payload = {
    sourceSystemCode: cfg.sourceSystemCode,
    eventNum,
    taskOrderOutPuts: buildTaskOrderOutPuts(store, eventNum, { task_code: '', task_name: '' }),
    taskOrderDealStatus: '1', taskOrderEndStatus: '1',
    logList: undefined,
  }
  delete payload.logList
  const path = mode === 'selfReport' ? CY_PATH.selfFeedback : CY_PATH.feedback
  const r = await postWithRetry(cfg, path, payload, log)
  const sync = r.ok ? 'sent' : 'failed'
  db.prepare('UPDATE cyzx_disposal SET sync_state=?, sync_at=?, sync_error=? WHERE id=?')
    .run(sync, shNow(), r.ok ? null : (r.error || `HTTP ${r.httpStatus}`), last.id)
  if (sync === 'sent') db.prepare("UPDATE cyzx_task_order SET state='fed', updated_at=? WHERE event_num=?").run(shNow(), eventNum)
  if (log) log.info(`[cyzx] 反馈 ${eventNum} → ${path} ${r.ok ? 'OK' : 'FAIL'} http=${r.httpStatus}`)
  return { ok: r.ok, httpStatus: r.httpStatus, body: r.body, error: r.error, payload }
}

/** 4.4：查询事件单（只读，不入库） */
async function queryRemoteEvent(store, log, { eventNum, logId }) {
  const cfg = getConfig(store, true)
  if (!cfg.enabled) return { ok: false, error: '总开关关闭 ⇒ 不发送' }
  if (!cfg.sourceSystemCode || !eventNum) return { ok: false, error: 'sourceSystemCode / eventNum 必填' }
  const body = { sourceSystemCode: cfg.sourceSystemCode, eventNum }
  if (logId) body.logId = logId
  const r = await postOnce(cfg, CY_PATH.query, body)
  return { ok: r.ok, httpStatus: r.httpStatus, body: r.body, json: r.json, error: r.error }
}

/** 4.2 入站：事项单落库（幂等：task_order_id 唯一） */
function ingestTaskOrder(store, log, payload) {
  try {
    const db = store.getDb()
    const b = payload || {}
    const toId = String(b.taskOrderId || b.task_order_id || '').trim()
    if (!toId) return { ok: false, error: '缺少 taskOrderId' }
    const eventNum = String((b.eventInfo && b.eventInfo.eventNum) || b.eventNum || '').trim()
    const biz = b.bizTask || {}
    const t = shNow()
    const exists = db.prepare('SELECT id FROM cyzx_task_order WHERE task_order_id = ?').get(toId)
    if (exists) {
      db.prepare('UPDATE cyzx_task_order SET payload_json=?, updated_at=? WHERE task_order_id=?')
        .run(JSON.stringify(b), t, toId)
      if (log) log.info(`[cyzx] 4.2 事项单重复推送（幂等更新）taskOrderId=${toId}`)
      return { ok: true, duplicated: true, taskOrderId: toId }
    }
    db.prepare(`INSERT INTO cyzx_task_order
      (task_order_id, event_num, task_code, task_name, department_id, payload_json, state, received_at, updated_at)
      VALUES (?,?,?,?,?,?,'open',?,?)`)
      .run(toId, eventNum, String(b.taskCode || ''), String(biz.taskName || b.taskName || ''),
        String(biz.departmentCode || ''), JSON.stringify(b), t, t)
    if (log) log.info(`[cyzx] 4.2 收到事项单 taskOrderId=${toId} eventNum=${eventNum}`)
    return { ok: true, taskOrderId: toId, eventNum }
  } catch (e) {
    if (log) log.error(`[cyzx] 4.2 落库失败: ${e.message}`)
    return { ok: false, error: e.message }
  }
}

/** 入站守卫：IP 白名单 + 令牌（与既有 chengyunGuard 同语义，独立配置避免互相影响） */
function cyzxInboundGuard(req, res, next) {
  const allow = String(process.env.CYZX_ALLOW_IPS || '127.0.0.1').split(',').map(s => s.trim()).filter(Boolean)
  const ip = String(req.ip || '').replace('::ffff:', '')
  if (!allow.includes(ip)) return res.status(403).json({ ok: false, error: '来源 IP 不在白名单' })
  const token = process.env.CYZX_INBOUND_TOKEN || ''
  if (token) {
    const got = req.headers['x-callback-token'] || (req.query && req.query.token) || ''
    if (String(got) !== token) return res.status(401).json({ ok: false, error: '令牌无效' })
  }
  next()
}

// ════════════════════════════════════════════════════════════
//  路由注册
// ════════════════════════════════════════════════════════════
function registerCyzxRoutes(app, { store, log, adminOnly }) {
  const adm = adminOnly || ((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅管理员可操作' })
    next()
  })
  const who = (req) => (req.user && req.user.username) || '?'
  // 与 index.js 的 DATA_DIR 保持一致（cyzx.js 与 index.js 同目录）
  const DATA_DIR_REF = () => require('node:path').join(__dirname, 'data')

  // ── 初始化（建表 + 种子）──
  try {
    ensureSchema(store, log)
    ensureBatch2Schema(store, log)
    ensureGateCache(store)
    seedMapIfNeeded(store, log)
    getConfig(store, true)   // 首次读：把默认值落到内存缓存；写入由后台触发
  } catch (e) {
    // 🔴 初始化失败**不得**阻断后端启动
    if (log) log.error(`[cyzx] 初始化失败（模块已禁用，后端继续启动）: ${e.message}`)
  }

  // ── ① 配置 ──
  app.get('/api/cyzx/config', adm, (req, res) => {
    try {
      res.json({ ok: true, config: publicConfig(store), version: configVersion(), defaults: DEFAULT_CONFIG, masks: { token: 'token' } })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.put('/api/cyzx/config', adm, (req, res) => {
    try {
      const b = Object.assign({}, req.body || {})
      // 前端回传掩码 = 未修改，忽略该字段（防止把 "abc****yz" 写回库）
      if (typeof b.token === 'string' && b.token.includes('******')) delete b.token
      const next = setConfig(store, b, who(req))
      if (log) log.info(`[cyzx] 配置已更新 by ${who(req)}：enabled=${next.enabled} baseUrl=${next.baseUrl ? '(set)' : '(empty)'} perRecord=${next.perRecordEnabled}`)
      res.json({ ok: true, config: publicConfig(store), version: configVersion() })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ── 连通性测试（显式按钮；不改任何配置）──
  app.post('/api/cyzx/test-connect', adm, async (req, res) => {
    const cfg = getConfig(store, true)
    const url = String((req.body && req.body.url) || cfg.baseUrl || '').trim()
    if (!url) return res.status(400).json({ ok: false, error: 'baseUrl 未配置' })
    const t0 = Date.now()
    let out = { at: shNow(), ok: false, httpStatus: null, ms: null, error: null }
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers: cfg.authMode === 'token' && cfg.token ? { 'X-Callback-Token': cfg.token } : undefined,
        signal: AbortSignal.timeout(Math.min(Number(cfg.timeoutMs) || 10000, 15000)),
      })
      out.ok = true; out.httpStatus = r.status
    } catch (e) {
      out.error = String(e && e.message || e).slice(0, 200)
    }
    out.ms = Date.now() - t0
    try { setConfig(store, { connectTest: out }, who(req)) } catch { /* 记账失败不影响测试结果 */ }
    if (log) log.info(`[cyzx] 连通性测试 ${url} → ok=${out.ok} http=${out.httpStatus} ${out.ms}ms`)
    res.json({ ok: out.ok, result: out })
  })

  // ── ② 事件类型映射 ──
  app.get('/api/cyzx/event-type-map', adm, (req, res) => {
    try { res.json({ ok: true, items: listEventTypeMap(store), version: configVersion() }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.put('/api/cyzx/event-type-map', adm, (req, res) => {
    try {
      const r = upsertEventTypeMap(store, req.body || {}, (req.body && req.body.partial) !== false)
      res.json({ ok: true, ...r, items: listEventTypeMap(store) })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })
  app.post('/api/cyzx/event-type-map/bulk', adm, (req, res) => {
    try {
      const text = String((req.body && (req.body.text || req.body.csv)) || '')
      if (!text.trim()) return res.status(400).json({ ok: false, error: 'text 为空' })
      const r = bulkImportEventTypeMap(store, text)
      if (log) log.info(`[cyzx] 映射批量导入 by ${who(req)}：总 ${r.total}，新增 ${r.created}，更新 ${r.updated}，失败 ${r.failed.length}`)
      res.json({ ok: true, result: r, items: listEventTypeMap(store) })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })
  app.delete('/api/cyzx/event-type-map/:aiType', adm, (req, res) => {
    try { res.json({ ok: true, deleted: deleteEventTypeMap(store, decodeURIComponent(req.params.aiType || '')) }) }
    catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ── ③ 码表 ──
  app.get('/api/cyzx/areas', adm, (req, res) => {
    try { res.json({ ok: true, items: listAreas(store, req.query.limit) }) } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.post('/api/cyzx/areas', adm, (req, res) => {
    try { res.json({ ok: true, ...bulkImportAreas(store, String((req.body && req.body.text) || '')) }) } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })
  app.get('/api/cyzx/orgs', adm, (req, res) => {
    try { res.json({ ok: true, items: listOrgs(store, req.query.limit) }) } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.post('/api/cyzx/orgs', adm, (req, res) => {
    try { res.json({ ok: true, ...bulkImportOrgs(store, String((req.body && req.body.text) || '')) }) } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  // ── ④ 自检 / 干跑 / 记录 / 对账 ──
  app.get('/api/cyzx/health', adm, (req, res) => {
    try { res.json({ ok: true, ...healthCheck(store) }) } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.post('/api/cyzx/dry-run', adm, (req, res) => {
    try {
      const b = req.body || {}
      let w = b.warningId ? getWarning(store, b.warningId) : null
      if (!w) w = pickLatestWarningFor(store, String(b.aiType || '渣土车冒装'))
      if (!w) return res.status(404).json({ ok: false, error: '找不到可用于干跑的告警（可传 warningId 或 aiType）' })
      const built = buildEventReportPayload(store, w, {})
      res.json({
        ok: true, dryRun: true, /** 🔴 只组装不发送 */
        warning: { id: w.id, aiType: w.aiType, createdAt: w.createdAt, channelName: w.channelName, level: w.level },
        ...built,
        hint: '干跑不发送任何请求；核对无误后再灌码表、开开关、灰度',
      })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.get('/api/cyzx/reports', adm, (req, res) => {
    try {
      const db = store.getDb()
      const limit = Math.min(Number(req.query.limit) || 100, 500)
      const where = []; const args = []
      if (req.query.state) { where.push('state = ?'); args.push(String(req.query.state)) }
      if (req.query.granularity) { where.push('granularity = ?'); args.push(String(req.query.granularity)) }
      const sql = `SELECT id, event_num, warning_id, ai_type, cy_event_type, report_mode, granularity,
        state, skip_reason, success, retry_count, created_at FROM cyzx_report_log
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
      const items = db.prepare(sql).all(...args, limit)
      const stats = {
        pending: db.prepare("SELECT COUNT(*) c FROM cyzx_report_log WHERE state='pending'").get().c,
        sent: db.prepare('SELECT COUNT(*) c FROM cyzx_report_log WHERE success=1').get().c,
        failed: db.prepare("SELECT COUNT(*) c FROM cyzx_report_log WHERE state='failed'").get().c,
        skipped: db.prepare("SELECT COUNT(*) c FROM cyzx_report_log WHERE state='skipped'").get().c,
      }
      res.json({ ok: true, items, stats, counters: Object.assign({}, counters), version: configVersion() })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.get('/api/cyzx/reconcile', adm, (req, res) => {
    try { res.json({ ok: true, ...reconcile(store, req.query.hours) }) } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.post('/api/cyzx/scan-now', adm, async (req, res) => {
    try { res.json({ ok: true, result: await scanPerRecordOnce(store, log, { limit: (req.body && req.body.limit) }) }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ══════════ 批次 2 路由 ══════════

  // ── 4.2 入站：事项单（网关推给我们；走独立守卫，不加进 PUBLIC_PATHS）──
  app.post('/cyzx/inbound/taskorder', cyzxInboundGuard, (req, res) => {
    const r = ingestTaskOrder(store, log, req.body || {})
    res.status(r.ok ? 200 : 400).json(r.ok ? { code: 200, message: '请求已成功', data: {} } : { code: 400, message: r.error, data: {} })
  })

  // ── 事项单 / 处置记录 查询 ──
  app.get('/api/cyzx/task-orders', adm, (req, res) => {
    try {
      const db = store.getDb()
      const items = db.prepare('SELECT id, task_order_id, event_num, task_code, task_name, department_id, state, received_at, updated_at FROM cyzx_task_order ORDER BY id DESC LIMIT ?')
        .all(Math.min(Number(req.query.limit) || 200, 500))
      const withDisp = items.map(t => ({
        ...t,
        disposal_count: db.prepare('SELECT COUNT(*) c FROM cyzx_disposal WHERE task_order_id = ?').get(t.task_order_id).c,
      }))
      res.json({ ok: true, items: withDisp })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.get('/api/cyzx/disposals', adm, (req, res) => {
    try {
      const db = store.getDb()
      const where = []; const args = []
      if (req.query.eventNum) { where.push('event_num = ?'); args.push(String(req.query.eventNum)) }
      const items = db.prepare(`SELECT * FROM cyzx_disposal ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
        .all(...args, Math.min(Number(req.query.limit) || 200, 500))
      res.json({ ok: true, items })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  /** 处置工作台：录入一条处置记录（4.1 派单闭环与 4.7 自闭环共用） */
  app.post('/api/cyzx/disposal', adm, (req, res) => {
    try {
      const b = req.body || {}
      if (!b.eventNum) return res.status(400).json({ ok: false, error: 'eventNum 必填' })
      if (!String(b.executeContent || '').trim()) return res.status(400).json({ ok: false, error: '处置意见 executeContent 必填（城运要求 taskOrderOutputArray 必须含该字段）' })
      const db = store.getDb()
      // 同一 eventNum 只允许一条 is_last=1
      db.prepare('UPDATE cyzx_disposal SET is_last = 0 WHERE event_num = ?').run(String(b.eventNum))
      const r = db.prepare(`INSERT INTO cyzx_disposal
        (task_order_id, event_num, executor_id, executor, executor_phone, execute_dept_id, execute_dept,
         execute_time, execute_content, execute_node, attachments, is_last, sync_state, created_at, created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'pending',?,?)`)
        .run(String(b.taskOrderId || ''), String(b.eventNum), String(b.executorId || ''), String(b.executor || ''),
          String(b.executorPhone || ''), String(b.executeDeptId || ''), String(b.executeDept || ''),
          String(b.executeTime || shNow()), String(b.executeContent || ''), String(b.executeNode || '办理'),
          JSON.stringify(b.attachments || []), shNow(), who(req))
      db.prepare("UPDATE cyzx_task_order SET state='disposed', updated_at=? WHERE event_num=?").run(shNow(), String(b.eventNum))
      if (log) log.info(`[cyzx] 录入处置 eventNum=${b.eventNum} by ${who(req)}`)
      res.json({ ok: true, id: r.lastInsertRowid })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })
  app.delete('/api/cyzx/disposal/:id', adm, (req, res) => {
    try {
      const n = store.getDb().prepare('DELETE FROM cyzx_disposal WHERE id = ?').run(Number(req.params.id)).changes
      res.json({ ok: true, deleted: n })
    } catch (e) { res.status(400).json({ ok: false, error: e.message }) }
  })

  /** 立即上报：指定 eventNum，或所有 pending、或重试全部 failed */
  app.post('/api/cyzx/report-now', adm, async (req, res) => {
    try {
      const b = req.body || {}
      const db = store.getDb()
      let rows
      if (b.eventNum) rows = db.prepare('SELECT * FROM cyzx_report_log WHERE event_num = ?').all(String(b.eventNum))
      else if (b.onlyFailed) rows = db.prepare("SELECT * FROM cyzx_report_log WHERE state = 'failed' ORDER BY id LIMIT ?").all(Math.min(Number(b.limit) || 50, 200))
      else rows = db.prepare("SELECT * FROM cyzx_report_log WHERE state IN ('pending','failed') ORDER BY id LIMIT ?").all(Math.min(Number(b.limit) || 50, 200))
      if (!rows.length) return res.json({ ok: true, processed: 0, note: '没有待上报/失败的记录' })
      // （扫描器每次扫描后也会自动补发 pending）
      const out = []
      for (const r of rows) {
        const rr = await sendReportRecord(store, log, r)
        out.push({ eventNum: r.event_num, ...rr })
      }
      res.json({ ok: true, processed: out.length, results: out })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  /** 4.3 / 4.8 反馈 */
  app.post('/api/cyzx/feedback', adm, async (req, res) => {
    try {
      const eventNum = String((req.body && req.body.eventNum) || '')
      if (!eventNum) return res.status(400).json({ ok: false, error: 'eventNum 必填' })
      const r = await sendFeedback(store, log, eventNum)
      res.status(r.ok ? 200 : 502).json(r)
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  /** 4.4 查询（只读） */
  app.post('/api/cyzx/query-event', adm, async (req, res) => {
    try {
      const b = req.body || {}
      const r = await queryRemoteEvent(store, log, { eventNum: String(b.eventNum || ''), logId: b.logId })
      res.status(r.ok ? 200 : 502).json(r)
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ══════════ 批次 3 路由 ══════════

  // ── 4.5 / 4.12 / 4.13 入站（网关推给我们；复用独立守卫）──
  app.post('/cyzx/inbound/event-update', cyzxInboundGuard, (req, res) => {
    const r = ingestEventUpdate(store, log, req.body || {})
    res.status(r.ok ? 200 : 400).json(r.ok ? { code: 200, message: '请求已成功', data: {} } : { code: 400, message: r.error, data: {} })
  })
  app.post('/cyzx/inbound/copy-notice', cyzxInboundGuard, (req, res) => {
    const r = ingestCopyNotice(store, log, req.body || {}, 'info')
    res.status(r.ok ? 200 : 400).json(r.ok ? { code: 200, message: '请求已成功', data: {} } : { code: 400, message: r.error, data: {} })
  })
  app.post('/cyzx/inbound/log-notice', cyzxInboundGuard, (req, res) => {
    const r = ingestCopyNotice(store, log, req.body || {}, 'log')
    res.status(r.ok ? 200 : 400).json(r.ok ? { code: 200, message: '请求已成功', data: {} } : { code: 400, message: r.error, data: {} })
  })

  // ── 4.11 撤销 ──
  app.get('/api/cyzx/cancel-candidates', adm, (req, res) => {
    try {
      const db = store.getDb()
      const rows = db.prepare(`SELECT r.event_num, r.warning_id, r.ai_type, r.created_at,
          json_extract(w.data_json,'$.review') AS review, r.cancel_state, r.cancel_reason
        FROM cyzx_report_log r LEFT JOIN warnings w ON w.id = r.warning_id
        WHERE r.success = 1 ORDER BY r.id DESC LIMIT ?`).all(Math.min(Number(req.query.limit) || 200, 500))
      res.json({ ok: true, items: rows })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.post('/api/cyzx/cancel', adm, async (req, res) => {
    try {
      const b = req.body || {}
      if (!b.eventNums && !b.eventNum) return res.status(400).json({ ok: false, error: 'eventNum / eventNums 必填' })
      const r = await cancelRemoteEvent(store, log, b.eventNums || b.eventNum, { reason: b.cancelReason, by: b.cancelUserName })
      res.status(r.ok ? 200 : 502).json(r)
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  app.post('/api/cyzx/auto-cancel-scan', adm, async (req, res) => {
    try { res.json({ ok: true, result: await autoCancelScan(store, log, (req.body && req.body.limit)) }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── 4.10 更新事件单 ──
  app.post('/api/cyzx/update-event', adm, async (req, res) => {
    try {
      const r = await updateRemoteEvent(store, log, req.body || {})
      res.status(r.ok ? 200 : 502).json(r)
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── 4.9 附件下载 ──
  app.post('/api/cyzx/download-file', adm, async (req, res) => {
    try {
      const r = await downloadRemoteFile(store, log, req.body || {}, DATA_DIR_REF())
      res.status(r.ok ? 200 : 502).json(r)
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── 3-4 对账日报 ──
  app.get('/api/cyzx/report-daily', adm, (req, res) => {
    try { res.json({ ok: true, ...dailyReport(store, req.query.days) }) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  // ── 4.5/4.12/4.13 落库查询 ──
  app.get('/api/cyzx/inbound-records', adm, (req, res) => {
    try {
      const db = store.getDb()
      const lim = Math.min(Number(req.query.limit) || 100, 300)
      res.json({
        ok: true,
        updates: db.prepare('SELECT id, event_num, event_status, received_at FROM cyzx_event_update ORDER BY id DESC LIMIT ?').all(lim),
        notices: db.prepare('SELECT id, event_num, kind, received_at FROM cyzx_copy_notice ORDER BY id DESC LIMIT ?').all(lim),
      })
    } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })

  startPerRecordScanner(store, log)
  if (log) log.info('[cyzx] 三级城运贯通模块已挂载（/api/cyzx/*）。出站不变式：**总开关关闭 ⇒ 零请求**；打开且映射就绪才会上报')
}

module.exports = {
  registerCyzxRoutes,
  // 供自检脚本/单测直接调用（不依赖 express）
  ensureSchema, seedMapIfNeeded, getConfig, setConfig, configVersion, publicConfig,
  listEventTypeMap, upsertEventTypeMap, deleteEventTypeMap, bulkImportEventTypeMap,
  listAreas, bulkImportAreas, listOrgs, bulkImportOrgs,
  healthCheck, buildEventReportPayload, scanPerRecordOnce, startPerRecordScanner, stopPerRecordScanner,
  reconcile, resolveArea, shNow, shParse,
  ensureBatch2Schema, sendReportRecord, markSkipped, flushPending,
  gateDecision, llmVerdict, ensureGateCache,
  cancelRemoteEvent, autoCancelScan, updateRemoteEvent, downloadRemoteFile,
  ingestEventUpdate, ingestCopyNotice, dailyReport, sendFeedback, queryRemoteEvent, ingestTaskOrder,
  buildTaskOrderOutPuts, cyzxInboundGuard, CY_PATH,
  DEFAULT_CONFIG, REPORT_MODES, GRANULARITIES, KV_CONFIG, SEED_MAP,
}
