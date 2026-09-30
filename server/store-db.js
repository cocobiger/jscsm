'use strict'
/* sqlite store layer */
/**
 * 采集数据 SQLite 存储层（基于 Node 22 内置 node:sqlite，无需任何 npm 原生依赖）
 *
 * 设计目标：
 *   - 气体采集记录全部长期入库，可按时间范围查询一年内数据
 *   - 替代原 collected.json 的 5000 条上限
 *   - 对外暴露与原 JSON 数组等价的读写方法，最小化 index.js 改动
 *
 * 表 collected：
 *   一行 = 一条采集记录。pollutants 数组以 JSON 文本存于 pollutants_json 字段，
 *   读出时还原为对象，保证与原 record 结构完全一致。
 *   aqi 单独成列以便统计/排序；monitorTime 建索引以支持时间范围查询。
 *
 * 注意：node:sqlite 在 Node 22 为实验特性（仅一条 ExperimentalWarning，功能稳定）。
 */
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

let db = null
let logRef = console

// ── 按算法保留期（软归档）· 2026-09-24 ──────────────────────────────────────
// [算法键, 建议保留天数, 是否启用, 备注]。仅作**首次种子**（INSERT OR IGNORE），
//   管理员在后台改过之后重启不会被覆盖。天数可在后台「保留策略」tab 随时改。
// 建议值依据（09-24 现场量级）：渣土车冒装＝直接判罚证据、单条量大 ⇒ 留 7 天够处置留痕；
//   堆头未覆盖走「24h≥5」聚合推送 ⇒ 聚合后单条价值低，留 2 天；气体监测 50 条多为 1 天前 ⇒ 5 天。
const ALGO_RETENTION_SEEDS = [
  ['__default__', 3, 1, '未单独配置算法的兜底保留天数'],
  ['__gas__', 5, 1, '市局气体监测（cq_api），记录无 aiType，单独兜底'],
  ['渣土车冒装', 7, 1, '直接判罚证据，需留足处置留痕时间'],
  ['堆头未覆盖', 2, 1, '走聚合推送，聚合后单条价值低'],
  ['秸秆燃烧', 2, 1, ''],
  ['人员入侵', 3, 1, ''],
]
// 约定键（不可删除；显示时换成人话）
const RETENTION_DEFAULT_KEY = '__default__'
const RETENTION_GAS_KEY = '__gas__'
const RETENTION_RESERVED_KEYS = [RETENTION_DEFAULT_KEY, RETENTION_GAS_KEY]
const RETENTION_KEY_LABEL = {
  [RETENTION_DEFAULT_KEY]: '默认（未单独配置的算法）',
  [RETENTION_GAS_KEY]: '市局气体监测（无算法名）',
}

/**
 * 初始化数据库连接并建表。
 * @param {string} dataDir 数据目录（与 index.js 的 DATA_DIR 一致）
 * @param {object} logger  日志器（可选）
 * @returns {string} 数据库文件路径
 */
function init(dataDir, logger) {
  if (logger) logRef = logger
  const dbFile = path.join(dataDir, 'jsc.db')
  db = new DatabaseSync(dbFile)

  // WAL 模式：读写并发更友好，写入更快
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')

  db.exec(`
    CREATE TABLE IF NOT EXISTS collected (
      id              TEXT PRIMARY KEY,
      point_code      TEXT,
      point_name      TEXT,
      source_type     TEXT,
      monitor_time    TEXT,                 -- 'YYYY-MM-DD HH:mm:ss'
      aqi             REAL,
      pollutants_json TEXT,                 -- JSON: [{code,value,name,unit,standardValue}]
      lat             REAL,
      lon             REAL,
      valid           INTEGER DEFAULT 1,    -- 1 有效 / 0 无效（留痕不预警）
      collected_at    TEXT                  -- ISO 入库时间
    );
  `)
  // 时间范围查询（stats / 历史窗口）索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_collected_monitor_time ON collected(monitor_time);')
  // 去重检查（点位名+监测时间）索引
  db.exec('CREATE INDEX IF NOT EXISTS idx_collected_point_time ON collected(point_name, monitor_time);')
  // 点位+时间倒序：历史窗口 buildHistory 用
  db.exec('CREATE INDEX IF NOT EXISTS idx_collected_pcode_time ON collected(point_code, monitor_time DESC);')

  // ── 其余三类"会增长、原被截断"的记录表 ──────────────────────
  // 设计：索引常用过滤字段（status/type 等），其余整条以 JSON 存于 data_json；
  //       插入顺序 = 时间顺序，读取按 rowid DESC 得"新→旧"，等价原 unshift 语义。

  // 预警记录（原 warnings.json，上限 2000）
  db.exec(`
    CREATE TABLE IF NOT EXISTS warnings (
      id           TEXT PRIMARY KEY,
      created_at   TEXT,
      status       TEXT,              -- pending / handled
      warning_type TEXT,
      data_json    TEXT               -- 完整预警对象
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_warnings_type ON warnings(warning_type);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_warnings_status ON warnings(status);')

  // IoT 拉取去重留痕（T5：recordId 持久化，进程重启后不重复入库、不覆盖 handled 状态）
  db.exec(`
    CREATE TABLE IF NOT EXISTS iot_record_seen (
      record_id      TEXT PRIMARY KEY,
      channel_sip_id TEXT,
      first_seen_at  TEXT NOT NULL
    );
  `)

  // AI 分析推送规则（降噪：通道+AI类型+N小时超M条 → 列表只推1条）
  // 2026-07-10 V2：ai_type 升级为 ai_types 数组；AI 类型由 ai_types 主数据表管理
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_rules (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      channel_sip_id    TEXT,
      ai_type           TEXT NOT NULL,           -- 兼容旧列（保留单值）
      ai_types          TEXT NOT NULL DEFAULT '[]',  -- JSON 数组（新主列）
      time_window_hours INTEGER NOT NULL DEFAULT 24,
      threshold         INTEGER NOT NULL DEFAULT 20,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );
  `)

  // 告警过滤规则（T6：5 维度条件 → 命中即从告警列表隐藏；与 push_rules 聚合互补）
  //   sources        来源多选：cq_api / iotcloud / straw-engine / chengyun-platform（空数组=不限）
  //   locations      位置关键字（channelName/pointName/deviceName/location 子串匹配，空数组=不限）
  //   min_confidence AI 置信度下限（1-100）：aiConfidence(0-1) 换算百分数 < 该值即命中「低置信度隐藏」
  //   severities     等级多选：JSON 数字数组 [1注意,2轻度,3中度,4重度]（空数组=不限）
  // 规则内各已设置维度 AND，规则间 OR（命中任意一条 enabled 规则即隐藏）
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_filter_rules (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      sources        TEXT NOT NULL DEFAULT '[]',
      locations      TEXT NOT NULL DEFAULT '[]',
      min_confidence INTEGER,
      severities     TEXT NOT NULL DEFAULT '[]',
      remark         TEXT NOT NULL DEFAULT '',
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
  `)

  // AI 类型主数据（可后台自由增删；name 作匹配键，与 rules/warnings 用字符串精确匹配）
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_types (
      name          TEXT PRIMARY KEY,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL
    );
  `)

  // 为 iot_channels 增加 ai_types 列（多选元数据，纯 UI/过滤，不约束聚合）
  try { db.exec(`ALTER TABLE iot_channels ADD COLUMN ai_types TEXT NOT NULL DEFAULT '[]';`) } catch (e) {}

  // 🔴 2026-09-18 ROI 电子围栏：**按「算法名」分组**的多边形（归一化坐标 0~1）。
  //   形如 { "堆头未覆盖": {enable:true, coord:'norm', polygon:[[x,y],...]}, "渣土车冒装": {...} }
  //   纯配置：只被各条识别链消费，不参与本服务的任何聚合/过滤逻辑。
  try { db.exec(`ALTER TABLE iot_channels ADD COLUMN roi TEXT NOT NULL DEFAULT '{}';`) } catch (e) {}

  // 为 push_rules 增加 ai_types 列
  try { db.exec(`ALTER TABLE push_rules ADD COLUMN ai_types TEXT NOT NULL DEFAULT '[]';`) } catch (e) {}

  // 2026-09-15 整改（算法字典「单一出处」）：ai_types 增加 source_key（云平台算法英文 key）。
  //   原 iot-fetcher 里 AI_TYPE_MAP 硬编码 7 个 key，与 ai_types 表（8 类中文）两套字典互不匹配
  //   （只有 unsoilcover 是交集）→ 导致绝大多数算法中文名无法落地、未命中的 key 静默 fallback 成英文。
  //   现统一：以 ai_types.source_key 为唯一出处，iot-fetcher 热加载本表做 key→中文名 映射。
  try { db.exec(`ALTER TABLE ai_types ADD COLUMN source_key TEXT NOT NULL DEFAULT '';`) } catch (e) {}

  // 迁移种子：把原硬编码的 7 个算法 key 落到 ai_types.source_key（幂等）
  try {
    const KEY_SEED = [
      ['unsoilcover', '堆头未覆盖'],   // 唯一真正在跑的算法（底层类型名 spill / 业务标签「冒装」）
      ['uncovered', '裸土未覆盖'],
      ['person', '人员入侵'],
      ['vehicle', '车辆违停'],
      ['fire', '烟火检测'],
      ['water', '水位异常'],
      ['garbage', '垃圾堆积'],
    ]
    const t0 = new Date().toISOString()
    const insIfMissing = db.prepare('INSERT OR IGNORE INTO ai_types (name, sort_order, created_at, source_key) VALUES (?,?,?,?)')
    const fillKey = db.prepare("UPDATE ai_types SET source_key = ? WHERE name = ? AND (source_key IS NULL OR source_key = '')")
    for (const [key, name] of KEY_SEED) {
      insIfMissing.run(name, 20, t0, key)   // 表里没有该中文名 → 补建（sort_order=20，排在业务类之后）
      fillKey.run(key, name)                // 已有该中文名 → 仅补 source_key
    }
    // 顺手修正历史 sort_order 冲突（「堆头未覆盖」与「堆场扬尘」都是 0）
    db.prepare("UPDATE ai_types SET sort_order = 9 WHERE name = '堆场扬尘' AND sort_order = 0").run()
  } catch (e) { /* 迁移失败不影响启动 */ }

  // 种子化：首次 init 若 ai_types 为空，插入默认 7 种（保持现有枚举顺序）
  const aiTypeCount = db.prepare('SELECT COUNT(*) c FROM ai_types').get().c
  if (aiTypeCount === 0) {
    const seed = [
      '堆头未覆盖', '道路扬尘', '秸秆燃烧', '违规排污',
      '固废与危废违规倾倒', '固废运输违规', '侵占岸线与水面漂浮物',
    ]
    const ins = db.prepare('INSERT INTO ai_types (name, sort_order, created_at) VALUES (?,?,?)')
    const t = new Date().toISOString()
    for (let i = 0; i < seed.length; i++) ins.run(seed[i], i, t)
  }

  // 迁移：把旧 push_rules 的 ai_type 单值包进 ai_types 数组（避免老规则失效）
  const migrate = db.prepare("SELECT id, ai_type FROM push_rules WHERE ai_types IS NULL OR ai_types = '' OR ai_types = '[]'")
  const upd = db.prepare('UPDATE push_rules SET ai_types = ? WHERE id = ?')
  for (const r of migrate.all()) {
    if (r.ai_type) upd.run(JSON.stringify([r.ai_type]), r.id)
  }

  // 系统默认聚合降噪规则（T4）—— **2026-09-19 起停用自动种/自动重置**。
  // 业务决策：研判闸门改为「**逐通道逐算法精细配置**」，不再依赖一条全局通配规则当闸门。
  //   · 新库不再自动创建这条通配规则；
  //   · 老库里已存在的那条**不再每次启动强制重置**（原逻辑会把 ai_types 打回 []、阈值打回 5、enabled 打回 1，
  //     等于管理员在后台的启停/阈值改完一重启就白改）；
  //   · 该历史规则的**一次性停用**放在下面的迁移区（用 app_settings 打标记，只做一次，
  //     之后管理员若想重新启用，重启不会再被改回）。
  // （迁移逻辑见下方 "judge_wildcard_retired"）

  // 采集日志（原 collect_logs.json，上限 500）
  db.exec(`
    CREATE TABLE IF NOT EXISTS collect_logs (
      id        TEXT PRIMARY KEY,
      time      TEXT,
      status    TEXT,                 -- ok / skip / invalid / error
      data_json TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_collect_logs_status ON collect_logs(status);')

  // 短信发送历史（原 sms_history.json，上限 2000）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_history (
      id        TEXT PRIMARY KEY,
      time      TEXT,
      status    TEXT,                 -- success / failed
      data_json TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sms_history_status ON sms_history(status);')

  // 短信回执/上行（原 sms_reports.json，上限 3000）
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_reports (
      id          TEXT PRIMARY KEY,
      received_at TEXT,
      type        TEXT,               -- report / upstream
      data_json   TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sms_reports_type ON sms_reports(type);')

  // ── 配置型集合表（streams/map_points/datasources/sms_contacts/sms_templates/sms_blacklist）──
  // 每条一行：id 主键 + data_json 整条对象；按 rowid 保序（等价原数组顺序）。
  // 关键：streamMonitor 改为按 id 精准 UPDATE，不再整表覆盖，根治读-改-写竞态。
  for (const t of ['streams', 'map_points', 'datasources', 'sms_contacts', 'sms_templates', 'sms_blacklist']) {
    db.exec(`CREATE TABLE IF NOT EXISTS coll_${t} ( id TEXT PRIMARY KEY, data_json TEXT );`)
  }
  // 键值表：存 icon_config 这类单对象配置
  db.exec('CREATE TABLE IF NOT EXISTS kv_config ( k TEXT PRIMARY KEY, v_json TEXT );')

  // ── 秸秆燃烧复核样本回流（边工作边训练的数据管道）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS straw_samples (
      id          TEXT PRIMARY KEY,
      warning_id  TEXT,
      stream_id   TEXT,
      verdict     TEXT,              -- true(真警) / false(误报) / miss(漏报)
      reason      TEXT,              -- 误报归因（烟囱/晨雾/扬尘/反光）
      reviewer    TEXT,
      created_at  TEXT,
      data_json   TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_straw_samples_verdict ON straw_samples(verdict);')

  // ── 秸秆责任映射表（行政区划→责任单位→微信群）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS area_responsibility (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      district  TEXT DEFAULT '万州区',
      town      TEXT NOT NULL,
      community TEXT DEFAULT '',
      unit      TEXT,
      person    TEXT,
      phone     TEXT,
      webhook   TEXT,
      remark    TEXT,
      UNIQUE(town, community)
    );
  `)

  // ── 行政边界表（乡镇 Polygon，来源：官方 geojson 导入 / 后台地图编辑）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS area_boundary (
      town          TEXT PRIMARY KEY,   -- 乡镇/街道名
      division_code TEXT DEFAULT '',
      ring          TEXT NOT NULL,      -- JSON [[lng,lat],...] 外环顶点
      source        TEXT DEFAULT 'imported',  -- imported / manual
      updated_at    TEXT
    );
  `)
  // 边界版本快照（每次导入/批量变更前自动备份，支持回滚）
  db.exec(`
    CREATE TABLE IF NOT EXISTS boundary_snapshot (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      note          TEXT,
      boundary_json TEXT NOT NULL,      -- [{town,division_code,ring}]
      created_at    TEXT
    );
  `)

  // ── 政务模块数据（P2 驾驶舱：管理后台 Excel 导入，每模块一行 JSON payload）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS gov_modules (
      module       TEXT PRIMARY KEY,   -- forecast / pyramid / documents / assessment
      payload_json TEXT NOT NULL,
      updated_at   TEXT,
      updated_by   TEXT
    );
  `)

  // ── 用户与会话（登录鉴权）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,        -- scrypt 派生
      salt          TEXT NOT NULL,
      role          TEXT NOT NULL,        -- admin / operator / viewer
      enabled       INTEGER DEFAULT 1,
      force_change  INTEGER DEFAULT 0,    -- 1=需强制改密（默认管理员首登）
      created_at    TEXT,
      last_login_at TEXT
    );
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      username    TEXT,
      role        TEXT,
      created_at  TEXT,
      expires_at  INTEGER               -- epoch ms
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);')

  // ── 智治推送（城运中心对接）──
  // 处置预案：每种事件类型对应城运中心的接口配置
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_push_plans (
      id            TEXT PRIMARY KEY,
      event_type    TEXT NOT NULL,          -- 气体污染/水体污染/秸秆燃烧/道路扬尘/堆头未覆盖/...
      name          TEXT NOT NULL,          -- 预案名称
      enabled       INTEGER DEFAULT 1,
      api_url       TEXT,                   -- 城运中心接口地址
      api_method    TEXT DEFAULT 'POST',    -- HTTP 方法
      api_headers   TEXT,                   -- JSON: {"Content-Type":"application/json","Authorization":"Bearer xxx"}
      body_template TEXT,                   -- JSON 模板，支持 {event_type}/{location}/{lat}/{lon} 等变量
      -- 副接口（附件/补充信息接口，如城运中心 /client/handle_event_other）：主接口推送后顺序调用
      api_url_other       TEXT,             -- 副接口地址（留空=不启用）
      api_method_other    TEXT DEFAULT 'POST',
      api_headers_other   TEXT,             -- JSON 请求头
      body_template_other TEXT,             -- 副接口报文模板（通常用于传 image_url 等附件字段）
      description   TEXT,
      created_at    TEXT,
      updated_at    TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_plans_type ON smart_push_plans(event_type);')

  // 推送规则：自动触发条件
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_push_rules (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,           -- 规则名称
      event_type       TEXT NOT NULL,           -- 事件类型
      plan_id          TEXT,                    -- 关联的处置预案
      location_match   TEXT,                    -- 点位匹配（模糊，空=所有点位）
      time_window_hours INTEGER DEFAULT 48,     -- 时间窗口（小时）
      trigger_count    INTEGER DEFAULT 5,       -- 触发次数阈值
      enabled          INTEGER DEFAULT 1,
      created_at       TEXT,
      updated_at       TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_rules_type ON smart_push_rules(event_type);')

  // 告警事件记录：所有接收到的告警事件（MQTT/手动/API）
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_push_events (
      id          TEXT PRIMARY KEY,
      event_type  TEXT NOT NULL,
      location    TEXT,
      lat         REAL,
      lon         REAL,
      level       INTEGER,
      value       TEXT,
      standard    TEXT,
      description TEXT,
      image_url   TEXT,                     -- 事件图片 URL（支持 /api/iot-image 代理地址）
      raw_json    TEXT,                     -- 完整原始 JSON
      source      TEXT DEFAULT 'mqtt',      -- mqtt/manual/api
      created_at  TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_events_type ON smart_push_events(event_type);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_events_location ON smart_push_events(location);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_events_time ON smart_push_events(created_at);')

  // 推送历史
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_push_history (
      id             TEXT PRIMARY KEY,
      rule_id        TEXT,
      plan_id        TEXT,
      event_type     TEXT,
      event_ids      TEXT,                -- JSON array
      location       TEXT,
      trigger_count  INTEGER,
      api_url        TEXT,
      api_method     TEXT,
      request_body   TEXT,
      response_status INTEGER,
      response_body  TEXT,
      success        INTEGER DEFAULT 0,
      error_message  TEXT,
      created_at     TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_history_type ON smart_push_history(event_type);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_history_time ON smart_push_history(created_at);')

  // ── IoT 视频分析通道接入表（与驾驶舱视频流 coll_streams 做映射）──
  // channel_sip_id 为 IoTCloud 国标通道ID（20位），自然主键；stream_id 关联 coll_streams.id（可空=未映射）
  db.exec(`
    CREATE TABLE IF NOT EXISTS iot_channels (
      channel_sip_id  TEXT PRIMARY KEY,
      channel_name    TEXT NOT NULL,
      device_sip_id   TEXT,
      device_name     TEXT,
      stream_id       TEXT,
      enabled         INTEGER NOT NULL DEFAULT 1,
      remark          TEXT DEFAULT '',
      -- 2026-09-19 修复：ai_types / roi 原先只在 init 早期用 ALTER 补，而那时本表**尚未创建**
      --   → 全新库上 ALTER 静默抛错，建表又不带这两列，导致「全新安装首次启动」后
      --   upsertIotChannel（INSERT 里引用了 ai_types）报 "no column named ai_types"，
      --   必须重启一次才自愈。现改为建表时就带上；老库仍由上面的 ALTER 幂等补列。
      ai_types        TEXT NOT NULL DEFAULT '[]',
      roi             TEXT NOT NULL DEFAULT '{}',
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_iot_channels_stream ON iot_channels(stream_id);')
  db.exec('CREATE INDEX IF NOT EXISTS idx_iot_channels_enabled ON iot_channels(enabled, deleted_at);')

  // ── 智治推送回调闭环迁移（存量表补列，幂等）──
  // 事件状态：pending(待上报) → pushed(已推送) → processing(受理中) → closed(已结案)
  // 推送记录状态：pushed(已推送) → processing(受理中) → closed(已结案) + 回执留痕字段
  function addColumnIfMissing(table, col, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name)
    if (!cols.includes(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
      logRef.info ? logRef.info(`迁移: ${table} 新增列 ${col}`) : console.log('migrate', table, col)
    }
  }
  // ── 事件研判闸门化 P0-1 / P0-2（2026-09-19）──────────────────────────────
  // judge_status 语义（注意：与 warnings.status「待处置/已处置」是两码事）：
  //   admitted = 研判通过  → 进驾驶舱前台「实时告警」（并允许 SSE 广播）
  //   blocked  = 被研判拦下 → 只留档（AI 存档页可见），不进前台、不广播
  //   legacy   = 改造前存量数据（无判定信息）→ 视同 admitted，保证历史告警不消失
  addColumnIfMissing('warnings', 'judge_status', 'TEXT')
  addColumnIfMissing('warnings', 'judge_rule_id', 'TEXT')
  addColumnIfMissing('warnings', 'judge_reason', 'TEXT')
  addColumnIfMissing('warnings', 'judged_at', 'TEXT')
  // 存量行一次性回填 legacy（幂等：只补 NULL，绝不覆盖已有判定）
  db.exec("UPDATE warnings SET judge_status = 'legacy' WHERE judge_status IS NULL")
  db.exec('CREATE INDEX IF NOT EXISTS idx_warnings_judge ON warnings(judge_status);')

  // ── 通用键值设置（P0-3 起用：研判默认策略等）────────────────────────────
  // 之所以单独建表而不是塞进 push_rules：这是「系统级开关」，不是一条研判规则，
  //   放进规则表会被后台的规则列表/统计/优先级逻辑污染。
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT
    );
  `)

  // ── 按算法保留期（软归档）· 2026-09-24 ────────────────────────────────────
  // 业务痛点：渣土车冒装等高频算法的 pending 记录只增不减（09-24 实测 299+ 且持续增长），
  //   驾驶舱前台实时告警被历史积压淹没 ⇒ 需要「每个算法各配一个保留天数」，超期不再进前台。
  // 语义 = **A 软归档**（业务 09-24 拍板）：超期记录**仍是 pending、存档/导出照常可见**，
  //   只是不进前台实时告警；把天数调大即可随时"找回"，不动数据、可回滚。
  // 约定键：__default__ = 未单独配置算法的兜底；__gas__ = 市局气体监测（cq_api，这类记录没有 aiType）
  db.exec(`
    CREATE TABLE IF NOT EXISTS algo_retention (
      ai_type    TEXT PRIMARY KEY,
      keep_days  REAL NOT NULL DEFAULT 3,
      enabled    INTEGER NOT NULL DEFAULT 1,
      remark     TEXT,
      updated_at TEXT
    );
  `)
  // 种子（幂等 INSERT OR IGNORE：绝不覆盖管理员后来的修改）
  try {
    const seedStmt = db.prepare(
      'INSERT OR IGNORE INTO algo_retention (ai_type, keep_days, enabled, remark, updated_at) VALUES (?,?,?,?,?)'
    )
    const seedNow = new Date().toISOString()
    for (const s of ALGO_RETENTION_SEEDS) seedStmt.run(s[0], s[1], s[2] ? 1 : 0, s[3], seedNow)
  } catch (e) { /* 种子失败不影响启动 */ }

  // ── P1-1 / P1-2：研判维度补全 + 规则动作（2026-09-19）────────────────────
  // 原研判只有「频率」一个维度（通道+算法+N小时≥M条）；补三个准入维度 + 一个动作：
  //   min_confidence  最低置信度，**百分比 0-100**（与「告警过滤规则」口径一致；0=不限）
  //   min_level       最低告警等级 1-4（0=不限）
  //   active_hours    生效时段（**上海时间**），如 '8-18' / '20-6'（跨夜）/ '8-12,14-18'；空=全天
  //   action          'admit_front' 进前台（默认）/ 'archive_only' 仅存档（强制不报）
  addColumnIfMissing('push_rules', 'min_confidence', 'REAL NOT NULL DEFAULT 0')
  addColumnIfMissing('push_rules', 'min_level', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing('push_rules', 'active_hours', "TEXT NOT NULL DEFAULT ''")
  addColumnIfMissing('push_rules', 'action', "TEXT NOT NULL DEFAULT 'admit_front'")

  // ── 研判闸门改「逐通道逐算法精细配置」：一次性停用历史全局通配规则（2026-09-19 业务决策）──
  // 用 app_settings 打标记，**只做一次**：之后管理员若在后台重新启用它，重启不会再被改回。
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key = 'judge_wildcard_retired'").get()
    if (!done) {
      const n = db.prepare("UPDATE push_rules SET enabled = 0, updated_at = ? WHERE name = 'AI视频24h≥5聚合(系统默认)'")
        .run(new Date().toISOString()).changes
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?,?,?)')
        .run('judge_wildcard_retired', '1', new Date().toISOString())
      if (n > 0) console.log(`[migrate] 已停用历史全局通配研判规则 ${n} 条（改为逐通道逐算法精细配置）`)
    }
  } catch (e) { /* app_settings 未就绪时不迁移，不影响启动 */ }

  addColumnIfMissing('smart_push_events', 'status', "TEXT DEFAULT 'pending'")
  addColumnIfMissing('smart_push_history', 'status', "TEXT DEFAULT 'pushed'")
  addColumnIfMissing('smart_push_history', 'callback_body', 'TEXT')
  addColumnIfMissing('smart_push_history', 'callback_status', 'INTEGER DEFAULT 0')
  addColumnIfMissing('smart_push_history', 'callback_time', 'TEXT')
  addColumnIfMissing('smart_push_history', 'disposal_result', 'TEXT')
  addColumnIfMissing('smart_push_history', 'disposal_operator', 'TEXT')
  addColumnIfMissing('smart_push_history', 'closed_at', 'TEXT')
  // ── P2：目标平台独立实体（可复用连接配置，消除预案组合爆炸）──
  addColumnIfMissing('smart_push_plans', 'platform_id', 'TEXT')
  // 副接口（附件/补充信息接口）：主接口推送后顺序调用
  addColumnIfMissing('smart_push_plans', 'api_url_other', 'TEXT')
  addColumnIfMissing('smart_push_plans', 'api_method_other', 'TEXT')
  addColumnIfMissing('smart_push_plans', 'api_headers_other', 'TEXT')
  addColumnIfMissing('smart_push_plans', 'body_template_other', 'TEXT')
  addColumnIfMissing('smart_push_history', 'platform_id', 'TEXT')
  addColumnIfMissing('smart_push_events', 'image_url', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_push_platforms (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      api_url       TEXT,
      api_method    TEXT DEFAULT 'POST',
      api_headers   TEXT,
      body_template TEXT,
      auth_mode     TEXT DEFAULT 'none',   -- none / bearer / appkey
      auth_key_name TEXT,                  -- appkey 模式下的请求头名
      event_types   TEXT DEFAULT '',        -- 逗号分隔事件类型，或 'ALL' 表示全部；空=仅被预案引用时送达
      enabled       INTEGER DEFAULT 1,
      description   TEXT,
      created_at    TEXT,
      updated_at    TEXT,
      -- 副接口（附件/补充信息接口，如城运中心 /client/handle_event_other）
      api_url_other       TEXT,
      api_method_other    TEXT DEFAULT 'POST',
      api_headers_other   TEXT,
      body_template_other TEXT
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_platforms_enabled ON smart_push_platforms(enabled);')
  // 副接口（附件/补充信息接口）：主接口推送后顺序调用
  addColumnIfMissing('smart_push_platforms', 'api_url_other', 'TEXT')
  addColumnIfMissing('smart_push_platforms', 'api_method_other', 'TEXT')
  addColumnIfMissing('smart_push_platforms', 'api_headers_other', 'TEXT')
  addColumnIfMissing('smart_push_platforms', 'body_template_other', 'TEXT')

  // ── 第③环 PDF 结案存档：结案报告模板（版式存库、管理页可编辑，与渲染器解耦）──
  addColumnIfMissing('smart_push_history', 'report_path', 'TEXT')
  addColumnIfMissing('smart_push_history', 'report_generated_at', 'TEXT')
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_push_report_templates (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      engine        TEXT DEFAULT 'html',
      content       TEXT NOT NULL,         -- HTML 模板，支持 {{key}} 占位符
      is_default    INTEGER DEFAULT 0,
      description   TEXT,
      created_at    TEXT,
      updated_at    TEXT
    );
  `)
  // 第③环同时承载「工作报表」模板（kind 区分版式用途：closure=结案报告 / workreport=工作报表），列缺口幂等补齐
  addColumnIfMissing('smart_push_report_templates', 'kind', "TEXT DEFAULT 'closure'")
  // 区块编辑器双存模型：blocks_json 存可再编辑的结构化区块，content 存渲染用 HTML
  addColumnIfMissing('smart_push_report_templates', 'blocks_json', 'TEXT')
  // 默认结案报告 HTML 模板（版式仅作种子，后续可在管理页自由编辑，代码不固化版式）
  const DEFAULT_REPORT_TEMPLATE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif; color:#1a1a1a; font-size:12.5px; line-height:1.7; margin:0; }
  .redhead { text-align:center; color:#c0392b; font-weight:700; font-size:22px; letter-spacing:2px; margin-top:6px; }
  .sub { text-align:center; color:#c0392b; font-size:12px; margin-top:2px; }
  .redline { border-top:3px solid #c0392b; margin:8px 0 14px; }
  .meta { text-align:right; color:#555; font-size:11px; margin-bottom:10px; }
  h2 { font-size:14px; border-left:4px solid #c0392b; padding-left:8px; margin:16px 0 8px; }
  table.info { width:100%; border-collapse:collapse; }
  table.info td { border:1px solid #b9c2cc; padding:6px 9px; vertical-align:top; }
  table.info td.k { background:#f2f5f8; width:22%; font-weight:600; color:#333; }
  table.info td.v { width:28%; }
  .block { border:1px solid #b9c2cc; padding:9px 11px; border-radius:4px; min-height:60px; }
  .sign { margin-top:34px; text-align:right; }
  .sign .unit { font-weight:600; }
  .stamp { display:inline-block; border:2px solid #c0392b; color:#c0392b; border-radius:50%; width:90px; height:90px; line-height:90px; text-align:center; font-size:13px; transform:rotate(-12deg); margin-top:6px; }
  .note { color:#888; font-size:11px; }
</style></head>
<body>
  <div class="redhead">智慧治理事件结案报告</div>
  <div class="sub">（城运中心处置回执闭环）</div>
  <div class="redline"></div>
  <div class="meta">报告编号：{{reportNo}}　|　生成日期：{{genDate}}</div>

  <h2>一、事件基本信息</h2>
  <table class="info">
    <tr><td class="k">事件类型</td><td class="v">{{eventType}}</td><td class="k">预警级别</td><td class="v">{{level}}</td></tr>
    <tr><td class="k">发生时间</td><td class="v" colspan="3">{{occurTime}}</td></tr>
    <tr><td class="k">发生地点</td><td class="v" colspan="3">{{location}}</td></tr>
    <tr><td class="k">经纬度</td><td class="v" colspan="3">经度 {{lon}}　纬度 {{lat}}</td></tr>
    <tr><td class="k">监测值</td><td class="v">{{value}}</td><td class="k">标准限值</td><td class="v">{{standard}}</td></tr>
    <tr><td class="k">推送平台</td><td class="v">{{platformName}}</td><td class="k">关联预案</td><td class="v">{{planName}}</td></tr>
    <tr><td class="k">触发次数</td><td class="v">{{triggerCount}}</td><td class="k">关联事件数</td><td class="v">{{eventCount}}</td></tr>
  </table>

  <h2>二、处置情况</h2>
  <div class="block">{{disposalResult}}</div>
  <table class="info" style="margin-top:8px;">
    <tr><td class="k" style="width:22%">处置人</td><td class="v" style="width:28%">{{disposalOperator}}</td><td class="k" style="width:22%">结案时间</td><td class="v" style="width:28%">{{closedAt}}</td></tr>
  </table>

  <h2>三、AI 视频分析置信度统计</h2>
  <table class="info">
    <tr><td class="k">样本数量</td><td class="v">{{aiConfidenceCount}}</td><td class="k">置信度范围</td><td class="v">{{aiConfidenceMin}} ~ {{aiConfidenceMax}}</td></tr>
    <tr><td class="k">置信度均值</td><td class="v" colspan="3">{{aiConfidenceAvg}}</td></tr>
  </table>

  <h2>四、证据附件</h2>
  <div class="block note">（此处附现场处置前/后照片、城运中心截图等，由系统自动嵌入）</div>

  <div class="sign">
    <div class="unit">万州区生态环保局</div>
    <div>{{genDate}}</div>
    <div class="stamp">已结案</div>
  </div>
</body></html>`

  // 默认工作报表 HTML 模板（kind='workreport'；周/月/年报+留痕查找，由后端预渲染 4 张表格注入，零前端依赖）
  const DEFAULT_WORKREPORT_TEMPLATE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif; color:#1a1a1a; font-size:12.5px; line-height:1.7; margin:0; }
  .redhead { text-align:center; color:#c0392b; font-weight:700; font-size:20px; letter-spacing:1px; }
  .sub { text-align:center; color:#555; font-size:12px; margin-top:2px; }
  .redline { border-top:3px solid #c0392b; margin:8px 0 12px; }
  .meta { text-align:right; color:#555; font-size:11px; margin-bottom:10px; }
  h2 { font-size:14px; border-left:4px solid #c0392b; padding-left:8px; margin:16px 0 8px; }
  table.grid { width:100%; border-collapse:collapse; font-size:12px; }
  table.grid th, table.grid td { border:1px solid #b9c2cc; padding:5px 8px; text-align:left; }
  table.grid th { background:#f2f5f8; }
  table.grid td.num { text-align:right; }
  .sign { margin-top:30px; text-align:right; }
  .stamp { display:inline-block; border:2px solid #c0392b; color:#c0392b; border-radius:50%; width:78px; height:78px; line-height:78px; text-align:center; font-size:12px; transform:rotate(-12deg); margin-top:6px; }
</style></head>
<body>
  <div class="redhead">{{reportTitle}}</div>
  <div class="sub">{{unitName}}　{{periodLabel}}</div>
  <div class="redline"></div>
  <div class="meta">生成日期：{{genDate}}</div>

  <h2>一、总体情况</h2>
  <table class="grid">
    <tr><th>推送总数</th><th>已结案</th><th>受理中</th><th>已推送</th></tr>
    <tr><td class="num">{{totalCount}}</td><td class="num">{{closedCount}}</td><td class="num">{{processingCount}}</td><td class="num">{{pushedCount}}</td></tr>
  </table>

  <h2>二、按事件类型分布</h2>
  {{byTypeTable}}

  <h2>三、按处置状态分布</h2>
  {{byStatusTable}}

  <h2>四、处置明细台账</h2>
  {{recordsTable}}

  <div class="sign">
    <div class="unit">{{unitName}}</div>
    <div>{{genDate}}</div>
    <div class="stamp">工作留痕</div>
  </div>
</body></html>`

  // ──────────────── 工作报表模板（周/月/年报，kind='workreport'） ────────────────

  // 周报模板：紧凑聚焦本周工作，卡片式汇总 + 日趋势 + 明细速查
  const WEEKLY_REPORT_TEMPLATE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:"Noto Sans CJK SC","Microsoft YaHei","WenQuanYi Zen Hei",sans-serif; color:#1a1a1a; font-size:11.5px; line-height:1.6; padding:20px 28px; background:#fff; }
  .hdr { text-align:center; border-bottom:2px solid #2563eb; padding-bottom:10px; margin-bottom:16px; }
  .hdr h1 { color:#1e40af; font-size:18px; letter-spacing:2px; }
  .hdr .sub { color:#64748b; font-size:11px; margin-top:3px; }
  .meta { display:flex; justify-content:space-between; color:#94a3b8; font-size:10.5px; margin-bottom:14px; }
  /* 汇总卡片 */
  .cards { display:flex; gap:10px; margin-bottom:16px; }
  .card { flex:1; border:1px solid #e2e8f0; border-radius:6px; padding:10px 12px; text-align:center; }
  .card .val { font-size:22px; font-weight:700; color:#1e40af; }
  .card .lbl { color:#64748b; font-size:10px; margin-top:2px; }
  .card.total { border-top:3px solid #2563eb; }
  .card.closed { border-top:3px solid #16a34a; } .card.closed .val { color:#15803d; }
  .card.processing { border-top:3px solid #f59e0b; } .card.processing .val { color:#d97706; }
  .card.pushed { border-top:3px solid #8b5cf6; } .card.pushed .val { color:#7c3aed; }
  h2 { font-size:13px; color:#334155; border-left:3.5px solid #2563eb; padding-left:8px; margin:16px 0 8px; }
  table.g { width:100%; border-collapse:collapse; font-size:11px; }
  table.g th,table.g td { border:1px solid #e2e8f0; padding:5px 7px; text-align:left; }
  table.g th { background:#f1f5f9; color:#475569; font-weight:600; white-space:nowrap; }
  table.g td.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.g tr:nth-child(even) td { background:#fafbfc; }
  .ft { margin-top:24px; text-align:right; color:#94a3b8; font-size:10px; border-top:1px solid #e2e8f0; padding-top:8px; }
</style></head>
<body>
  <div class="hdr">
    <h1>📋 智治推送周工作报表</h1>
    <div class="sub">{{unitName}} · {{periodLabel}}</div>
  </div>
  <div class="meta">
    <span>统计周期：{{periodLabel}}</span>
    <span>生成时间：{{genDate}}</span>
  </div>

  <div class="cards">
    <div class="card total"><div class="val">{{totalCount}}</div><div class="lbl">推送总数</div></div>
    <div class="card closed"><div class="val">{{closedCount}}</div><div class="lbl">已结案</div></div>
    <div class="card processing"><div class="val">{{processingCount}}</div><div class="lbl">受理中</div></div>
    <div class="card pushed"><div class="val">{{pushedCount}}</div><div class="lbl">已推送平台</div></div>
  </div>

  <h2>一、事件类型分布</h2>
  {{byTypeTable}}

  <h2>二、处置状态概览</h2>
  {{byStatusTable}}

  <h2>三、逐日趋势</h2>
  {{trendTable}}

  <h2>四、处置明细台账</h2>
  {{recordsTable}}

  <div class="ft">
    {{unitName}} · {{genDate}} · 本报表由系统自动生成，仅供内部工作留痕使用
  </div>
</body></html>`

  // 月报模板：标准商务格式，带封面信息栏 + 分类分析 + 平台维度 + 趋势 + 全量明细
  const MONTHLY_REPORT_TEMPLATE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing:border-box; }
  body { font-family:"Noto Sans CJK SC","WenQuanYi Zen Hei",sans-serif; color:#1a1a1a; font-size:11.5px; line-height:1.65; margin:0; padding:18px 26px; }
  /* 封面头 */
  .cover { background:linear-gradient(135deg,#1e3a5f 0%,#2d5a87 100%); color:#fff; padding:18px 22px; border-radius:6px; margin-bottom:14px; }
  .cover h1 { font-size:19px; letter-spacing:3px; margin:0; }
  .cover .line { opacity:.7; font-size:11px; margin-top:4px; }
  .cover .badge { display:inline-block; background:rgba(255,255,255,.18); border-radius:3px; padding:2px 8px; font-size:10px; margin-top:6px; }
  /* 信息栏 */
  .info-bar { display:flex; gap:8px; margin-bottom:14px; }
  .info-item { flex:1; background:#f8fafc; border:1px solid #e2e8f0; border-radius:4px; padding:7px 10px; text-align:center; }
  .info-item b { font-size:17px; color:#0f172a; }
  .info-item div { color:#64748b; font-size:9.5px; margin-top:1px; }
  h2 { font-size:13px; color:#1e293b; border-left:4px solid #2563eb; padding-left:9px; margin:18px 0 8px; }
  table.g { width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px; }
  table.g th,table.g td { border:1px solid #cbd5e1; padding:5px 8px; text-align:left; }
  table.g th { background:#f1f5f9; color:#334155; font-weight:600; }
  table.g td.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.g thead th:first-child { border-radius:4px 0 0 0; }
  table.g thead th:last-child { border-radius:0 4px 0 0; }
  .pct-bar { height:6px; background:#e2e8f0; border-radius:3px; overflow:hidden; display:inline-block; vertical-align:middle; width:80px; }
  .pct-fill { height:100%; background:#2563eb; border-radius:3px; }
  .sign { margin-top:26px; text-align:right; border-top:1px dashed #cbd5e1; padding-top:10px; color:#94a3b8; font-size:10px; }
</style></head>
<body>
  <div class="cover">
    <h1>{{reportTitle}}</h1>
    <div class="line">{{unitName}} · {{periodLabel}} 工作月报</div>
    <div class="badge">📊 系统自动生成 · 工作留痕</div>
  </div>

  <div class="info-bar">
    <div class="info-item"><b>{{totalCount}}</b><div>推送事件总数</div></div>
    <div class="info-item"><b>{{closedCount}}</b><div>已结案</div></div>
    <div class="info-item"><b>{{processingCount}}</b><div>受理中</div></div>
    <div class="info-item"><b>{{pushedCount}}</b><div>已推送城运</div></div>
  </div>

  <h2>一、事件类型分析</h2>
  {{byTypeTable}}

  <h2>二、处置状态分布</h2>
  {{byStatusTable}}

  <h2>三、时间趋势（按日/按月）</h2>
  {{trendTable}}

  <h2>四、全量处置明细台账</h2>
  <div style="color:#94a3b8;font-size:10px;margin-bottom:4px;">共 {{totalCount}} 条记录，按推送时间倒序排列</div>
  {{recordsTable}}

  <div class="sign">
    {{unitName}} · {{genDate}}<br>
    <span style="color:#cbd5e1;">本报表数据来源于智慧治理推送闭环系统，仅供内部工作留痕与汇报使用</span>
  </div>
</body></html>`

  // 年报模板：正式公文风格，红色主题，年度总览 + 季度聚合感 + 完整留痕归档
  const ANNUAL_REPORT_TEMPLATE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing:border-box; }
  body { font-family:"Noto Sans CJK SC","FangSong",STFangsong,"WenQuanYi Zen Hei",serif; color:#1a1a1a; font-size:12px; line-height:1.75; margin:0; padding:24px 32px; }
  /* 公文红头 */
  .red-head { text-align:center; border-bottom:3px double #c0392b; padding-bottom:10px; margin-bottom:16px; }
  .red-head .title { color:#c0392b; font-size:22px; font-weight:700; letter-spacing:4px; }
  .red-head .doc-no { color:#555; font-size:11px; margin-top:4px; }
  .red-line { border-top:2px solid #c0392b; margin:10px 0 14px; }
  .meta-row { display:flex; justify-content:space-between; color:#666; font-size:10.5px; margin-bottom:12px; padding:0 4px; }
  /* 总览大字 */
  .overview { background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:14px 18px; margin-bottom:14px; }
  .overview .big-num { font-size:32px; font-weight:700; color:#c0392b; }
  .overview .row { display:flex; gap:20px; margin-top:8px; }
  .overview .item { }
  .overview .item b { font-size:16px; color:#991b1b; }
  .overview .item span { color:#7f1d1d; font-size:10px; }
  h2 { font-size:13.5px; color:#333; border-left:4px solid #c0392b; padding-left:9px; margin:18px 0 9px; }
  table.gov { width:100%; border-collapse:collapse; font-size:11px; }
  table.gov th,table.gov td { border:1px solid #d4a5a5; padding:6px 9px; text-align:left; }
  table.gov th { background:#fef2f2; color:#7f1d1d; font-weight:600; }
  table.gov td.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.gov tr:hover td { background:#fffbeb; }
  .section-note { color:#999; font-size:10px; margin-bottom:4px; font-style:italic; }
  /* 尾签 */
  .footer-sign { margin-top:30px; text-align:right; }
  .footer-sign .org { font-weight:700; font-size:12px; }
  .stamp-box { display:inline-block; border:2.5px solid #c0392b; color:#c0392b; border-radius:50%; width:88px; height:88px; line-height:88px; text-align:center; font-size:12.5px; transform:rotate(-15deg); margin-top:8px; font-weight:700; }
  .disclaimer { margin-top:14px; color:#aaa; font-size:9.5px; text-align:center; border-top:1px solid #eee; padding-top:6px; }
</style></head>
<body>
  <div class="red-head">
    <div class="title">{{reportTitle}}</div>
    <div class="doc-no">{{unitName}} · 年度工作报表</div>
  </div>
  <div class="red-line"></div>
  <div class="meta-row">
    <span>统计周期：{{periodLabel}}</span>
    <span>生成日期：{{genDate}}</span>
  </div>

  <div class="overview">
    <div>本周期推送事件总数：<span class="big-num">{{totalCount}}</span>　件</div>
    <div class="row">
      <div class="item"><b>{{closedCount}}</b><br><span>已结案</span></div>
      <div class="item"><b>{{processingCount}}</b><br><span>受理中</span></div>
      <div class="item"><b>{{pushedCount}}</b><br><span>已推送至城运平台</span></div>
    </div>
  </div>

  <h2>一、事件类型统计分析</h2>
  <div class="section-note">以下为各类型事件的推送数量及占比情况：</div>
  {{byTypeTable}}

  <h2>二、处置状态统计</h2>
  <div class="section-note">反映各事件的当前处置进展与闭环状态：</div>
  {{byStatusTable}}

  <h2>三、时间趋势分析</h2>
  <div class="section-note">按时间维度展示推送频次变化规律：</div>
  {{trendTable}}

  <h2>四、完整处置台账（工作留痕）</h2>
  <div class="section-note">共计 {{totalCount}} 条推送记录，作为工作留痕归档备查：</div>
  {{recordsTable}}

  <div class="footer-sign">
    <div class="org">{{unitName}}</div>
    <div style="font-size:10.5px;color:#888;margin-top:2px;">{{genDate}}</div>
    <div class="stamp-box">工作留痕</div>
  </div>
  <div class="disclaimer">
    本报表由智慧治理推送系统自动生成，数据来源于 smart_push_history 闭环库。仅作内部工作留痕与年度汇报使用。
  </div>
</body></html>`

  // 种子默认模板（表为空时写入一次，后续可在管理页自由编辑/新增）
  if (!db.prepare('SELECT COUNT(*) c FROM smart_push_report_templates').get().c) {
    const now0 = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
    db.prepare(`INSERT INTO smart_push_report_templates (id,name,engine,content,is_default,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run('default', '默认结案报告模板', 'html', DEFAULT_REPORT_TEMPLATE_HTML, 1, '智慧治理事件结案报告默认版式', now0, now0)
  } else {
    // 自愈合：代码版式升级后，若默认结案模板尚未含 AI 置信度统计占位，则同步最新内容；已自定义的不覆盖
    const exD = db.prepare("SELECT content FROM smart_push_report_templates WHERE id = 'default'").get()
    if (exD && !exD.content.includes('aiConfidenceMin')) {
      const nowSync = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
      db.prepare("UPDATE smart_push_report_templates SET content = ?, updated_at = ? WHERE id = 'default'")
        .run(DEFAULT_REPORT_TEMPLATE_HTML, nowSync)
    }
  }
  // 种子默认工作报表模板（kind='workreport'，仅当缺工作报表模板时写入；与结案模板版式解耦）
  if (!db.prepare("SELECT COUNT(*) c FROM smart_push_report_templates WHERE kind = 'workreport'").get().c) {
    const nowWR = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
    db.prepare(`INSERT INTO smart_push_report_templates (id,name,engine,content,is_default,description,created_at,updated_at,kind) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('default-workreport', '默认工作报表模板', 'html', DEFAULT_WORKREPORT_TEMPLATE_HTML, 0, '智慧治理推送处置工作统计报表默认版式', nowWR, nowWR, 'workreport')
  } else {
    // 代码版式更新后，若默认模板仍是旧版（含"四、推送趋势"）则同步最新内容；已自定义的不覆盖
    const ex = db.prepare("SELECT content FROM smart_push_report_templates WHERE id = 'default-workreport'").get()
    if (ex && ex.content.includes('四、推送趋势')) {
      const nowSync = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
      db.prepare("UPDATE smart_push_report_templates SET content = ?, updated_at = ? WHERE id = 'default-workreport'")
        .run(DEFAULT_WORKREPORT_TEMPLATE_HTML, nowSync)
    }
  }
  // 种子周报/月报/年报专用模板（按 id 幂等，缺失才插入；用户可在管理页自由编辑）
  const wrTemplates = [
    { id:'weekly-report', name:'周报表（紧凑聚焦）', desc:'周度工作报表，卡片式汇总+逐日趋势+明细速查，适合每周例会快速汇报', html:WEEKLY_REPORT_TEMPLATE_HTML },
    { id:'monthly-report', name:'月报表（标准商务）', desc:'月度工作报表，商务蓝风格+分类分析+平台维度，适合月度总结汇报', html:MONTHLY_REPORT_TEMPLATE_HTML },
    { id:'annual-report', name:'年报表（正式公文）', desc:'年度工作报表，红色公文头+年度总览+完整留痕归档，适合年终汇报归档', html:ANNUAL_REPORT_TEMPLATE_HTML },
  ]
  const nowTpl = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  for (const t of wrTemplates) {
    if (!db.prepare('SELECT id FROM smart_push_report_templates WHERE id = ?').get(t.id)) {
      db.prepare(`INSERT INTO smart_push_report_templates (id,name,engine,content,is_default,description,created_at,updated_at,kind) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(t.id, t.name, 'html', t.html, 0, t.desc, nowTpl, nowTpl, 'workreport')
    }
  }

  // 种子「巴渝治气」目标平台（物联网系统已跑通对接；按 id 幂等，缺失才写入）
  // 来源：IoT平台(111.10.220.226:6881) 数据桥接配置 + Groovy规则脚本
  // 主接口=/aiProblem/lis/cgi/client/handle_event（告警事件），副接口=handle_event_other（图片附件）
  // 报文模板与请求头（主/副接口）：{xxx} 变量由 executePush 的 fillTemplate 替换
  // 映射关系（IoT脚本字段 -> 智治变量）：
  //   cameraId->{event_ids}  eventId->jsc-{push_id}  eventTime->{time}
  //   latitude/longitude->{lat}/{lon}  eventImgSmall/Big->{image_url}
  //   spid->通道SIP编号  deviceName->设备名称（新增，取自 AI分析存档）
  //   address->组合{location}+{time}+{description}  行政区划硬编码万州区龙都街道
  const platHeaders = JSON.stringify({
    Accept: '*/*',
    'Accept-Encoding': 'gzip,deflate',
    'Content-Type': 'application/json',
    'User-Agent': 'PostmanRuntime-ApipostRunt',
  })
  const platBody = JSON.stringify({
    cameraId: '{event_ids}',
    eventId: 'jsc-{push_id}',
    eventTime: '{time}',
    processEventId: '',
    eventType: 7,
    subType: 7,
    elevation: '',
    azimuth: '',
    absoluteZoom: '',
    confirm: 1,
    districtId: 500101000,
    districtName: '万州区',
    townId: 500101005,
    townName: '龙都街道',
    spid: '{spid}',
    deviceName: '{deviceName}',
    latitude: '{lat}',
    longitude: '{lon}',
    eventImgSmall: '{image_url}',
    eventImgBig: '{image_url}',
    address: '[{location}]截止于[{time}]{description}'
  })
  const platBodyOther = JSON.stringify({
    cameraId: '{event_ids}',
    eventIds: 'jsc-{push_id}',
    fileUrl: '{image_url}'
  })
  if (!db.prepare('SELECT id FROM smart_push_platforms WHERE id = ?').get('bayu-zhiqi')) {
    upsertSmartPushPlatform({
      id: 'bayu-zhiqi',
      name: '巴渝治气',
      api_url: 'http://23.213.61.6:8080/aiProblem/lis/cgi/client/handle_event',
      api_method: 'POST',
      api_headers: platHeaders,
      body_template: platBody,
      auth_mode: 'none',
      event_types: 'ALL',
      enabled: true,
      description: '巴渝治气平台(物联网系统已跑通对接): 主接口转发告警事件, 副接口转发图片附件',
      api_url_other: 'http://23.213.61.6:8080/aiProblem/lis/cgi/client/handle_event_other',
      api_method_other: 'POST',
      api_headers_other: platHeaders,
      body_template_other: platBodyOther,
    })
  } else {
    // 已存在：仅增补 body_template（主/副接口）中的 spid/deviceName 字段，不覆盖用户其他配置
    const nowPlat = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
    try {
      db.prepare("UPDATE smart_push_platforms SET body_template = ?, body_template_other = ?, updated_at = ? WHERE id = 'bayu-zhiqi'")
        .run(platBody, platBodyOther, nowPlat)
      console.log('[seed] 巴渝治气 平台模板已增补 spid/deviceName 字段')
    } catch (e) { console.warn('[seed] 巴渝治气 模板增补失败（可忽略，手动在管理页编辑即可）:', e.message) }
  }

  logRef.info ? logRef.info(`SQLite 已就绪: ${dbFile}（采集数据长期入库）`) : console.log('SQLite ready:', dbFile)
  return dbFile
}

// 解析 'YYYY-MM-DD HH:mm:ss'（上海时间，无时区标记）为时间戳；失败返回 NaN
function parseShanghaiTime(s) {
  if (!s) return NaN
  const t = s.trim().replace(' ', 'T')
  const d = new Date(t + (t.endsWith('Z') || t.includes('+') ? '' : '+08:00'))
  return d.getTime()
}

// ── 智治推送回调闭环 ──────────────────────────────────────────
// 推送成功后把涉及的告警事件标记为 pushed（已上报城运中心）
function markEventsPushed(eventIds) {
  if (!Array.isArray(eventIds) || !eventIds.length) return 0
  const stmt = db.prepare(`UPDATE smart_push_events SET status = 'pushed' WHERE id = ? AND status IN ('pending','pushed')`)
  let n = 0
  for (const id of eventIds) { n += stmt.run(id).changes }
  return n
}

// 接收城运中心处置回执（关联 push_id = smart_push_history.id），更新状态与处置结论
// status: 'processing' | 'closed'；disposalResult/disposalOperator/disposalTime 可选
function recordSmartPushCallback({ pushId, status, disposalResult, disposalOperator, disposalTime, body }) {
  const hist = db.prepare('SELECT * FROM smart_push_history WHERE id = ?').get(pushId)
  if (!hist) return { ok: false, error: '推送记录不存在', code: 404 }
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  const newStatus = (status === 'closed' || status === 'processing') ? status : hist.status
  db.prepare(`
    UPDATE smart_push_history
    SET status = ?, callback_body = ?, callback_status = 1, callback_time = ?,
        disposal_result = ?, disposal_operator = ?, closed_at = ?
    WHERE id = ?
  `).run(
    newStatus,
    body ? JSON.stringify(body) : (hist.callback_body || null),
    now,
    disposalResult || hist.disposal_result || null,
    disposalOperator || hist.disposal_operator || null,
    newStatus === 'closed' ? (disposalTime || now) : (hist.closed_at || null),
    pushId
  )
  // 同步把关联事件状态推进（closed 不可被回退）
  let eventIds = []
  try { eventIds = JSON.parse(hist.event_ids || '[]') } catch {}
  if (eventIds.length) {
    const stmt = db.prepare(`UPDATE smart_push_events SET status = ? WHERE id = ? AND status != 'closed'`)
    for (const id of eventIds) stmt.run(newStatus === 'closed' ? 'closed' : 'processing', id)
  }
  return { ok: true, status: newStatus }
}

// 人工一键结案（值守员在驾驶舱对 pushed/processing 的推送记录手动结案）
function closeSmartPushHistory(id, operator) {
  const hist = db.prepare('SELECT * FROM smart_push_history WHERE id = ?').get(id)
  if (!hist) return { ok: false, error: '推送记录不存在', code: 404 }
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  db.prepare(`
    UPDATE smart_push_history
    SET status = 'closed', disposal_operator = ?, closed_at = ?, callback_status = 1,
        callback_time = ?, disposal_result = ?
    WHERE id = ?
  `).run(
    operator || hist.disposal_operator || '人工',
    now, now,
    hist.disposal_result || '驾驶舱人工结案',
    id
  )
  let eventIds = []
  try { eventIds = JSON.parse(hist.event_ids || '[]') } catch {}
  if (eventIds.length) {
    const stmt = db.prepare(`UPDATE smart_push_events SET status = 'closed' WHERE id = ?`)
    for (const eid of eventIds) stmt.run(eid)
  }
  return { ok: true, status: 'closed' }
}

// 查询推送历史，支持事件类型/状态筛选 + 超时判定
// 超时：status='pushed' 且未收到任何回执，超过阈值（默认24h）即视为超时（前端红色告警）
// status 支持: pushed | processing | closed | timeout(特殊：内存过滤 is_timeout=1)
const SMART_PUSH_TIMEOUT_HOURS = 24
function getSmartPushHistory({ eventType, status, location, start, end, platformId, limit } = {}) {
  let sql = 'SELECT h.*, p.name AS platform_name FROM smart_push_history h LEFT JOIN smart_push_platforms p ON h.platform_id = p.id'
  const args = []
  const where = []
  if (eventType) { where.push('h.event_type = ?'); args.push(eventType) }
  if (status && status !== 'timeout') { where.push('h.status = ?'); args.push(status) }
  // 点位：模糊匹配（与规则「点位匹配(模糊)」口径一致）
  if (location) { where.push('h.location LIKE ?'); args.push('%' + String(location).trim() + '%') }
  // 目标平台：精确匹配 platform_id
  if (platformId) { where.push('h.platform_id = ?'); args.push(platformId) }
  // 时间段：created_at 为可词法排序的 'YYYY-MM-DD HH:MM:SS' 文本，直接字符串比较
  if (start) { where.push('h.created_at >= ?'); args.push(String(start)) }
  if (end) { where.push('h.created_at <= ?'); args.push(String(end)) }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY h.created_at DESC LIMIT ?'
  args.push(parseInt(limit) || 100)
  const rows = db.prepare(sql).all(...args)
  const now = Date.now()
  const timeoutMs = SMART_PUSH_TIMEOUT_HOURS * 3600 * 1000
  let result = rows.map(r => {
    let eventIds = []
    try { eventIds = JSON.parse(r.event_ids || '[]') } catch {}
    let isTimeout = 0
    if (r.status === 'pushed' && !r.callback_status) {
      const t = parseShanghaiTime(r.created_at)
      if (!isNaN(t) && (now - t) > timeoutMs) isTimeout = 1
    }
    return { ...r, success: !!r.success, event_ids: eventIds, is_timeout: isTimeout }
  })
  if (status === 'timeout') result = result.filter(r => r.is_timeout === 1)
  return result
}

// ── 目标平台（P2：可复用的推送连接配置）──────────────────────────
function normalizePlatformRow(r) {
  if (!r) return null
  let headers = {}
  try { headers = r.api_headers ? JSON.parse(r.api_headers) : {} } catch {}
  let headersOther = {}
  try { headersOther = r.api_headers_other ? JSON.parse(r.api_headers_other) : {} } catch {}
  return {
    ...r, enabled: !!r.enabled, api_headers: headers, event_types: r.event_types || '',
    api_headers_other: headersOther,
  }
}

function listSmartPushPlatforms() {
  return db.prepare('SELECT * FROM smart_push_platforms ORDER BY created_at DESC').all().map(normalizePlatformRow)
}

function getSmartPushPlatform(id) {
  return normalizePlatformRow(db.prepare('SELECT * FROM smart_push_platforms WHERE id = ?').get(id))
}

// 列表里某平台是否被哪些事件类型订阅（用于前端展示）
function platformSubscribes(platform, eventType) {
  const ets = (platform.event_types || '').split(',').map(s => s.trim()).filter(Boolean)
  return ets.includes('ALL') || ets.includes(eventType)
}

function upsertSmartPushPlatform(p) {
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  const exists = p.id && db.prepare('SELECT id FROM smart_push_platforms WHERE id = ?').get(p.id)
  const apiHeaders = (typeof p.api_headers === 'string') ? p.api_headers : JSON.stringify(p.api_headers || { 'Content-Type': 'application/json' })
  const apiHeadersOther = (typeof p.api_headers_other === 'string') ? p.api_headers_other : JSON.stringify(p.api_headers_other || {})
  if (exists) {
    db.prepare(`
      UPDATE smart_push_platforms SET name=?, api_url=?, api_method=?, api_headers=?,
        body_template=?, auth_mode=?, auth_key_name=?, event_types=?, enabled=?, description=?, updated_at=?,
        api_url_other=?, api_method_other=?, api_headers_other=?, body_template_other=?
      WHERE id=?
    `).run(
      p.name, p.api_url || '', p.api_method || 'POST', apiHeaders, p.body_template || '',
      p.auth_mode || 'none', p.auth_key_name || '', p.event_types || '', p.enabled === false ? 0 : 1, p.description || '', now,
      p.api_url_other || '', p.api_method_other || 'POST', apiHeadersOther, p.body_template_other || '', p.id
    )
    return { ok: true, id: p.id }
  }
  const id = p.id || require('crypto').randomUUID()
  db.prepare(`
    INSERT INTO smart_push_platforms (id, name, api_url, api_method, api_headers, body_template, auth_mode, auth_key_name, event_types, enabled, description, created_at, updated_at, api_url_other, api_method_other, api_headers_other, body_template_other)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, p.name, p.api_url || '', p.api_method || 'POST', apiHeaders, p.body_template || '',
    p.auth_mode || 'none', p.auth_key_name || '', p.event_types || '', p.enabled === false ? 0 : 1, p.description || '', now, now,
    p.api_url_other || '', p.api_method_other || 'POST', apiHeadersOther, p.body_template_other || ''
  )
  return { ok: true, id }
}

function deleteSmartPushPlatform(id) {
  db.prepare('DELETE FROM smart_push_platforms WHERE id = ?').run(id)
  // 解绑引用该平台的预案（置 platform_id 为 NULL），避免悬空引用
  db.prepare('UPDATE smart_push_plans SET platform_id = NULL WHERE platform_id = ?').run(id)
  return { ok: true }
}

// ── 第③环 PDF 结案报告模板 ──────────────────────────────────────
// 模板存库、版式可编辑；代码只负责取模板+填数据，不固化版式。
function listReportTemplates(kind) {
  let sql = 'SELECT id,name,engine,is_default,description,kind,blocks_json,created_at,updated_at,length(content) AS content_len FROM smart_push_report_templates'
  const args = []
  if (kind) { sql += ' WHERE kind = ?'; args.push(kind) }
  sql += ' ORDER BY is_default DESC, created_at DESC'
  return db.prepare(sql).all(...args)
    .map(r => ({ ...r, is_default: !!r.is_default }))
}
function getReportTemplate(id) {
  const r = db.prepare('SELECT * FROM smart_push_report_templates WHERE id = ?').get(id)
  return r ? { ...r, is_default: !!r.is_default } : null
}
function getDefaultReportTemplate(kind) {
  const k = kind || 'closure'
  const r = db.prepare('SELECT * FROM smart_push_report_templates WHERE kind = ? AND is_default = 1 ORDER BY updated_at DESC LIMIT 1').get(k)
  if (r) return { ...r, is_default: true }
  const any = db.prepare('SELECT * FROM smart_push_report_templates WHERE kind = ? ORDER BY created_at ASC LIMIT 1').get(k)
  return any ? { ...any, is_default: !!any.is_default } : null
}
function upsertReportTemplate(t) {
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  const exists = t.id && db.prepare('SELECT id FROM smart_push_report_templates WHERE id = ?').get(t.id)
  if (exists) {
    db.prepare('UPDATE smart_push_report_templates SET name=?, content=?, description=?, kind=?, blocks_json=?, updated_at=? WHERE id=?')
      .run(t.name, t.content, t.description || '', t.kind || 'closure', t.blocks_json || null, now, t.id)
    return { ok: true, id: t.id }
  }
  const id = t.id || require('crypto').randomUUID()
  db.prepare('INSERT INTO smart_push_report_templates (id,name,engine,content,is_default,description,created_at,updated_at,kind,blocks_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, t.name, 'html', t.content, 0, t.description || '', now, now, t.kind || 'closure', t.blocks_json || null)
  return { ok: true, id }
}
function setDefaultReportTemplate(id) {
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  db.prepare('UPDATE smart_push_report_templates SET is_default = 0').run()
  db.prepare('UPDATE smart_push_report_templates SET is_default = 1, updated_at = ? WHERE id = ?').run(now, id)
  return { ok: true }
}
function deleteReportTemplate(id) {
  const r = db.prepare('SELECT is_default FROM smart_push_report_templates WHERE id = ?').get(id)
  db.prepare('DELETE FROM smart_push_report_templates WHERE id = ?').run(id)
  if (r && r.is_default) {
    const next = db.prepare('SELECT id FROM smart_push_report_templates ORDER BY created_at ASC LIMIT 1').get()
    if (next) setDefaultReportTemplate(next.id)
  }
  return { ok: true }
}
// 聚合一条推送记录为结案报告变量（供模板 {{key}} 填充）
function getClosureReportData(historyId) {
  const h = db.prepare('SELECT * FROM smart_push_history WHERE id = ?').get(historyId)
  if (!h) return null
  let planName = '', platformName = ''
  if (h.plan_id) { const p = db.prepare('SELECT name FROM smart_push_plans WHERE id = ?').get(h.plan_id); planName = p ? p.name : '' }
  if (h.platform_id) { const p = db.prepare('SELECT name FROM smart_push_platforms WHERE id = ?').get(h.platform_id); platformName = p ? p.name : '' }
  if (!platformName) platformName = planName
  let eventIds = []; try { eventIds = JSON.parse(h.event_ids || '[]') } catch {}
  let events = []
  if (eventIds.length) {
    const ph = eventIds.map(() => '?').join(',')
    events = db.prepare(`SELECT * FROM smart_push_events WHERE id IN (${ph})`).all(...eventIds)
  }
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  const levelMap = { 0: '待定', 1: '一般', 2: '较重', 3: '严重' }
  const ev0 = events[0] || {}
  // AI 置信度统计（范围/均值/样本数）：聚合告警按 memberIds 反查多图置信度，单条取自身置信度
  const conf = computeAiConfidenceStats(events)
  return {
    reportNo: 'JSC-CLOSE-' + String(h.id || '').slice(0, 8).toUpperCase(),
    genDate: now,
    eventType: h.event_type || '',
    occurTime: h.created_at || '',
    location: h.location || '',
    lon: ev0.lon != null ? ev0.lon : '',
    lat: ev0.lat != null ? ev0.lat : '',
    level: levelMap[ev0.level] || '待定',
    value: ev0.value || '',
    standard: ev0.standard || '',
    triggerCount: h.trigger_count != null ? h.trigger_count : eventIds.length,
    eventCount: eventIds.length,
    platformName,
    planName,
    disposalResult: h.disposal_result || '',
    disposalOperator: h.disposal_operator || '',
    closedAt: h.closed_at || '',
    description: ev0.description || '',
    aiConfidenceMin: conf.min,
    aiConfidenceMax: conf.max,
    aiConfidenceAvg: conf.avg,
    aiConfidenceCount: conf.count,
  }
}
function setHistoryReportPath(historyId, pdfPath) {
  const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  db.prepare('UPDATE smart_push_history SET report_path = ?, report_generated_at = ? WHERE id = ?').run(pdfPath, now, historyId)
  return { ok: true }
}

// ── 智治推送「工作报表」聚合查询（周/月/季报 + 留痕查找，零新采集）──
// 上海时间格式化：'YYYY-MM-DD HH:mm:ss'
function fmtShanghai(date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {})
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}
// 周期预设 → 起止（上海时间）；自定义起止直接透传
function resolveRange(range, start, end) {
  const now = new Date()
  const nowStr = fmtShanghai(now)
  if (start && end) {
    const sStr = start.length <= 10 ? `${start} 00:00:00` : start
    const eStr = end.length <= 10 ? `${end} 23:59:59` : end
    return { label: `${start} ~ ${end}`, start: sStr, end: eStr }
  }
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {})
  const y = p.year, m = p.month, d = p.day
  let sStr, label
  if (range === 'week') {
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    const off = (dowMap[p.weekday] + 6) % 7
    const mon = new Date(now.getTime() - off * 86400000)
    const mp = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(mon).reduce((a, x) => (a[x.type] = x.value, a), {})
    sStr = `${mp.year}-${mp.month}-${mp.day} 00:00:00`
    label = `本周（${mp.month}-${mp.day} ~ ${d}日）`
  } else if (range === 'quarter') {
    const q = Math.floor((parseInt(m, 10) - 1) / 3)
    const qm = q * 3 + 1
    sStr = `${y}-${String(qm).padStart(2, '0')}-01 00:00:00`
    label = `${y}年Q${q + 1}`
  } else if (range === 'year') {
    sStr = `${y}-01-01 00:00:00`
    label = `${y}年`
  } else {
    sStr = `${y}-${m}-01 00:00:00`
    label = `${y}年${parseInt(m, 10)}月`
  }
  return { label, start: sStr, end: nowStr }
}

const WR_STATUS_LABEL = { pushed: '已推送', processing: '受理中', closed: '已结案' }

// 聚合推送历史为工作报表数据；完全复用 smart_push_history，无新采集
function getWorkReportData({ range, start, end, eventType, platformId, status, region, limit } = {}) {
  const period = resolveRange(range, start, end)
  const where = ['h.created_at >= ?', 'h.created_at <= ?']
  const args = [period.start, period.end]
  if (eventType) { where.push('h.event_type = ?'); args.push(eventType) }
  if (platformId) { where.push('h.platform_id = ?'); args.push(platformId) }
  if (status) { where.push('h.status = ?'); args.push(status) }
  if (region) { where.push('h.location LIKE ?'); args.push('%' + region + '%') }
  const wsql = 'WHERE ' + where.join(' AND ')
  const baseFrom = `FROM smart_push_history h LEFT JOIN smart_push_platforms p ON h.platform_id = p.id ${wsql}`

  const total = db.prepare(`SELECT COUNT(*) c ${baseFrom}`).get(...args).c
  const byStatus = db.prepare(`SELECT h.status AS status, COUNT(*) c ${baseFrom} GROUP BY h.status`).all(...args)
  const byType = db.prepare(`SELECT h.event_type AS event_type, COUNT(*) c ${baseFrom} GROUP BY h.event_type ORDER BY c DESC`).all(...args)
  const byPlatform = db.prepare(`SELECT COALESCE(NULLIF(p.name,''), h.platform_id, '未知') AS platform_name, COUNT(*) c ${baseFrom} GROUP BY platform_name`).all(...args)

  let pushed = 0, processing = 0, closed = 0
  for (const r of byStatus) {
    if (r.status === 'closed') closed = r.c
    else if (r.status === 'processing') processing = r.c
    else if (r.status === 'pushed') pushed = r.c
  }

  // 趋势：跨度≤62天按日，否则按月
  const sd = parseShanghaiTime(period.start), ed = parseShanghaiTime(period.end)
  const spanDays = isNaN(sd) || isNaN(ed) ? 0 : Math.max(0, Math.round((ed - sd) / 86400000))
  let trend = []
  if (spanDays <= 62) {
    const buckets = {}
    const cur = new Date(sd)
    while (cur <= ed) {
      const key = fmtShanghai(cur).slice(5, 10) // MM-DD
      buckets[key] = 0
      cur.setDate(cur.getDate() + 1)
    }
    const rows = db.prepare(`SELECT substr(h.created_at,1,10) day, COUNT(*) c ${baseFrom} GROUP BY day`).all(...args)
    for (const r of rows) { const k = (r.day || '').slice(5, 10); if (k in buckets) buckets[k] = r.c }
    trend = Object.keys(buckets).map(bucket => ({ bucket, count: buckets[bucket] }))
  } else {
    const rows = db.prepare(`SELECT substr(h.created_at,1,7) mon, COUNT(*) c ${baseFrom} GROUP BY mon`).all(...args)
    trend = rows.map(r => ({ bucket: r.mon, count: r.c }))
  }

  // 明细台账（按时间倒序，限制上限避免超大负载）
  const lim = Math.min(parseInt(limit) || 2000, 5000)
  const records = db.prepare(`
    SELECT h.id, h.created_at, h.event_type, h.location, h.status, h.trigger_count, h.closed_at,
           COALESCE(NULLIF(p.name,''), h.platform_id, '未知') AS platform_name,
           (CASE WHEN h.report_path IS NOT NULL AND h.report_path <> '' THEN 1 ELSE 0 END) AS has_report,
           h.report_path
    ${baseFrom} ORDER BY h.created_at DESC LIMIT ?
  `).all(...args, lim).map(r => ({
    id: r.id, created_at: r.created_at, event_type: r.event_type, location: r.location,
    status: r.status, platform_name: r.platform_name || '', trigger_count: r.trigger_count,
    closed_at: r.closed_at || '', hasReport: !!r.has_report, report_path: r.report_path || '',
  }))

  return {
    period,
    summary: {
      total, pushed, processing, closed,
      byType: byType.map(r => ({ event_type: r.event_type || '未分类', count: r.c })),
      byPlatform: byPlatform.map(r => ({ platform_name: r.platform_name || '未知', count: r.c })),
      byStatus: byStatus.map(r => ({ status: r.status || 'unknown', label: WR_STATUS_LABEL[r.status] || r.status || '未知', count: r.c })),
    },
    trend,
    records,
  }
}

// 行 → 原 record 结构（与旧 JSON 完全一致）
function rowToRecord(row) {
  if (!row) return null
  let pollutants = []
  try { pollutants = JSON.parse(row.pollutants_json || '[]') } catch {}
  return {
    id: row.id,
    pointCode: row.point_code,
    pointName: row.point_name,
    sourceType: row.source_type,
    monitorTime: row.monitor_time,
    aqi: row.aqi,
    pollutants,
    lat: row.lat,
    lon: row.lon,
    valid: row.valid !== 0,
    collectedAt: row.collected_at,
  }
}

/**
 * 插入一条采集记录。
 * @param {object} rec 含 id 的标准记录（id/valid/collectedAt 由调用方补齐）
 */
function insert(rec) {
  const stmt = db.prepare(`
    INSERT INTO collected
      (id, point_code, point_name, source_type, monitor_time, aqi, pollutants_json, lat, lon, valid, collected_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(
    rec.id,
    rec.pointCode ?? null,
    rec.pointName ?? null,
    rec.sourceType ?? null,
    rec.monitorTime ?? null,
    typeof rec.aqi === 'number' ? rec.aqi : (rec.aqi != null ? Number(rec.aqi) : null),
    JSON.stringify(rec.pollutants || []),
    typeof rec.lat === 'number' ? rec.lat : null,
    typeof rec.lon === 'number' ? rec.lon : null,
    rec.valid === false ? 0 : 1,
    rec.collectedAt || new Date().toISOString(),
  )
}

/**
 * 去重：是否已存在同点位+同监测时间的记录。
 */
function existsByPointTime(pointName, monitorTime) {
  const row = db.prepare('SELECT 1 FROM collected WHERE point_name = ? AND monitor_time = ? LIMIT 1')
    .get(pointName, monitorTime)
  return !!row
}

/**
 * 历史窗口：取某点位某污染物的"前一小时值"和"前4小时值数组"（新→旧）。
 * 仅取有效数据(valid=1)。
 * @param {string} pointCode
 * @param {Array} pollutants 当前记录的污染物（取其 code）
 * @returns {object} { [code]: { prevHour, prev4Hours:[] } }
 */
function buildHistory(pointCode, pollutants) {
  const history = {}
  // 取该点位最近若干条有效记录（足够覆盖前4小时），在内存里按 code 抽取
  const rows = db.prepare(`
    SELECT monitor_time, pollutants_json
    FROM collected
    WHERE point_code = ? AND valid = 1
    ORDER BY monitor_time DESC
    LIMIT 24
  `).all(pointCode)
  const parsed = rows.map(r => {
    let ps = []
    try { ps = JSON.parse(r.pollutants_json || '[]') } catch {}
    return { t: r.monitor_time, ps }
  })
  for (const p of pollutants || []) {
    const past = parsed
      .flatMap(r => r.ps.filter(pp => pp.code === p.code).map(pp => ({ t: r.t, v: pp.value })))
    // parsed 已按 monitor_time DESC，past 天然新→旧
    history[p.code] = {
      prevHour: past[0] ? past[0].v : null,
      prev4Hours: past.slice(0, 4).map(x => x.v),
    }
  }
  return history
}

/**
 * 查询采集记录（供 /api/collected）。
 * @param {object} opts { point?:string(模糊), limit?:number }
 * @returns {Array} record[]（新→旧）
 */
function query({ point, limit } = {}) {
  let sql = 'SELECT * FROM collected'
  const args = []
  if (point) { sql += ' WHERE point_name LIKE ?'; args.push('%' + point + '%') }
  sql += ' ORDER BY monitor_time DESC'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  return db.prepare(sql).all(...args).map(rowToRecord)
}

/**
 * 按时间范围查询有效记录（供 /api/stats、as-aq）。
 * @param {object} opts { sinceMonitorTime?:'YYYY-MM-DD HH:mm:ss', validOnly?:boolean, point?:string }
 * @returns {Array} record[]（旧→新，便于趋势绘制）
 */
function queryRange({ sinceMonitorTime, validOnly = true, point } = {}) {
  let sql = 'SELECT * FROM collected WHERE 1=1'
  const args = []
  if (validOnly) sql += ' AND valid = 1'
  if (sinceMonitorTime) { sql += ' AND monitor_time >= ?'; args.push(sinceMonitorTime) }
  if (point) { sql += ' AND (point_name = ? OR point_code = ?)'; args.push(point, point) }
  sql += ' ORDER BY monitor_time ASC'
  return db.prepare(sql).all(...args).map(rowToRecord)
}

/** 全部有效记录的点位名清单 */
function distinctPoints() {
  return db.prepare("SELECT DISTINCT point_name FROM collected WHERE valid = 1 AND point_name IS NOT NULL")
    .all().map(r => r.point_name)
}

/** 总记录数 / 有效数（健康检查用） */
function counts() {
  const total = db.prepare('SELECT COUNT(*) c FROM collected').get().c
  const valid = db.prepare('SELECT COUNT(*) c FROM collected WHERE valid = 1').get().c
  return { total, valid }
}

/** 原始执行器（迁移脚本用事务批量插入） */
function getDb() { return db }

// ════════════════════════════════════════════════════════════
//  其余三类记录表：warnings / collect_logs / sms_history / sms_reports
//  统一约定：data_json 存完整对象；读取 rowid DESC = 新→旧（等价原 unshift）。
// ════════════════════════════════════════════════════════════

// ── 预警 warnings ──
// ── 告警入库（2026-09-14 整改 #1.2 / #2.1）──
// ① 时间格式归一：历史遗留两种格式（iotcloud 本地串 'YYYY-MM-DD HH:mm:ss'、straw/cq_api UTC ISO），
//    导致字符串比较（如 created_at > datetime('now',...) 用 UTC 基准）在本地串上比较错误。
//    现统一：新入库一律转 UTC ISO（只对新数据生效，历史数据不动，读取侧继续双兼容）。
function normalizeCreatedAt(v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim()
  if (s.includes('T') || s.endsWith('Z')) return s          // 已是 ISO → 原样
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) return s
  // 本地（Asia/Shanghai）→ UTC ISO
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`)
  return isNaN(d.getTime()) ? s : d.toISOString()
}

// ② 入库后事件钩子（供告警 SSE 推送订阅；数据层不直接持有 HTTP 连接）
const warningListeners = new Set()
function onWarningInsert(cb) {
  warningListeners.add(cb)
  return () => warningListeners.delete(cb)
}

// ②-b P2-D：**研判准入 + 规则动作为 front_and_push** 时的钩子（供 index.js 接入智治推送链路
//      warnings → smart_push_events → checkRulesAndPush → 城运中心）。
//      与 onWarningInsert 同构：数据层只负责"通知"，不做 HTTP 推送，保持分层。
const pushListeners = new Set()
function onWarningAdmittedForPush(cb) {
  pushListeners.add(cb)
  return () => pushListeners.delete(cb)
}

// ── 事件研判逻辑（准入闸门）· P0-1 / P0-2 · 2026-09-19 ──────────────────────
// 语义升级：原「研判」只在**查询期**做降噪折叠（不够量就原样放行，形同虚设）；
//   现升级为**入库期准入闸门** —— 由研判裁定「这条告警该不该进驾驶舱前台」。
//   ① 算法识别的原始记录**一律入库留档**（存档页照常可见、可追溯、可复判）
//   ② judge_status 决定它**是否进前台实时告警**：blocked 只存档、不前台、不广播
// 判定口径（与查询期聚合 queryWarningsAggregated **共用 pickPushRule**，保证双轨同口径）：
//   · 命中规则：同「通道 + AI类型」在规则时间窗内累计条数 >= 阈值 → admitted
//               （并把本窗口内此前被拦下的同组记录一并准入，供前端聚合展示完整成员）
//   · 未达阈值 → blocked（仅存档）
//   · 未命中任何规则 → 按默认策略 JUDGE_DEFAULT_POLICY（当前保守为 admit）
// 🔴 重要（上线必读）：系统初始化时会**强制种一条通配默认规则**（见本文件上方 seed：
//    「AI视频24h≥5聚合(系统默认)」，channel_sip_id=null、ai_types=[] 匹配全部算法、24h、阈值 5、enabled=1，
//    且每次启动都会把该行重置为 ai_types='[]'/threshold=5/enabled=1）。
//    因此闸门上线后 **几乎所有 AI 告警都会进入研判**：同一「通道+AI类型」24h 内累计满 5 条才准入，
//    不足 5 条的会被静音（仅存档）。这是"研判决定前台告警"的预期效果，但会显著降低前台告警量。
//    操作建议：① 低频但重要的算法 → 单独配一条**阈值=1** 的专属规则（具体类型规则优先级高于通配）即全放行；
//             ② 上线前按「通道×算法」核一遍真实量级，再决定各组合的阈值；
//             ③ 确实不想让默认规则参与准入时，可在后台把该条停用（enabled=0）。
// 适用范围：仅 AI 分析类来源。cq_api 上报、城运回传等非 AI 来源直接准入（适用范围可配留待 P2）。
const JUDGE_SOURCES = ['iotcloud', 'straw-engine']
// P0-3 将开放为后台开关（app_settings.judge_default_policy）；此为**库中无设置时的默认值**
const JUDGE_DEFAULT_POLICY = 'admit'

/** P0-3：研判默认策略 —— 未命中任何规则时的处置（'admit' 放行 / 'block' 拦截）
 *  保守默认 admit：上线不会因"还没配规则"就把全部告警静音。 */
function getJudgeDefaultPolicy() {
  try {
    const r = db.prepare("SELECT value FROM app_settings WHERE key = 'judge_default_policy'").get()
    return (r && String(r.value || '').trim() === 'block') ? 'block' : JUDGE_DEFAULT_POLICY
  } catch (e) { return JUDGE_DEFAULT_POLICY }
}
function setJudgeDefaultPolicy(v) {
  const val = v === 'block' ? 'block' : 'admit'
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?,?,?)')
    .run('judge_default_policy', val, new Date().toISOString())
  return val
}

// ══════════════════════════════════════════════════════════════════════════
// 按算法保留期（软归档）· 2026-09-24
// ══════════════════════════════════════════════════════════════════════════
// 目标：驾驶舱前台实时告警保持清爽 —— 超期记录**不再进前台**，但库里数据一行不动。
//
// 🔴 与「告警过滤规则」的区别（别混用）：
//   · 过滤规则 = 按来源/位置/置信度/等级**永久隐藏**（人工判定为误报才用）
//   · 保留期   = 按**时间**自动过期（处置不过来的历史积压自动退出前台）
//
// 🔴 与「研判闸门」的区别：研判决定"够不够格进前台"，保留期决定"进前台多久"。
//
// 适用性判定三问（改这类过滤必须自答）：
//   ① 下游读哪张表：queryWarnings / queryWarningsAggregated（前台轨）+ latestPerChannel（地图灯）
//   ② return 在写入前/后：**只在查询期过滤**，insertWarning 一行不改 ⇒ 存档/导出完全不受影响
//   ③ 实测丢弃量：见 retentionDryRun()（后台「试运行」按钮）
// ──────────────────────────────────────────────────────────────────────────
// 配置缓存：queryWarnings 一次可扫 2 万行，不能每行查一次库；任何写操作立即失效。
let _retentionCfg = null
let _retentionCfgAt = 0
let _retentionVer = 0
const RETENTION_CFG_TTL_MS = 10000
function retentionConfig() {
  if (_retentionCfg && (Date.now() - _retentionCfgAt) < RETENTION_CFG_TTL_MS) return _retentionCfg
  const map = new Map()
  try {
    for (const r of db.prepare('SELECT ai_type, keep_days, enabled FROM algo_retention').all()) {
      const kd = Number(r.keep_days)
      map.set(String(r.ai_type), { keepDays: Number.isFinite(kd) && kd > 0 ? kd : 0, enabled: r.enabled === 1 })
    }
  } catch (e) { /* 表缺失（老库）→ 空配置 = 不归档，绝不因此报错 */ }
  _retentionCfg = map
  _retentionCfgAt = Date.now()
  return map
}
/** 配置版本号：供 iot-fetcher 的地图状态缓存判断"保留策略变了要重算" */
function retentionVersion() { return _retentionVer }
function invalidateRetentionCache() { _retentionCfg = null; _retentionCfgAt = 0; _retentionVer++ }

/** 某条告警适用的保留天数；**null = 不限制（永不软归档）**。
 *  解析顺序：算法精确配置 → 气体兜底（cq_api）→ __default__ → null（不限制）。
 *  🔴 任一层「已禁用」或「keepDays<=0」都按**不限制**处理 —— 宁可多显示，绝不静默吞掉告警。 */
function retentionKeepDays(w) {
  const cfg = retentionConfig()
  const ai = String((w && w.aiType) || '').trim()
  if (ai) {
    const hit = cfg.get(ai)
    if (hit) return (hit.enabled && hit.keepDays > 0) ? hit.keepDays : null
  }
  if (resolveSourceKey(w) === 'cq_api') {
    const g = cfg.get(RETENTION_GAS_KEY)
    if (g) return (g.enabled && g.keepDays > 0) ? g.keepDays : null
  }
  const d = cfg.get(RETENTION_DEFAULT_KEY)
  if (d) return (d.enabled && d.keepDays > 0) ? d.keepDays : null
  return null
}
/** 是否被保留期软归档（true = 不进前台）。
 *  ⚠️ 时间口径：createdAt 存的是**上海时间字符串**或 ISO，统一走 parseWarningTime（上海时）。
 *  时间无法解析 → **不归档**（宁可显示，避免静默吞掉）。 */
function warningRetentionExpired(w, nowMs) {
  if (!w) return false
  const kd = retentionKeepDays(w)
  if (kd === null) return false
  const t = parseWarningTime(w.createdAt)
  if (!Number.isFinite(t)) return false
  return ((nowMs || Date.now()) - t) > kd * 86400000
}

function _mapRetentionRow(r) {
  return {
    aiType: String(r.ai_type),
    keepDays: Number(r.keep_days) || 0,
    enabled: r.enabled === 1,
    remark: r.remark || '',
    updatedAt: r.updated_at || '',
  }
}
function getAlgoRetention(aiType) {
  const r = db.prepare('SELECT * FROM algo_retention WHERE ai_type = ?').get(String(aiType || ''))
  return r ? _mapRetentionRow(r) : null
}
/** 列表 = 已配置项 ∪ 库里实际出现过的算法 ∪ 两个约定键（未配置的也列出来，方便直接勾选配置） */
function listAlgoRetention() {
  const cfg = new Map()
  try {
    for (const r of db.prepare('SELECT * FROM algo_retention').all()) cfg.set(String(r.ai_type), _mapRetentionRow(r))
  } catch (e) { /* 表缺失 → 空 */ }
  const counts = new Map()
  try {
    const rows = db.prepare(
      "SELECT json_extract(data_json,'$.aiType') AS ai, COUNT(*) AS n FROM warnings " +
      "WHERE json_extract(data_json,'$.aiType') IS NOT NULL AND json_extract(data_json,'$.aiType') <> '' GROUP BY ai"
    ).all()
    for (const r of rows) counts.set(String(r.ai || '').trim(), Number(r.n) || 0)
  } catch (e) { /* 无数据不影响 */ }
  let gasCount = 0
  let totalCount = 0
  try {
    gasCount = Number((db.prepare("SELECT COUNT(*) AS n FROM warnings WHERE json_extract(data_json,'$.source') = 'cq_api'").get() || {}).n || 0)
    totalCount = Number((db.prepare('SELECT COUNT(*) AS n FROM warnings').get() || {}).n || 0)
  } catch (e) { /* noop */ }
  // 「默认」项是**兜底**而非真实算法：它名下条数 = 全库 − 气体 − 已单独配置的算法，
  //   即"会走兜底天数"的记录数（含 aiType 为空且非气体的老记录）。显示 0 会让人误以为没数据。
  const cfgAlgoKeys = new Set([...cfg.keys()].filter(k => !RETENTION_RESERVED_KEYS.includes(k)))
  let coveredByCfg = 0
  for (const [ai, n] of counts) if (cfgAlgoKeys.has(ai)) coveredByCfg += n
  const defaultRecords = Math.max(0, totalCount - gasCount - coveredByCfg)
  const keys = new Set([...cfg.keys(), ...counts.keys(), ...RETENTION_RESERVED_KEYS])
  const rank = k => (k === RETENTION_DEFAULT_KEY ? 0 : k === RETENTION_GAS_KEY ? 1 : 2)
  const ordered = [...keys].sort((a, b) => {
    const ra = rank(a), rb = rank(b)
    if (ra !== rb) return ra - rb
    return String(a).localeCompare(String(b), 'zh-Hans-CN')
  })
  return ordered.map(k => {
    const c = cfg.get(k)
    return {
      aiType: k,
      label: RETENTION_KEY_LABEL[k] || k,
      reserved: RETENTION_RESERVED_KEYS.includes(k),
      configured: !!c,
      keepDays: c ? c.keepDays : null,       // null = 未单独配置（走兜底）
      enabled: c ? c.enabled : true,
      remark: c ? c.remark : '',
      updatedAt: c ? c.updatedAt : '',
      totalRecords: k === RETENTION_GAS_KEY ? gasCount : (k === RETENTION_DEFAULT_KEY ? defaultRecords : (counts.get(k) || 0)),
    }
  })
}
function upsertAlgoRetention({ aiType, keepDays, enabled, remark }) {
  const key = String(aiType || '').trim()
  if (!key) throw new Error('aiType 不能为空')
  let kd = Number(keepDays)
  if (!Number.isFinite(kd) || kd < 0) kd = 0
  kd = Math.round(kd * 100) / 100          // 允许 0.5 天这类粒度，最多两位小数
  const now = new Date().toISOString()
  db.prepare(
    'INSERT INTO algo_retention (ai_type, keep_days, enabled, remark, updated_at) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(ai_type) DO UPDATE SET keep_days=excluded.keep_days, enabled=excluded.enabled, ' +
    'remark=excluded.remark, updated_at=excluded.updated_at'
  ).run(key, kd, enabled === false ? 0 : 1, String(remark || ''), now)
  invalidateRetentionCache()
  return getAlgoRetention(key)
}
function deleteAlgoRetention(aiType) {
  const key = String(aiType || '').trim()
  if (!key) return 0
  if (RETENTION_RESERVED_KEYS.includes(key)) throw new Error('约定键不可删除（可改为停用 = 不限制）')
  const n = db.prepare('DELETE FROM algo_retention WHERE ai_type = ?').run(key).changes
  invalidateRetentionCache()
  return n
}
/** 试运行：完全复刻前台口径（排除 blocked / 命中过滤规则），统计「按当前配置有多少条会被归档」。
 *  ⚠️ 只读，不改任何数据。oldestAt/newestAt 用于让管理员判断天数定得合不合理。 */
function retentionDryRun({ limit } = {}) {
  const now = Date.now()
  const cap = Math.min(Math.max(Number(limit) || 30000, 1000), 200000)
  const rows = db.prepare('SELECT id, created_at, data_json FROM warnings ORDER BY rowid DESC LIMIT ?').all(cap)
  let truncated = false
  try {
    const tot = db.prepare('SELECT COUNT(*) AS n FROM warnings').get()
    if (tot && Number(tot.n) > cap) truncated = true
  } catch (e) { /* noop */ }
  const per = new Map()
  let scanned = 0
  const nowIso = new Date().toISOString()
  for (const r of rows) {
    let w; try { w = JSON.parse(r.data_json) } catch (e) { continue }
    if ((w.judgeStatus || '') === 'blocked') continue       // 前台本就看不到
    if (alertFilterRuleHit(w)) continue                     // 被静音规则隐藏
    scanned++
    const expired = warningRetentionExpired(w, now)
    const kd = retentionKeepDays(w)
    const ai = String(w.aiType || '').trim()
    const key = ai || (resolveSourceKey(w) === 'cq_api' ? RETENTION_GAS_KEY : '(无算法)')
    let e = per.get(key)
    if (!e) {
      e = { aiType: key, label: RETENTION_KEY_LABEL[key] || key, keepDays: kd, visibleBefore: 0, willArchive: 0, oldestAt: '', newestAt: '' }
      per.set(key, e)
    }
    e.visibleBefore++
    if (expired) e.willArchive++
    const at = String(w.createdAt || '')
    if (at) {
      if (!e.newestAt || at > e.newestAt) e.newestAt = at
      if (!e.oldestAt || at < e.oldestAt) e.oldestAt = at
    }
  }
  const items = [...per.values()]
    .map(e => ({ ...e, remain: e.visibleBefore - e.willArchive }))
    .sort((a, b) => b.willArchive - a.willArchive || b.visibleBefore - a.visibleBefore)
  const totalBefore = items.reduce((s, e) => s + e.visibleBefore, 0)
  const totalArchive = items.reduce((s, e) => s + e.willArchive, 0)
  return {
    at: nowIso, scanned, cap, truncated,
    totalBefore, totalArchive, totalRemain: totalBefore - totalArchive,
    archiveRate: totalBefore ? Number((totalArchive / totalBefore * 100).toFixed(1)) : 0,
    items,
  }
}

/** P0-3：研判覆盖面 —— 近 days 天**实际发生过**、但未被任何启用规则覆盖的「通道 × AI类型」组合。
 *  用途：默认策略切成「拦截」前，先让管理员看清会波及哪些组合、各多少条，避免一上线全静音。 */
function judgeCoverage(days = 7) {
  const n = Math.max(1, Math.min(Number(days) || 7, 90))
  const since = Date.now() - n * 86400000
  const rules = listPushRules().filter(r => r.enabled)
  const rows = db.prepare(
    "SELECT created_at, data_json FROM warnings WHERE json_extract(data_json,'$.source') IN ('iotcloud','straw-engine') ORDER BY rowid DESC LIMIT 20000"
  ).all()
  const map = new Map()
  for (const r of rows) {
    const t = parseWarningTime(r.created_at)
    if (isNaN(t) || t < since) continue
    let o; try { o = JSON.parse(r.data_json) } catch { continue }
    const cid = warningChannelKey(o)
    const ai = o.aiType || '(未知)'
    const key = cid + '|' + ai
    let e = map.get(key)
    if (!e) {
      e = { channelSipId: cid, aiType: ai, count: 0, covered: !!pickPushRule(rules, cid, ai), blocked: 0 }
      map.set(key, e)
    }
    e.count++
    if (o.judgeStatus === 'blocked') e.blocked++
  }
  const all = [...map.values()].map(e => ({
    ...e,
    channelName: e.channelSipId ? ((getIotChannel(e.channelSipId) || {}).channelName || e.channelSipId) : '全部通道',
  }))
  all.sort((a, b) => b.count - a.count)
  return {
    days: n,
    policy: getJudgeDefaultPolicy(),
    ruleCount: rules.length,
    comboCount: all.length,
    coveredCount: all.filter(e => e.covered).length,
    uncovered: all.filter(e => !e.covered),
    combos: all,
  }
}

/** P2：研判规则**冲突检测**（防"配了永不生效"）。
 *  pickPushRule 用 `find()` 只取**第一条**（listPushRules 按 created_at DESC），
 *  同一优先级层里若有多条规则覆盖同一「通道×AI类型」，后面的会**静默失效**——
 *  这是最容易踩的坑，必须在界面上显式提示。
 *  注意：1 条具体类型规则 + 1 条通配规则 **不算冲突**（前者优先、后者兜底其它组合）；
 *        只有"具体层内多条"或"通配层内多条"才是真冲突。 */
function judgeRuleConflicts() {
  const rules = listPushRules().filter(r => r.enabled)
  const combos = new Set()
  try {
    for (const ch of listIotChannels().filter(c => c.enabled)) {
      for (const ai of (ch.aiTypes || [])) combos.add(ch.channelSipId + '|' + ai)
    }
  } catch (e) { /* iot_channels 不可用时退化为仅用规则自身声明的组合 */ }
  for (const r of rules) {
    if (r.aiTypes.length === 0) continue           // 通配规则不声明具体组合，靠通道侧枚举覆盖
    for (const ai of r.aiTypes) {
      combos.add((r.channelSipId || '') + '|' + ai)
    }
  }
  const conflicts = []
  for (const key of combos) {
    const idx = key.indexOf('|')
    const cid = key.slice(0, idx) || null
    const ai = key.slice(idx + 1)
    const matched = rules.filter(rl => pickPushRule([rl], cid, ai))
    if (matched.length <= 1) continue
    const specific = matched.filter(rl => rl.aiTypes.includes(ai))
    const wildcard = matched.filter(rl => rl.aiTypes.length === 0)
    const layer = specific.length > 1 ? specific : (wildcard.length > 1 ? wildcard : null)
    if (!layer) continue
    conflicts.push({
      channelSipId: cid,
      channelName: cid ? ((getIotChannel(cid) || {}).channelName || cid) : '全部通道',
      aiType: ai,
      layer: specific.length > 1 ? 'specific' : 'wildcard',
      winner: { id: layer[0].id, name: layer[0].name },
      shadowed: layer.slice(1).map(rl => ({ id: rl.id, name: rl.name })),
    })
  }
  return { count: conflicts.length, conflicts: conflicts.slice(0, 50) }
}

/** P2-F：按「启用通道 × 该通道已接入算法」**批量生成研判规则**（配合"逐通道逐算法精细配置"）。
 *  默认 dryRun=true 只返回计划，不写库；dryRun=false 才真正创建。
 *  已存在同「通道+算法」规则的组合默认跳过（overwrite=true 才更新其阈值等参数）。 */
function generatePushRulesForChannels({
  threshold = 5, timeWindowHours = 24, minConfidence = 0, minLevel = 0,
  activeHours = '', action = 'admit_front', overwrite = false, dryRun = true,
} = {}) {
  const rules = listPushRules()
  const chs = listIotChannels().filter(c => c.enabled)
  const plan = []
  for (const ch of chs) {
    for (const ai of (ch.aiTypes || [])) {
      const exist = pickPushRule(rules, ch.channelSipId, ai)
      // 只有"正好是这条通道+这个算法"的规则才算已存在（通配规则不算，避免误判为已配）
      const exact = rules.find(r => r.channelSipId === ch.channelSipId && r.aiTypes.includes(ai))
      plan.push({
        channelSipId: ch.channelSipId,
        channelName: ch.channelName || ch.channelSipId,
        aiType: ai,
        existingRuleId: exact ? exact.id : null,
        existingRuleName: exact ? exact.name : null,
        // 当前会被哪条规则接住（可能是通配规则 → 提示"现在靠通配兜底，规范化后会由专属规则接管"）
        currentlyMatchedBy: exist ? exist.name : null,
        willSkip: !!exact && !overwrite,
      })
    }
  }
  const created = []
  if (!dryRun) {
    for (const p of plan) {
      if (p.willSkip) continue
      const name = `${p.channelName}·${p.aiType}`
      if (p.existingRuleId && overwrite) {
        updatePushRule(p.existingRuleId, {
          threshold: Number(threshold) || 5, timeWindowHours: Number(timeWindowHours) || 24,
          minConfidence: Number(minConfidence) || 0, minLevel: Number(minLevel) || 0,
          activeHours: String(activeHours || ''), action, enabled: true,
        })
        created.push({ ...p, action: 'updated' })
      } else {
        const r = createPushRule({
          name, channel_sip_id: p.channelSipId, ai_types: [p.aiType],
          time_window_hours: timeWindowHours, threshold, enabled: true,
          min_confidence: minConfidence, min_level: minLevel, active_hours: activeHours, action,
        })
        created.push({ ...p, action: 'created', ruleId: r && r.id })
      }
    }
  }
  return {
    dryRun: !!dryRun,
    defaults: { threshold, timeWindowHours, minConfidence, minLevel, activeHours, action, overwrite },
    total: plan.length,
    toCreate: plan.filter(p => !p.existingRuleId).length,
    toUpdate: overwrite ? plan.filter(p => p.existingRuleId).length : 0,
    skipped: plan.filter(p => p.willSkip).length,
    plan,
    created,
  }
}

/** P1-3：研判命中统计 —— 近 days 天每条规则的「准入/拦下」量与准入率，用于阈值调优。
 *  judge_rule_id 为空的记录 = 未命中任何规则（由默认策略处理），单独统计。 */
function judgeStats(days = 7) {
  const n = Math.max(1, Math.min(Number(days) || 7, 90))
  const since = Date.now() - n * 86400000
  const rows = db.prepare(
    "SELECT created_at, judge_rule_id, judge_status FROM warnings WHERE json_extract(data_json,'$.source') IN ('iotcloud','straw-engine') ORDER BY rowid DESC LIMIT 20000"
  ).all()
  const byRule = new Map()
  const noRule = { admitted: 0, blocked: 0 }
  let total = 0, admitted = 0, blocked = 0
  for (const r of rows) {
    const st = r.judge_status
    if (st !== 'admitted' && st !== 'blocked') continue
    const t = parseWarningTime(r.created_at)
    if (isNaN(t) || t < since) continue
    total++
    if (st === 'admitted') admitted++; else blocked++
    const key = r.judge_rule_id || ''
    if (!key) { noRule[st]++; continue }
    if (!byRule.has(key)) byRule.set(key, { admitted: 0, blocked: 0 })
    byRule.get(key)[st]++
  }
  const rules = [...byRule.entries()].map(([id, v]) => {
    const tot = v.admitted + v.blocked
    return {
      ruleId: id,
      ruleName: (getPushRule(id) || {}).name || '(规则已删除)',
      admitted: v.admitted, blocked: v.blocked, total: tot,
      admitRate: tot ? v.admitted / tot : 0,
    }
  }).sort((a, b) => b.total - a.total)
  return {
    days: n, total, admitted, blocked,
    admitRate: total ? admitted / total : 0,
    noRule: { ...noRule, total: noRule.admitted + noRule.blocked },
    rules,
  }
}

/** P1-4：规则**试跑**（dry-run）—— 用近 days 天**历史数据回放**，不改任何数据、不产生任何告警。
 *  只对"该规则会命中的组合"逐条重放；累计口径与实跑完全一致（按 (通道,AI类型) 维护时间窗内条数），
 *  维度判定复用 evalRuleAgainst —— 保证「试跑结论」与「上线后实跑」一致。 */
function judgeDryRun(draft = {}, days = 7) {
  const n = Math.max(1, Math.min(Number(days) || 7, 90))
  const since = Date.now() - n * 86400000
  const rule = {
    name: String(draft.name || '（未命名草案）'),
    channelSipId: draft.channelSipId ?? draft.channel_sip_id ?? null,
    aiTypes: Array.isArray(draft.aiTypes) ? draft.aiTypes
      : (Array.isArray(draft.ai_types) ? draft.ai_types : (draft.ai_types ? [draft.ai_types] : [])),
    timeWindowHours: Number(draft.timeWindowHours ?? draft.time_window_hours) || 24,
    threshold: Number(draft.threshold) || 20,
    minConfidence: Number(draft.minConfidence ?? draft.min_confidence) || 0,
    minLevel: Number(draft.minLevel ?? draft.min_level) || 0,
    activeHours: String(draft.activeHours ?? draft.active_hours ?? ''),
    action: normAction(draft.action),
  }
  const rows = db.prepare(
    "SELECT created_at, data_json FROM warnings WHERE json_extract(data_json,'$.source') IN ('iotcloud','straw-engine') ORDER BY rowid DESC LIMIT 20000"
  ).all()
  const items = []
  for (const r of rows) {
    const t = parseWarningTime(r.created_at)
    if (isNaN(t) || t < since) continue
    let o; try { o = JSON.parse(r.data_json) } catch { continue }
    items.push({ t, o })
  }
  items.sort((a, b) => a.t - b.t)          // 正序回放
  const winMs = rule.timeWindowHours * 3600 * 1000
  const times = new Map()
  let matched = 0, admitted = 0, blocked = 0
  const byCombo = new Map()
  const reasons = new Map()
  for (const { t, o } of items) {
    const cid = warningChannelKey(o)
    const ai = o.aiType || '(未知)'
    if (!pickPushRule([rule], cid, ai)) continue      // 本规则不命中 → 不在本次试跑范围
    matched++
    const key = cid + '|' + ai
    if (!times.has(key)) times.set(key, [])
    const arr = times.get(key)
    arr.push(t)
    while (arr.length && arr[0] < t - winMs) arr.shift()   // 清出时间窗
    const fail = rule.action === 'archive_only'
      ? '动作为「仅存档」'
      : evalRuleAgainst(rule, o, arr.length, t)
    const stat = byCombo.get(key) || { channelSipId: cid, aiType: ai, admitted: 0, blocked: 0 }
    if (fail) { blocked++; stat.blocked++; reasons.set(fail, (reasons.get(fail) || 0) + 1) }
    else { admitted++; stat.admitted++ }
    byCombo.set(key, stat)
  }
  return {
    days: n, rule,
    matched, admitted, blocked,
    admitRate: matched ? admitted / matched : 0,
    byCombo: [...byCombo.values()].sort((a, b) => (b.admitted + b.blocked) - (a.admitted + a.blocked)),
    topReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    note: '试跑基于历史数据回放，只对"本规则命中的组合"生效；未命中本规则的记录不受影响。',
  }
}

/** 规则匹配（**唯一出处**：查询期聚合与本处闸门共用，避免两处逻辑漂移）
 *  优先级：业务方「具体类型」规则 > 系统默认「通配(空 ai_types)」规则
 *  （否则通配总抢先命中、自定义阈值失效 —— 沿用 queryWarningsAggregated 既有口径） */
function pickPushRule(rules, cid, ai) {
  const matchByType = (rl) => (rl.channelSipId == null || rl.channelSipId === cid) && rl.aiTypes.includes(ai)
  const matchWildcard = (rl) => rl.aiTypes.length === 0 && (rl.channelSipId == null || rl.channelSipId === cid)
  return rules.find(matchByType) || rules.find(matchWildcard) || null
}

/** 与聚合同口径的分组键：通道（无则退用 streamId，如 straw-engine 源无 channelSipId） */
function warningChannelKey(w) {
  return w.channelSipId || w.streamId || null
}

/** 告警置信度归一为**百分比**（兼容 0-1 与 0-100 两种存量口径，与「告警过滤规则」一致）；无法解析返回 null */
function warningConfPct(w) {
  const raw = w && w.aiConfidence
  if (raw === null || raw === undefined || raw === '') return null
  const c = Number(raw)
  if (!Number.isFinite(c)) return null
  return c > 1 ? c : c * 100
}

/** P1-1：生效时段判定（**一律上海时间 UTC+8**，与项目时间铁律一致）。
 *  spec 形如 ''（全天）/ '8-18' / '20-6'（跨夜）/ '8-12,14-18'；无法解析的段一律忽略。 */
function inActiveHours(spec, ts) {
  const s = String(spec || '').trim()
  if (!s) return true
  const sh = new Date(ts + 8 * 3600 * 1000)          // +8h 后取 UTC 分量 = 上海本地时间
  const cur = sh.getUTCHours() * 60 + sh.getUTCMinutes()
  let parsed = 0
  for (const seg of s.split(',')) {
    const m = /^\s*(\d{1,2})\s*[-~至]\s*(\d{1,2})\s*$/.exec(seg)
    if (!m) continue
    const a = Math.min(23, Math.max(0, Number(m[1]))) * 60
    const b = Math.min(23, Math.max(0, Number(m[2]))) * 60
    if (a === b) continue
    parsed++
    if (a < b) { if (cur >= a && cur < b) return true }
    else { if (cur >= a || cur < b) return true }     // 跨夜（如 20-6）
  }
  return parsed === 0 ? true : false                  // 全部段都无法解析 → 视作不限（不误伤）
}

/** 按「置信度 → 等级 → 时段 → 频率」顺序逐项短路判定一条记录。
 *  返回 **null 表示全部维度通过**；否则返回被拦下的原因字符串。
 *  仅供 judgeWarning 与 judgeDryRun 共用 —— 保证「试跑」与「实跑」结论必然一致。 */
function evalRuleAgainst(rule, w, nth, nowTs) {
  // 维度③ 置信度（记录未给置信度 → 跳过该维度，不做无依据的拦截）
  const minConf = Number(rule.minConfidence) || 0
  if (minConf > 0) {
    const pct = warningConfPct(w)
    if (pct !== null && pct < minConf) return `置信度 ${pct.toFixed(0)}% < 门槛 ${minConf}%`
  }
  // 维度④ 最低等级（level 缺失/为 0 → 跳过）
  const minLv = Number(rule.minLevel) || 0
  const lv = Number(w.level)
  if (minLv > 0 && Number.isFinite(lv) && lv > 0 && lv < minLv) return `等级 ${lv} < 门槛 ${minLv}`
  // 维度⑤ 生效时段（上海时）
  const ts = parseWarningTime(w.createdAt)
  const at = Number.isNaN(ts) ? (nowTs || Date.now()) : ts
  if (!inActiveHours(rule.activeHours, at)) return `不在生效时段「${rule.activeHours}」（上海时）`
  // 维度⑥ 频率阈值
  const threshold = Number(rule.threshold) || 20
  const winH = Number(rule.timeWindowHours) || 24
  if (nth < threshold) return `${winH}h 内同类累计 ${nth}/${threshold} 条，未达阈值`
  return null
}

/** 裁定一条「待入库」告警 → { status, ruleId, reason, promote? }
 *  注意：调用时本条**尚未入库**，故累计数需 +1（nth）。 */
function judgeWarning(w) {
  const src = w.source || ''
  if (!JUDGE_SOURCES.includes(src)) {
    return { status: 'admitted', ruleId: null, reason: `来源「${src || '未知'}」非 AI 分析类，不适用研判 → 直接准入` }
  }
  const rules = listPushRules().filter(r => r.enabled)
  const cid = warningChannelKey(w)
  const ai = w.aiType || '(未知)'
  const rule = pickPushRule(rules, cid, ai)
  if (!rule) {
    return getJudgeDefaultPolicy() === 'block'
      ? { status: 'blocked', ruleId: null, reason: '未命中任何研判规则，默认策略=拦截（仅存档）' }
      : { status: 'admitted', ruleId: null, reason: '未命中任何研判规则，默认放行' }
  }
  // P1-2 动作：仅存档 = 强制不进前台（不看阈值，业务方显式要求"这类只留痕不报警"）
  if (rule.action === 'archive_only') {
    return { status: 'blocked', ruleId: rule.id, reason: `「${rule.name}」动作为「仅存档」→ 不进前台` }
  }
  const winH = Number(rule.timeWindowHours) || 24
  const winMs = winH * 3600 * 1000
  const now = Date.now()
  // 累计口径：窗口内**全部同组原始记录**（含此前被拦下的）—— 即"这类现象在窗口内出现了几次"。
  //   刻意不在 SQL 里按 created_at 做字符串比较：本库 created_at 存在 ISO(UTC) 与上海本地串两种格式，
  //   字符串比较会漏算；统一走 parseWarningTime（与聚合口径一致）。warnings 上限 2000 行，扫描有界。
  const prior = db.prepare(
    "SELECT id, created_at, data_json FROM warnings WHERE COALESCE(json_extract(data_json,'$.aiType'),'(未知)') = ? ORDER BY rowid DESC LIMIT 3000"
  ).all(ai)
  const sameGroup = []
  for (const r of prior) {
    let o; try { o = JSON.parse(r.data_json) } catch { continue }
    if (warningChannelKey(o) !== cid) continue
    const t = parseWarningTime(r.created_at)
    if (isNaN(t) || (now - t) > winMs) continue
    sameGroup.push({ id: r.id, blocked: o.judgeStatus === 'blocked' })
  }
  const nth = sameGroup.length + 1   // 含本条
  const fail = evalRuleAgainst(rule, w, nth)
  if (fail) {
    return { status: 'blocked', ruleId: rule.id, reason: `「${rule.name}」${fail} → 仅存档，不进前台` }
  }
  return {
    status: 'admitted', ruleId: rule.id, action: rule.action,
    reason: `「${rule.name}」${winH}h 内同类累计 ${nth}/${Number(rule.threshold) || 20} 条${describeGates(rule)}，达门槛 → 进前台实时告警`,
    promote: sameGroup.filter(g => g.blocked).map(g => g.id),
  }
}

function describeGates(rule) {
  const parts = []
  if (Number(rule.minConfidence) > 0) parts.push(`置信度≥${rule.minConfidence}%`)
  if (Number(rule.minLevel) > 0) parts.push(`等级≥${rule.minLevel}`)
  if (rule.activeHours) parts.push(`时段「${rule.activeHours}」`)
  return parts.length ? `，且满足 ${parts.join('、')}` : ''
}

function insertWarning(w) {
  const createdAt = normalizeCreatedAt(w.createdAt)
  // data_json 与 created_at 列保持同源（前端读 data_json.createdAt）
  const rec = createdAt === w.createdAt ? w : { ...w, createdAt }
  // ── P0-1：入库前裁定「是否进驾驶舱前台实时告警」
  //    研判执行异常一律**保守放行** —— 绝不允许因判定失败而丢告警（告警安全高于降噪）
  //    幂等保护：同一 id 重复入库（改坐标 fixExistingRows / 改处置状态 / 城运回写）**沿用既有判定**，
  //      绝不重判 —— 否则服务重启时 fixExistingRows 会把已准入的记录按"当前窗口"重判成 blocked（回归）。
  const existed = db.prepare('SELECT judge_status, judge_rule_id, judge_reason, judged_at FROM warnings WHERE id = ?').get(rec.id)
  const reuseJudge = !!(existed && existed.judge_status)
  let judge
  if (reuseJudge) {
    judge = { status: existed.judge_status, ruleId: existed.judge_rule_id, reason: existed.judge_reason }
  } else {
    try { judge = judgeWarning(rec) }
    catch (e) { judge = { status: 'admitted', ruleId: null, reason: '研判执行异常，保守放行：' + ((e && e.message) || e) } }
  }
  const judgedAt = (existed && existed.judged_at) || new Date().toISOString()
  const row = {
    ...rec,
    judgeStatus: judge.status,
    judgeRuleId: judge.ruleId,
    judgeReason: judge.reason,
    judgedAt,
  }
  db.prepare('INSERT OR REPLACE INTO warnings (id, created_at, status, warning_type, data_json, judge_status, judge_rule_id, judge_reason, judged_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(row.id, createdAt, row.status ?? 'pending', row.warningType ?? null, JSON.stringify(row),
      row.judgeStatus, row.judgeRuleId, row.judgeReason, row.judgedAt)
  // 达阈值准入时，把本窗口内此前被拦下的同组记录**一并准入** —— 否则前台只显示触发那 1 条，
  //   聚合卡片拿不到成员、丢失「N 条证据」的研判依据（前端按 aggregate 折叠需要成员都在前台口径内）
  if (!reuseJudge && Array.isArray(judge.promote) && judge.promote.length > 0) {
    for (const pid of judge.promote) {
      try {
        const pr = db.prepare('SELECT data_json FROM warnings WHERE id = ?').get(pid)
        if (!pr) continue
        const po = JSON.parse(pr.data_json)
        po.judgeStatus = 'admitted'
        po.judgeRuleId = judge.ruleId
        po.judgeReason = `随同组达阈值一并准入（原判定：${po.judgeReason || '未达阈值'}）`
        po.judgedAt = judgedAt
        db.prepare('UPDATE warnings SET judge_status = ?, judge_rule_id = ?, judge_reason = ?, judged_at = ?, data_json = ? WHERE id = ?')
          .run('admitted', po.judgeRuleId, po.judgeReason, judgedAt, JSON.stringify(po), pid)
      } catch (e) { /* 补录失败不影响本条入库 */ }
    }
  }
  // ── P0-2：**只有本次新判定为「准入」的记录才广播** → SSE 轨与列表轨同口径。
  //    ① 被拦下的不广播（否则前台 1s 内先弹、60s 后列表又抹掉，双轨打架）
  //    ② 重复入库（restart 补坐标 / 状态回写）不重复广播，避免重启刷屏
  if (!reuseJudge && row.judgeStatus === 'admitted') {
    for (const cb of warningListeners) { try { cb(row) } catch (e) { /* 单个订阅者异常不影响入库 */ } }
    // ②-b P2-D：规则动作为「进前台 + 推城运」→ 通知推送桥（异步、异常隔离，失败不影响入库与前台展示）
    if (judge.action === 'front_and_push') {
      const memberIds = (Array.isArray(judge.promote) && judge.promote.length)
        ? [...judge.promote, row.id]      // 同组补录成员一起带上，让城运推送拿到完整证据链
        : [row.id]
      for (const cb of pushListeners) {
        try { cb(row, { ruleId: judge.ruleId, memberIds }) } catch (e) { /* 单个订阅者异常不影响入库 */ }
      }
    }
  }
}
/** P0-3：把前端传来的时间边界**按上海时**解析成 epoch(ms)。
 *  接受：纯日期 `YYYY-MM-DD`（from 取当日 00:00:00、to 取当日 23:59:59，上海时）、
 *        `YYYY-MM-DD HH:mm[:ss]`、`YYYY-MM-DDTHH:mm[:ss]`、带偏移的 ISO。无偏移时**默认按上海时**。
 *  解析失败返回 null（= 该侧不限制）。
 *
 * ⚠️ 这里刻意**不**把带数值偏移的 ISO 串交给 `parseWarningTime`：
 *   它内部那段「6 位微秒 → 3 位」的正则是 `\.(\d{1,6})(Z|[+-])`，**只捕获了符号**，
 *   重建时 `m[1]+'.'+m[2].slice(0,3)+m[3]` 会把 `+08:00` 截成 `+` ⇒ `Date.parse('...000+')` = NaN。
 *   即「带 ±hh:mm 偏移的 ISO 串」它一律解析不了（线上 `created_at` 是 `Z` 结尾或本地串，所以一直没暴露）。
 *   本函数改为：本地格式交给 `parseWarningTime`（那个分支它是对的），其余统一用 `Date.parse`。 */
function shanghaiBoundMs(v, isTo) {
  let s = String(v || '').trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s} ${isTo ? '23:59:59' : '00:00:00'}`
  // 本地格式（无时区标记）→ parseWarningTime 会按 UTC+8 处理，这条分支是正确的
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    const ms = parseWarningTime(s)
    return Number.isNaN(ms) ? null : ms
  }
  // 其余（datetime-local / 带偏移 ISO）→ 规范化后直接用 Date.parse，绕开上面的截断问题
  let t = s.replace(' ', 'T')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) t += ':00'
  if (!/[Zz]$|[+-]\d{2}:?\d{2}$/.test(t)) t += '+08:00'
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

function queryWarnings({ type, excludeType, limit, status, includeBlocked, from, to, retention } = {}) {
  let sql = 'SELECT data_json FROM warnings'
  const args = []
  const where = []
  if (type) {
    // 支持逗号分隔多值：type=growth5h,cross
    const types = type.split(',').map(t => t.trim()).filter(Boolean)
    if (types.length === 1) { where.push('warning_type = ?'); args.push(types[0]) }
    else if (types.length > 1) { where.push(`warning_type IN (${types.map(() => '?').join(',')})`); args.push(...types) }
  }
  if (excludeType) {
    // 支持逗号分隔多值排除：exclude_type=iot-video-analysis,chengyun-platform
    const excludes = excludeType.split(',').map(t => t.trim()).filter(Boolean)
    if (excludes.length > 0) { where.push(`warning_type NOT IN (${excludes.map(() => '?').join(',')})`); args.push(...excludes) }
  }
  if (status) { where.push('status = ?'); args.push(status) }
  // P0-1：默认只出「未被研判拦下」的记录（前台口径）。
  //   AI 存档页需要完整留档 → 传 includeBlocked:true（见 iot-fetcher.getArchive）
  if (!includeBlocked) where.push("(judge_status IS NULL OR judge_status <> 'blocked')")
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY rowid DESC'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  // T7：命中告警过滤规则（enabled alert_filter_rules）的记录从列表剔除，不出现在前端
  let out = db.prepare(sql).all(...args).map(r => JSON.parse(r.data_json)).filter(w => !alertFilterRuleHit(w))
  // 2026-09-24：按算法保留期「软归档」——超期记录不进前台（**仅查询期过滤，数据一行不动**）。
  //   显式传 retention:true 才生效：AI 存档（getArchive）、导出、健康检查等内部调用口径不变，
  //   否则会把历史留档一并"藏掉"，那不是本需求的目的。
  if (retention) {
    const nowMs = Date.now()
    out = out.filter(w => !warningRetentionExpired(w, nowMs))
  }
  // P0-3：时间范围筛选（**服务端过滤**，避免前端对 2.9 万条做本地过滤导致"卡片数与列表数不一致"）
  const fromMs = shanghaiBoundMs(from, false)
  const toMs = shanghaiBoundMs(to, true)
  if (fromMs !== null || toMs !== null) {
    out = out.filter(w => {
      const t = parseWarningTime(w.createdAt)
      if (Number.isNaN(t)) return false                 // 时间无法解析 → 有范围条件时排除，避免混入
      if (fromMs !== null && t < fromMs) return false
      if (toMs !== null && t > toMs) return false
      return true
    })
  }
  return out
}
function getWarning(id) {
  const row = db.prepare('SELECT data_json FROM warnings WHERE id = ?').get(id)
  return row ? JSON.parse(row.data_json) : null
}
// 更新单条预警的处理状态；返回更新后的对象或 null
function updateWarningStatus(id, status, handledBy) {
  const w = getWarning(id)
  if (!w) return null
  if (status === 'handled') {
    w.status = 'handled'; w.handledAt = new Date().toISOString(); w.handledBy = handledBy || '值守人员'
  } else if (status === 'pending') {
    w.status = 'pending'; delete w.handledAt; delete w.handledBy
  } else {
    return { error: 'invalid-status' }
  }
  db.prepare('UPDATE warnings SET status = ?, data_json = ? WHERE id = ?').run(w.status, JSON.stringify(w), id)
  return w
}
// ── 秸秆燃烧告警人工复核（真警/误报/漏报补标）──
function updateWarningReview(id, verdict, reason, reviewer) {
  const w = getWarning(id)
  if (!w) return null
  w.review = verdict               // 'true' | 'false' | 'miss'
  w.reviewReason = reason || ''
  w.reviewedBy = reviewer || '值守人员'
  w.reviewedAt = new Date().toISOString()
  db.prepare('UPDATE warnings SET data_json = ? WHERE id = ?').run(JSON.stringify(w), id)
  // 样本回流（边工作边训练数据管道）
  const sample = {
    id: `sample-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    warning_id: id,
    stream_id: w.streamId || '',
    verdict,
    reason: reason || '',
    reviewer: reviewer || '值守人员',
    created_at: new Date().toISOString(),
    data_json: JSON.stringify(w),
  }
  db.prepare(
    'INSERT OR REPLACE INTO straw_samples (id, warning_id, stream_id, verdict, reason, reviewer, created_at, data_json) VALUES (?,?,?,?,?,?,?,?)'
  ).run(sample.id, sample.warning_id, sample.stream_id, sample.verdict, sample.reason, sample.reviewer, sample.created_at, sample.data_json)
  return w
}
function listStrawSamples({ verdict, limit } = {}) {
  let sql = 'SELECT id, warning_id, stream_id, verdict, reason, reviewer, created_at, data_json FROM straw_samples'
  const args = []
  const where = []
  if (verdict) { where.push('verdict = ?'); args.push(verdict) }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY rowid DESC'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  return db.prepare(sql).all(...args).map(r => {
    const row = { ...r }
    try { row.data = JSON.parse(r.data_json) } catch {}
    delete row.data_json
    return row
  })
}
// ── 秸秆责任映射（行政区划→责任单位→微信群）──
function importAreaResponsibilities(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0
  const upsert = db.prepare(`
    INSERT INTO area_responsibility (district, town, community, unit, person, phone, webhook, remark)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(town, community) DO UPDATE SET
      unit=excluded.unit, person=excluded.person, phone=excluded.phone,
      webhook=excluded.webhook, remark=excluded.remark
  `)
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      if (!r.town) continue
      upsert.run(
        r.district || '万州区', r.town, r.community || '',
        r.unit || '', r.person || '', r.phone || '', r.webhook || '', r.remark || '',
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return rows.filter(r => r.town).length
}
function listAreaResponsibilities() {
  const rows = db.prepare(
    'SELECT id, district, town, community, unit, person, phone, webhook, remark FROM area_responsibility ORDER BY town, community'
  ).all()
  return rows
}
/** 删除一条责任映射（按 id） */
function deleteAreaResponsibility(id) {
  const r = db.prepare('DELETE FROM area_responsibility WHERE id = ?').run(id)
  return r.changes > 0
}

// ── 行政边界（area_boundary）──
/** ring 归一：兼容已 JSON 字符串化的 ring（防双重序列化） */
function normRing(ring) {
  if (typeof ring === 'string') {
    try { return JSON.parse(ring) } catch { return [] }
  }
  return ring
}
/** 当前边界全量（town, division_code, ring, source, updated_at） */
function listBoundaries() {
  return db.prepare('SELECT town, division_code, ring, source, updated_at FROM area_boundary').all()
}
/** 全表替换边界（导入），导入前自动备份当前版本 → boundary_snapshot */
function replaceBoundaries(rows, note = '导入') {
  db.exec('BEGIN')
  try {
    // 快照当前版本
    const cur = db.prepare('SELECT town, division_code, ring FROM area_boundary').all()
    if (cur.length) {
      db.prepare('INSERT INTO boundary_snapshot (note, boundary_json, created_at) VALUES (?,?,?)')
        .run(`导入前备份(${cur.length} 镇)`, JSON.stringify(cur), new Date().toISOString())
    }
    // 清空 + 插入
    db.prepare('DELETE FROM area_boundary').run()
    const ins = db.prepare('INSERT OR REPLACE INTO area_boundary (town, division_code, ring, source, updated_at) VALUES (?,?,?,?,?)')
    for (const r of rows) {
      if (!r.town) continue
      ins.run(r.town, r.division_code || '', JSON.stringify(normRing(r.ring)), r.source || 'imported', new Date().toISOString())
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return rows.length
}
/** 单乡镇更新边界（P2 地图编辑用） */
function updateBoundaryTown(town, ring, source = 'manual') {
  ring = normRing(ring)
  if (!town || !Array.isArray(ring) || ring.length < 3) throw new Error('无效边界（顶点数 ≥3）')
  const r = db.prepare('INSERT OR REPLACE INTO area_boundary (town, division_code, ring, source, updated_at) VALUES (?,?,?,?,?)')
    .run(town, '', JSON.stringify(ring), source, new Date().toISOString())
  return r.changes > 0
}
/** 边界版本快照列表 */
function listBoundarySnapshots() {
  return db.prepare('SELECT id, note, created_at, length(boundary_json) AS bytes FROM boundary_snapshot ORDER BY id DESC LIMIT 20').all()
}
/** 回滚到指定快照 */
function restoreBoundarySnapshot(id) {
  const s = db.prepare('SELECT boundary_json FROM boundary_snapshot WHERE id = ?').get(id)
  if (!s) throw new Error('快照不存在')
  const rows = JSON.parse(s.boundary_json)
  replaceBoundaries(rows, '回滚到快照 #' + id)
  return rows.length
}
/** 按乡镇/街道 + 社区/村查找责任单位（community 优先，无则用乡镇兜底） */
function findResponsibility(town, community) {
  if (!town) return null
  if (community) {
    const r = db.prepare(
      'SELECT * FROM area_responsibility WHERE town = ? AND community = ?'
    ).get(town, community)
    if (r) return r
  }
  return db.prepare(
    'SELECT * FROM area_responsibility WHERE town = ? AND community = ?'
  ).get(town, '') || db.prepare(
    'SELECT * FROM area_responsibility WHERE town = ?'
  ).get(town) || null
}
// 批量标记全部未处理为已处理，返回处理条数
function handleAllWarnings(handledBy) {
  const rows = db.prepare("SELECT id, data_json FROM warnings WHERE status != 'handled'").all()
  const now = new Date().toISOString()
  const upd = db.prepare('UPDATE warnings SET status = ?, data_json = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const w = JSON.parse(row.data_json)
      w.status = 'handled'; w.handledAt = now; w.handledBy = handledBy || '值守人员'
      upd.run('handled', JSON.stringify(w), row.id)
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return rows.length
}

// 通用 JSON 数组解析（用于 ai_types 等多选字段）
function parseArr(s) { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
function parseObj(s) { try { const v = JSON.parse(s || '{}'); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {} } catch { return {} } }

// ── 城运视频平台事件接入（入站 /client/handle_event）──
// 平台 eventType 枚举(1~17) → 驾驶舱 aiType 映射（已与城运确认：堆头未覆盖=4）
const CHENGYUN_EVENT_TYPE_MAP = {
  1: '工程车作业', 2: '工程车数量', 3: '烟尘', 4: '堆头未覆盖', 5: '生物质燃烧',
  6: '烟囱烟雾', 7: '扬尘', 8: '人员入侵', 9: '卡车脏车', 10: '脏车',
  11: '车辆遗撒', 12: '建渣未覆盖', 16: '车辆冒装', 17: '工业烟羽',
}
function numOrNull(v) { const n = parseFloat(v); return isNaN(n) ? null : n }
function toShanghaiStr(d) {
  // Intl sv-SE 输出 'YYYY-MM-DD HH:MM:SS'
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d)
}
function normalizeCreatedAt(t) {
  if (!t) return toShanghaiStr(new Date())
  // 平台 eventTime 为上海本地时间（无时区标记），与既有 iotcloud 告警一致：
  // 若不含时区，补 +08:00 再解析，否则会被当 UTC 偏移 8h（详见 parseWarningTime 同类修复）。
  let s = String(t).trim()
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) s = s.replace(' ', 'T') + '+08:00'
  const d = new Date(s)
  if (isNaN(d.getTime())) return toShanghaiStr(new Date())
  return toShanghaiStr(d)
}
// 以平台事件ID为 warning.id 做幂等 upsert（INSERT OR REPLACE）；保留既有处置状态
function upsertWarningFromChengyun(ev) {
  const id = String(ev.eventId)
  if (!id) return null
  const aiType = CHENGYUN_EVENT_TYPE_MAP[ev.eventType] || ('未知事件' + (ev.eventType ?? ''))
  const ch = getIotChannel(String(ev.cameraId))
  const channelName = ch ? ch.channelName : String(ev.cameraId)
  const locParts = [ev.districtName, ev.townName, ev.address].filter(Boolean)
  const location = locParts.join(' ') || channelName
  const createdAt = normalizeCreatedAt(ev.eventTime)
  // 经纬度落库口径（已确认）：经度=Longitude、纬度=Latitude
  const lon = numOrNull(ev.longitude)
  const lat = numOrNull(ev.latitude)
  const picUrl = ev.eventImgBig || ev.eventImgSmall || ''
  const level = (ev.confirm === 1 || ev.confirm === '1') ? 2 : 1
  const w = {
    id, createdAt,
    warningType: 'iot-video-analysis',
    source: 'chengyun-platform',
    eventId: id,
    platformEventTime: ev.eventTime,
    cameraId: String(ev.cameraId),
    eventType: ev.eventType,
    subType: ev.subType,
    aiType,
    aiConfidence: undefined,
    channelSipId: String(ev.cameraId),
    channelName,
    location,
    level,
    lon, lat,
    picUrl,
    eventImgSmall: ev.eventImgSmall,
    eventImgBig: ev.eventImgBig,
    watermarkImage: ev.watermarkImage,
    district: ev.districtName,
    town: ev.townName,
    address: ev.address,
    confirm: ev.confirm,
    processEventId: ev.processEventId,
    processEventStatus: ev.processEventStatus,
    elevation: ev.elevation,
    azimuth: ev.azimuth,
    absoluteZoom: ev.absoluteZoom,
    type: `AI视频分析 · ${aiType}`,
    value: '',
    standard: '—',
  }
  const existing = getWarning(id)
  if (existing) {
    // 保留首次检测时间（首见即固定，重复推送不覆盖）与既有处置状态/信息
    if (existing.createdAt) w.createdAt = existing.createdAt
    if (existing.status) w.status = existing.status
    if (existing.disposition) w.disposition = existing.disposition
    if (existing.handledAt) { w.handledAt = existing.handledAt; w.handledBy = existing.handledBy }
    if (existing.videoUrl) w.videoUrl = existing.videoUrl
  }
  insertWarning(w)
  return w
}
// 短视频接入（/client/handle_event_other）：把 fileUrl 关联到对应事件
function setWarningVideoUrl(id, url) {
  const w = getWarning(id)
  if (!w) return false
  w.videoUrl = url
  db.prepare('UPDATE warnings SET data_json = ? WHERE id = ?').run(JSON.stringify(w), id)
  return true
}

// ── AI 类型主数据 ai_types ──
function listAiTypes() {
  return db.prepare('SELECT name, sort_order AS sortOrder, source_key AS sourceKey FROM ai_types ORDER BY sort_order, name').all()
}
// 2026-09-15 整改（算法字典单一出处）：算法 key → 中文类型名 映射（iot-fetcher 每轮热加载，30s 内生效）
function getAiTypeKeyMap() {
  const out = {}
  try {
    for (const r of db.prepare("SELECT source_key AS k, name FROM ai_types WHERE source_key IS NOT NULL AND source_key <> ''").all()) {
      out[r.k] = r.name
    }
  } catch (e) { /* 列尚未迁移时降级为空表 */ }
  return out
}
// 未映射的算法 key → 自动登记到 ai_types（中文名暂用 key 原名，sort_order=90 标记「待人工补名」）
//   这样管理员能在「AI分析存档」看到新出现的算法 key，而不是让它静默变成英文进告警
function ensureAiTypeByKey(key) {
  const k = String(key || '').trim()
  if (!k) return ''
  try {
    const hit = db.prepare('SELECT name FROM ai_types WHERE source_key = ?').get(k)
    if (hit) return hit.name
    db.prepare('INSERT OR IGNORE INTO ai_types (name, sort_order, created_at, source_key) VALUES (?,?,?,?)')
      .run(k, 90, new Date().toISOString(), k)
    return k
  } catch (e) { return k }
}
// 2026-09-15 整改（P1 算法健康度）：每类算法的「接入状态 + 数据量 + 最后一条时间」
//   原 UI 只列算法名字，用户点进去 6 类没数据却无法区分"云平台没跑"还是"跑了没检出"
//   → 本接口让"空壳算法"一眼可见。
//   status: active=近 7 天有数据 · idle7d=有历史但近 7 天无 · never=从未产出 · unbound=未绑定云平台算法 key
function getAiTypeHealth() {
  const types = db.prepare('SELECT name, sort_order AS sortOrder, source_key AS sourceKey FROM ai_types ORDER BY sort_order, name').all()
  const stat = {}
  try {
    for (const r of db.prepare(`SELECT COALESCE(json_extract(data_json,'$.aiType'),'(null)') ai,
        COUNT(*) total,
        SUM(CASE WHEN created_at > datetime('now','-7 day') THEN 1 ELSE 0 END) d7,
        SUM(CASE WHEN created_at > datetime('now','-30 day') THEN 1 ELSE 0 END) d30,
        MAX(created_at) lastAt
      FROM warnings GROUP BY ai`).all()) {
      stat[r.ai] = r
    }
  } catch (e) { /* 统计失败降级为全零 */ }
  return types.map(t => {
    const s = stat[t.name] || {}
    const total = s.total || 0
    const d7 = s.d7 || 0
    let status = 'never'
    if (total > 0 && d7 > 0) status = 'active'
    else if (total > 0) status = 'idle7d'
    if (!t.sourceKey && status === 'never') status = 'unbound'
    return {
      name: t.name, sourceKey: t.sourceKey || '', sortOrder: t.sortOrder,
      total, last7d: d7, last30d: s.d30 || 0, lastAt: s.lastAt || null, status,
    }
  })
}
function createAiType(name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('name 必填')
  if (db.prepare('SELECT 1 FROM ai_types WHERE name = ?').get(n)) throw new Error('该 AI 类型已存在')
  db.prepare('INSERT INTO ai_types (name, sort_order, created_at) VALUES (?, ?, ?)').run(n, 0, new Date().toISOString())
  return { name: n, sortOrder: 0 }
}
function deleteAiType(name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('name 必填')
  // 保护：启用规则中引用
  const rules = db.prepare("SELECT id, ai_types FROM push_rules WHERE enabled = 1").all()
  const usedByRule = rules.find(r => parseArr(r.ai_types).includes(n))
  if (usedByRule) return { ok: false, reason: 'rule', ruleId: usedByRule.id }
  // 保护：未处理告警中引用
  const warn = db.prepare("SELECT id FROM warnings WHERE status != 'handled' AND json_extract(data_json,'$.source') IN ('iotcloud','chengyun-platform') AND json_extract(data_json,'$.aiType') = ? LIMIT 1").get(n)
  if (warn) return { ok: false, reason: 'warning' }
  // 从所有规则数组中剔除
  const allRules = db.prepare('SELECT id, ai_types FROM push_rules').all()
  const updRule = db.prepare('UPDATE push_rules SET ai_types = ? WHERE id = ?')
  for (const r of allRules) {
    const arr = parseArr(r.ai_types).filter(x => x !== n)
    if (arr.length !== parseArr(r.ai_types).length) updRule.run(JSON.stringify(arr), r.id)
  }
  // 从所有通道映射中剔除
  const allChs = db.prepare('SELECT channel_sip_id, ai_types FROM iot_channels').all()
  const updCh = db.prepare('UPDATE iot_channels SET ai_types = ? WHERE channel_sip_id = ?')
  for (const c of allChs) {
    const arr = parseArr(c.ai_types).filter(x => x !== n)
    if (arr.length !== parseArr(c.ai_types).length) updCh.run(JSON.stringify(arr), c.channel_sip_id)
  }
  db.prepare('DELETE FROM ai_types WHERE name = ?').run(n)
  return { ok: true }
}

// ── AI 分析推送规则 push_rules ──
// 稳健解析 created_at（兼容 JS toISOString 3位毫秒 与 Python isoformat 6位微秒）
function parseWarningTime(s) {
  if (!s) return NaN
  // ISO with ms + timezone (JS toISOString): normalize 6-digit μs → 3-digit ms
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{1,6})(Z|[+-])/.exec(s)
  let iso = s
  if (m) iso = m[1] + '.' + m[2].slice(0, 3) + m[3]
  // 本地时间格式 "YYYY-MM-DD HH:mm:ss"（无时区标记）→ 按 UTC+8 上海时间解析
  // 服务器是 UTC，若不修正会被当成 UTC，导致时间偏移 8 小时
  const localM = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/.exec(s)
  if (localM) iso = localM[1].replace(' ', 'T') + '+08:00'
  return Date.parse(iso)
}
// ── IoT recordId 去重持久化（T5：重启幂等，避免重启后重拉旧记录覆盖 handled 状态）──
function iotSeenAll() {
  const rows = db.prepare('SELECT record_id FROM iot_record_seen').all()
  return rows.map(r => r.record_id)
}
function iotMarkSeen(recordId, channelSipId) {
  if (recordId === null || recordId === undefined || recordId === '') return
  db.prepare('INSERT OR IGNORE INTO iot_record_seen (record_id, channel_sip_id, first_seen_at) VALUES (?,?,?)')
    .run(String(recordId), channelSipId || null, new Date().toISOString())
}
function iotSeenPrune(days = 90) {
  const cutoff = new Date(Date.now() - Number(days) * 86400 * 1000).toISOString()
  return db.prepare('DELETE FROM iot_record_seen WHERE first_seen_at < ?').run(cutoff).changes
}

/** 规则动作归一：admit_front(进前台) / front_and_push(进前台+推城运) / archive_only(仅存档) */
function normAction(a) {
  return a === 'archive_only' ? 'archive_only' : (a === 'front_and_push' ? 'front_and_push' : 'admit_front')
}
function mapPushRule(r) {
  return {
    ...r,
    enabled: r.enabled === 1,
    channelSipId: r.channel_sip_id,
    aiTypes: parseArr(r.ai_types),
    timeWindowHours: r.time_window_hours,
    // P1-1 / P1-2（2026-09-19）：维度补全 + 动作
    minConfidence: Number(r.min_confidence) || 0,   // 百分比 0-100，0=不限
    minLevel: Number(r.min_level) || 0,             // 1-4，0=不限
    activeHours: r.active_hours || '',              // 上海时间；空=全天
    action: r.action || 'admit_front',              // admit_front | front_and_push | archive_only
  }
}
function listPushRules() {
  // P2：必须带 rowid 兜底排序 —— 只按 created_at DESC 时，**同毫秒创建的多条规则排序不确定**，
  //   而 pickPushRule 取第一条 → 会导致"哪条规则生效"随机（实测已复现）。
  //   加 rowid DESC 保证「最新创建的稳定胜出」，与界面上"实际只有最新那条生效"的提示一致。
  return db.prepare('SELECT * FROM push_rules ORDER BY created_at DESC, rowid DESC').all().map(mapPushRule)
}
function getPushRule(id) {
  const r = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(id)
  return r ? mapPushRule(r) : null
}
function createPushRule({ name, channel_sip_id, ai_types, time_window_hours, threshold, enabled, min_confidence, min_level, active_hours, action }) {
  const id = require('crypto').randomUUID()
  const now = new Date().toISOString()
  const arr = Array.isArray(ai_types) ? ai_types : (ai_types ? [ai_types] : [])
  db.prepare('INSERT INTO push_rules (id,name,channel_sip_id,ai_type,ai_types,time_window_hours,threshold,enabled,created_at,updated_at,min_confidence,min_level,active_hours,action) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, channel_sip_id ?? null, arr[0] || '', JSON.stringify(arr), Number(time_window_hours) || 24, Number(threshold) || 20, enabled === false ? 0 : 1, now, now,
      Number(min_confidence) || 0, Number(min_level) || 0, String(active_hours || ''), normAction(action))
  return getPushRule(id)
}
function updatePushRule(id, patch) {
  const cur = getPushRule(id)
  if (!cur) return null
  // P1：兼容 snake_case 补丁（前端/PATCH 两种命名都要能改到，否则新维度会"改了不生效"）
  const p = { ...(patch || {}) }
  if (p.min_confidence !== undefined) p.minConfidence = p.min_confidence
  if (p.min_level !== undefined) p.minLevel = p.min_level
  if (p.active_hours !== undefined) p.activeHours = p.active_hours
  const next = { ...cur, ...p, id, updated_at: new Date().toISOString() }
  const arr = Array.isArray(next.aiTypes) ? next.aiTypes : (next.aiType ? [next.aiType] : [])
  db.prepare('UPDATE push_rules SET name=?, channel_sip_id=?, ai_type=?, ai_types=?, time_window_hours=?, threshold=?, enabled=?, updated_at=?, min_confidence=?, min_level=?, active_hours=?, action=? WHERE id=?')
    .run(next.name, next.channelSipId ?? null, arr[0] || '', JSON.stringify(arr), Number(next.timeWindowHours) || 24, Number(next.threshold) || 20, next.enabled ? 1 : 0, next.updated_at,
      Number(next.minConfidence) || 0, Number(next.minLevel) || 0, String(next.activeHours || ''), normAction(next.action), id)
  return getPushRule(id)
}
function deletePushRule(id) {
  return db.prepare('DELETE FROM push_rules WHERE id = ?').run(id).changes
}

// ── T14：告警明细导出（CSV 数据源）────────────────────────────
// 与 alert_filter_rules 展示降噪【完全解耦】：导出=数据带走，不受个人过滤规则影响（C1）。
// 返回 { rows, truncated }，rows 为原始 data_json 对象（新→旧），供路由层转 CSV。
// 过滤维度：
//   status   'pending' | 'handled' | 'all'(默认)
//   sources  来源键数组（cq_api/iotcloud/straw-engine/chengyun-platform）
//   levels   等级数字数组（AI 取 w.level；气体由 warningType 推导：cross=3 growth5h/fixed=2）
//   from/to  created_at 绝对时刻下/上界（已由路由层 parseWarningTime 统一时区，C7）
//   q        关键词（类型/点位/数值/类型名等子串）
function exportWarningLevel(w) {
  if (!w) return 0
  const n = Number(w.level)
  if (Number.isFinite(n) && n >= 1 && n <= 4) return n
  const wt = w.warningType || w.warning_type || ''
  if (wt === 'cross') return 3
  if (wt === 'growth5h' || wt === 'fixed') return 2
  return 1
}
function queryWarningsForExport({ status = 'all', sources, levels, from, to, q, maxRows = 50000 } = {}) {
  const srcArr = Array.isArray(sources) ? sources.filter(Boolean) : []
  const lvArr = Array.isArray(levels) ? levels.map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 4) : []
  const kw = q ? String(q).trim().toLowerCase() : ''
  const fromT = from ? parseWarningTime(from) : NaN
  const toT = to ? parseWarningTime(to) : NaN
  let sql = 'SELECT data_json FROM warnings'
  const args = []
  const where = []
  if (status === 'pending' || status === 'handled') { where.push('status = ?'); args.push(status) }
  // P0-1：导出与前台列表同口径（被研判拦下的记录不出现在告警历史导出里；存档页仍可查）
  where.push("(judge_status IS NULL OR judge_status <> 'blocked')")
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY rowid DESC'
  const rows = db.prepare(sql).all(...args).map(r => JSON.parse(r.data_json))
  const out = []
  for (const w of rows) {
    const src = resolveSourceKey(w)
    if (srcArr.length > 0 && !srcArr.includes(src)) continue
    const lv = exportWarningLevel(w)
    if (lvArr.length > 0 && !lvArr.includes(lv)) continue
    if (!Number.isNaN(fromT) || !Number.isNaN(toT)) {
      const t = parseWarningTime(w.createdAt || w.monitorTime || '')
      if (!Number.isNaN(fromT) && !(t >= fromT)) continue
      if (!Number.isNaN(toT) && !(t <= toT)) continue
    }
    if (kw) {
      const hay = [w.type, w.name, w.warningLabel, w.pointName, w.channelName, w.deviceName, w.location, w.value, w.aiType, w.code, w.standard, w.reason]
        .filter(v => v != null).join(' ').toLowerCase()
      if (!hay.includes(kw)) continue
    }
    out.push(w)
    if (out.length >= maxRows) break   // 护栏：截断（路由返回 X-Warnings-Truncated）
  }
  return { rows: out, truncated: out.length >= maxRows }
}

// ── 秸秆微信推送记录（P3 T19：wechatPush 状态可视化，90 天窗口）──
// 数据源 = warnings.data_json.wechatPush（strawWorkflow 回写），无独立推送表
// 状态语义：held=复检把关拦截待复核 / pushed=推送成功 / failed=推送失败 / none=未推送
function queryStrawPushLogs({ status = 'all', q = '', page = 1, pageSize = 30 } = {}) {
  const kw = String(q || '').trim().toLowerCase()
  const where = [
    "json_extract(data_json, '$.source') = 'straw-engine'",
    "json_extract(data_json, '$.wechatPush') IS NOT NULL",
    "created_at > datetime('now', '-90 days')",
  ]
  const args = []
  if (kw) { where.push('(data_json LIKE ? OR data_json LIKE ?)'); const p = `%${kw}%`; args.push(p, p) }
  const rows = db.prepare(`SELECT data_json FROM warnings WHERE ${where.join(' AND ')} ORDER BY rowid DESC`).all(...args)
  const out = []
  for (const r of rows) {
    const w = JSON.parse(r.data_json)
    const wp = w.wechatPush || {}
    const st = wp.held ? 'held' : (wp.pushed === true ? 'pushed' : (wp.pushed === false && wp.reason ? 'failed' : 'none'))
    if (status !== 'all' && st !== status) continue
    const createdMs = parseWarningTime(w.createdAt || '')
    // displayTime：上海本地串（服务器 UTC，+8h 对齐业务时区，与导出一致）
    const displayTime = Number.isFinite(createdMs)
      ? new Date(createdMs + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      : (w.createdAt || '')
    out.push({
      id: w.id,
      createdAt: displayTime,
      label: w.label || w.aiType || w.warningType || '',
      aiType: w.aiType || '',
      aiConfidence: w.aiConfidence ?? null,
      level: w.level ?? null,
      location: w.location || w.streamId || '',
      picUrl: w.picUrl || '',
      town: wp.town || '',
      unit: wp.unit || '',
      state: st,
      held: !!wp.held,
      pushed: wp.pushed === true,
      reason: wp.reason || '',
      cardUrl: wp.cardUrl || '',
      webhook: wp.webhook || '',
      correctedAt: wp.correctedAt || '',
      correctionOk: wp.correctionOk ?? null,
      correctionNote: wp.correctionNote || '',
      correctedBy: wp.correctedBy || '',
    })
  }
  const total = out.length
  const p = Math.max(1, Number(page) || 1)
  const ps = Math.min(200, Math.max(5, Number(pageSize) || 30))
  return { rows: out.slice((p - 1) * ps, p * ps), total, page: p, pageSize: ps }
}
// 通用整行保存（读改写 data_json；P3 T19 起供 strawWorkflow/strawCorrection 复用，消除硬编码 DB 路径）
function saveWarningData(w) {
  if (!w || !w.id) return false
  const r = db.prepare('UPDATE warnings SET data_json = ?, status = ?, warning_type = ? WHERE id = ?')
    .run(JSON.stringify(w), w.status ?? null, w.warningType ?? null, w.id)
  return r.changes > 0
}

// ── 告警过滤规则 alert_filter_rules（T6~T7：命中规则 → 从告警列表隐藏）──
function resolveSourceKey(w) {
  if (!w) return null
  if (w.source) return w.source
  // 旧数据无 source 时按字段特征推断（与前端 resolveSource 一致）
  if (w.pointName || w.code || w.standardValue != null) return 'cq_api'
  if (w.aiType || w.channelSipId || w.picUrl) return 'iotcloud'
  return null
}
function listAlertFilterRules() {
  return db.prepare('SELECT * FROM alert_filter_rules ORDER BY created_at DESC').all()
    .map(r => ({
      id: r.id, name: r.name, enabled: r.enabled === 1,
      sources: parseArr(r.sources), locations: parseArr(r.locations),
      minConfidence: r.min_confidence, severities: parseArr(r.severities),
      remark: r.remark || '', createdAt: r.created_at, updatedAt: r.updated_at,
    }))
}
function getAlertFilterRule(id) {
  const r = db.prepare('SELECT * FROM alert_filter_rules WHERE id = ?').get(id)
  return r ? {
    id: r.id, name: r.name, enabled: r.enabled === 1,
    sources: parseArr(r.sources), locations: parseArr(r.locations),
    minConfidence: r.min_confidence, severities: parseArr(r.severities),
    remark: r.remark || '', createdAt: r.created_at, updatedAt: r.updated_at,
  } : null
}
function createAlertFilterRule({ name, sources, locations, min_confidence, severities, remark, enabled }) {
  const id = require('crypto').randomUUID()
  const now = new Date().toISOString()
  const normSources = Array.isArray(sources) ? sources.filter(s => typeof s === 'string') : []
  const normLocs = Array.isArray(locations) ? locations.filter(s => typeof s === 'string' && s.trim()) : []
  const normSevs = Array.isArray(severities) ? severities.map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 4) : []
  let conf = null
  if (min_confidence !== null && min_confidence !== undefined && min_confidence !== '') {
    const c = Number(min_confidence)
    conf = Number.isFinite(c) ? Math.max(0, Math.min(100, Math.round(c))) : null
  }
  db.prepare('INSERT INTO alert_filter_rules (id,name,enabled,sources,locations,min_confidence,severities,remark,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, String(name).trim() || '未命名规则', enabled === false ? 0 : 1,
      JSON.stringify(normSources), JSON.stringify(normLocs), conf, JSON.stringify(normSevs),
      remark || '', now, now)
  return getAlertFilterRule(id)
}
function updateAlertFilterRule(id, patch) {
  const cur = getAlertFilterRule(id)
  if (!cur) return null
  const now = new Date().toISOString()
  // 兼容两套字段名（PATCH body 走 minConfidence；路由层曾以 min_confidence 透传）
  const p = { ...patch }
  if (p.minConfidence === undefined && p.min_confidence !== undefined) p.minConfidence = p.min_confidence
  const name = p.name !== undefined ? String(p.name).trim() || '未命名规则' : cur.name
  const enabled = p.enabled !== undefined ? (p.enabled ? 1 : 0) : (cur.enabled ? 1 : 0)
  const sources = Array.isArray(p.sources) ? p.sources.filter(s => typeof s === 'string') : cur.sources
  const locations = Array.isArray(p.locations) ? p.locations.filter(s => typeof s === 'string' && s.trim()) : cur.locations
  const severities = Array.isArray(p.severities)
    ? p.severities.map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 4)
    : cur.severities
  let conf = cur.minConfidence
  if (p.minConfidence !== undefined) {
    if (p.minConfidence === null || p.minConfidence === '') conf = null
    else { const c = Number(p.minConfidence); conf = Number.isFinite(c) ? Math.max(0, Math.min(100, Math.round(c))) : null }
  }
  db.prepare('UPDATE alert_filter_rules SET name=?, enabled=?, sources=?, locations=?, min_confidence=?, severities=?, remark=?, updated_at=? WHERE id=?')
    .run(name, enabled, JSON.stringify(sources), JSON.stringify(locations), conf, JSON.stringify(severities),
      p.remark !== undefined ? (p.remark || '') : (cur.remark || ''), now, id)
  return getAlertFilterRule(id)
}
function deleteAlertFilterRule(id) {
  return db.prepare('DELETE FROM alert_filter_rules WHERE id = ?').run(id).changes
}
// 命中判定：某条告警 data_json 是否被任一 enabled 过滤规则命中（命中 → 从列表隐藏）
// ── 2026-09-24 修复：补上 before_time 判定 ──────────────────────────────
//   背景：两条「屏蔽高频误报」规则配置了 before_time=2026-09-17 00:00:00（本意＝只屏蔽该时刻之前的
//   爆发期历史误报），但本函数**此前从未读取该列** ⇒ 屏蔽不分时间，把 09-17 之后正常产生的
//   渣土车冒装记录（21,594 条里 09-17 之后的全部）也一并静默隐藏，既不进实时告警也不进 AI 存档。
//   语义（业务 09-24 确认）：before_time **仅屏蔽该时刻之前的记录**；该时刻及之后的新记录正常显示。
//   before_time 为空/无法解析 → 不限时间（全时段屏蔽，保持旧行为）。
let _filterHasBeforeTime = null
function filterHasBeforeTimeCol() {
  if (_filterHasBeforeTime !== null) return _filterHasBeforeTime
  try {
    const cols = db.prepare('PRAGMA table_info(alert_filter_rules)').all().map(c => String(c.name))
    _filterHasBeforeTime = cols.includes('before_time')
  } catch (e) { _filterHasBeforeTime = false }   // 列不存在（老库）→ 退回旧行为，绝不因此报错
  return _filterHasBeforeTime
}
function alertFilterRuleHit(w) {
  if (!w) return false
  const FILTER_COLS = filterHasBeforeTimeCol()
    ? 'SELECT sources, locations, min_confidence, severities, before_time FROM alert_filter_rules WHERE enabled = 1'
    : 'SELECT sources, locations, min_confidence, severities FROM alert_filter_rules WHERE enabled = 1'
  const rules = db.prepare(FILTER_COLS).all()
  if (rules.length === 0) return false
  const src = resolveSourceKey(w)
  // 位置匹配串：AI 类 channelName/deviceName/location；气体 pointName；秸秆 location 多为坐标串（不参与关键字匹配）
  const locStr = [w.channelName, w.deviceName, w.pointName, w.location].filter(Boolean).join(' ').toLowerCase()
  // 2026-09-14 整改 #1.4：通道号精确匹配（channelName 缺失的通道无法用名称关键字定位，
  //   且同 NVR 下多通道共享 deviceName，关键字会误伤同设备其它通道）
  const channelId = String(w.channelSipId || '').toLowerCase()
  const confPct = (() => {
    if (w.aiConfidence === null || w.aiConfidence === undefined || w.aiConfidence === '') return null
    const c = Number(w.aiConfidence)
    if (!Number.isFinite(c)) return null
    return c > 1 ? c : c * 100   // 兼容 0-1 与 0-100 两种存量
  })()
  const lv = Number(w.level)
  for (const r of rules) {
    const sources = parseArr(r.sources)
    if (sources.length > 0 && !sources.includes(src)) continue
    const locations = parseArr(r.locations)
    if (locations.length > 0) {
      const hit = locations.some(k => {
        if (!k) return false
        const ks = String(k).toLowerCase()
        return locStr.includes(ks) || (channelId !== '' && channelId === ks)   // 名称关键字 OR 通道号精确
      })
      if (!hit) continue
    }
    if (r.min_confidence !== null && r.min_confidence !== undefined) {
      if (confPct === null || !(confPct < r.min_confidence)) continue   // 无置信度或未低于阈值 → 不命中
    }
    const sevs = parseArr(r.severities).map(Number)
    if (sevs.length > 0) {
      if (!lv || !sevs.includes(lv)) continue
    }
    // 2026-09-24：时间限定（before_time）—— 只屏蔽该时刻**之前**的记录；之后的新记录不命中（正常显示）
    if (FILTER_COLS.includes('before_time')) {
      const cutMs = shanghaiBoundMs(r.before_time, false)   // 上海时口径（与 from/to 筛选同一套）
      if (cutMs !== null) {
        const tw = parseWarningTime(w.createdAt)
        // 时间无法解析 → 不按本规则屏蔽（宁可显示，避免静默吞掉新记录）
        if (!Number.isFinite(tw)) continue
        if (tw >= cutMs) continue                            // 新记录 → 跳过屏蔽
      }
    }
    return true
  }
  return false
}

// 2026-09-03 聚合选图加固：判定 picUrl 是否为 6882 认证网关形态
//（上游 9/2 19:32 起切换，无凭据裸拉返回 401/非图；配 iot-fetcher 5001 回退仍可加载，但历史 5001 成员更健康优先展示）
function is6882GatewayPic(picUrl) {
  if (!picUrl || typeof picUrl !== 'string') return false
  try {
    const p = new URL(picUrl)
    return String(p.port) === '6882' && ['172.16.8.11', '111.10.220.226'].includes(p.hostname)
  } catch { return false }
}

// 聚合后的告警列表（供 /api/warnings?aggregate=1）：按规则把高频同组折叠成1条
// lightweight=true 时聚合对象不返回 members（供实时轮询降低 payload），点详情时用 by-ids 按需拉取
// 司空机场流标签（2026-09-14）：straw-engine 告警只有 streamId（形如 sikong_<无人机SN>），既无 channelSipId
//   也不在 iot_channels 登记，聚合时拿不到通道名。按无人机 SN 尾段映射到万州 4 机场（固定不变），
//   避免显示裸流名；未命中时回落原 streamId。
//   依据：环保局 8UUXN7G00A0FDP/…064U、三峡科技 8UUXN8N00A0LS7/…0S4G、
//        职教中心 8UUXN8P00A0LZ4/…0S4J、经开区 8UUXN5500A07D1/…0SJM
const SIKONG_STREAM_LABELS = [
  { tail: '064U', name: '环保局机场' },
  { tail: '0S4G', name: '三峡科技机场' },
  { tail: '0S4J', name: '职教中心机场' },
  { tail: '0SJM', name: '经开区机场' },
  // 2026-09-20：早期 streamId 用的是 **SN 前缀**形式（如 sikong_8UUXN7G00A0FDP），尾段不在 → 命中不了。
  //   按同一批 SN 的已知前缀补齐（与上面四条同源：…FDP/…064U、…LS7/…0S4G、…LZ4/…0S4J、…07D1/…0SJM）。
  //   实测：仅尾段匹配时 636 条 straw 记录只能命中 126 条（19.8%）；补前缀后多命中 49 条。
  { prefix: '8UUXN7G00A0FDP', name: '环保局机场' },
  { prefix: '8UUXN8N00A0LS7', name: '三峡科技机场' },
  { prefix: '8UUXN8P00A0LZ4', name: '职教中心机场' },
  { prefix: '8UUXN5500A07D1', name: '经开区机场' },
]
function sikongStreamLabel(streamId) {
  if (!streamId) return ''
  const s = String(streamId)
  const hit = SIKONG_STREAM_LABELS.find(d => (d.tail && s.endsWith(d.tail)) || (d.prefix && s.includes(d.prefix)))
  return hit ? hit.name : s
}

// 2026-09-20：抽成常量，避免「展示文案」与「排除逻辑」两处各写一份而漂移。
//   存档页据此**整张卡片**排除模拟流（见 iot-fetcher.js getArchive）。
//   实测（生产库 29227 条 iot-video-analysis）：模拟流 457 条（jgfs_sim 448 / sikong_SIM_SMOKE 4 /
//     verify_test·person 2 / v3test-stream* 2 / e2e-verify-18888 1），**0 条带真实 channelName/SipId**
//     ⇒ 该卡片里不可能混入真实通道的记录。
const SIM_STREAM_LABEL = '(模拟·测试流)'
const SIM_STREAM_RE = /sim|test|verify|demo|mock/i

/** 无人机流 → 可读展示名（**只用于"通道名为空"时的兜底**，如 straw-engine 的无人机记录）
 *  返回：机场名 / SIM_STREAM_LABEL / ''（识别不了，由前端再兜 '(未命名)'）
 *  🔴 **机场映射优先**：真实机场流（sikong_…064U / …0S4G 等）即便 streamId 里偶然含 test 字样，
 *     只要命中机场映射就返回机场名、绝不判为模拟 —— 这是"排除模拟流不会误伤真实通道"的依据。 */
function streamFallbackName(streamId) {
  const s = String(streamId || '').trim()
  if (!s) return ''
  const name = sikongStreamLabel(s)
  if (name && name !== s) return name                       // 命中机场映射
  if (SIM_STREAM_RE.test(s)) return SIM_STREAM_LABEL
  return ''
}

function queryWarningsAggregated({ limit, lightweight, retention } = {}) {
  const rawRows = db.prepare(
    "SELECT id, created_at, data_json FROM warnings WHERE status='pending' AND json_extract(data_json,'$.source') IN ('iotcloud','chengyun-platform','straw-engine')"
    // P0-1：研判拦下的记录不进前台（列表轨与 SSE 轨同口径）
    + " AND (judge_status IS NULL OR judge_status <> 'blocked')"
  ).all()
  // T7：先应用告警过滤规则（命中即隐藏，不参与后续聚合），再走聚合折叠
  const kept = rawRows.map(r => ({ id: r.id, created_at: r.created_at, w: JSON.parse(r.data_json) }))
    .filter(x => !alertFilterRuleHit(x.w))
  // 2026-09-24：保留期软归档（与列表轨同口径，默认开；传 retention:false 可关，便于对账）
  const keptRows = (retention === false)
    ? kept
    : (() => { const n = Date.now(); return kept.filter(x => !warningRetentionExpired(x.w, n)) })()
  const rules = listPushRules().filter(r => r.enabled)
  if (rules.length === 0) {
    return keptRows.map(x => x.w).slice(0, Number(limit) || 200)
  }
  const groups = new Map()
  for (const { id, created_at, w } of keptRows) {
    // 2026-09-14：straw-engine 源无 channelSipId → 退用 streamId 分组。
    //   否则所有机场的秸秆告警落进同一个 'null|秸秆燃烧' 组被混聚（阈值口径被稀释、
    //   前端聚合 id 也因 channelSipId||'all' 撞车），跨机场不可区分。
    const cid = w.channelSipId || w.streamId || null
    const ai = w.aiType || '(未知)'
    const key = cid + '|' + ai
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ id, created_at, w })
  }
  const result = []
  const now = Date.now()
  for (const [key, items] of groups) {
    // 2026-09-14 修复：channelSipId 为空的记录（straw-engine 源没有该字段）在 key 里被字符串化成 'null|ai'，
    //   split 回来 cid 变成字符串 "null"（truthy）→ channelName 取到字面 "null"，研判依据弹窗「通道 null」。
    //   归一为 null → 走 '全部通道' 兜底。
    const [cidRaw, ai] = key.split('|')
    const cid = cidRaw && cidRaw !== 'null' ? cidRaw : null
    // 规则优先级：业务方「具体类型」规则 > 系统默认「通配(空 ai_types)」规则（否则通配总抢先命中、自定义阈值失效）
    // 2026-09-19：匹配逻辑抽成 pickPushRule 唯一出处，与入库期闸门 judgeWarning 共用（防双轨口径漂移）
    const rule = pickPushRule(rules, cid, ai)
    if (!rule) { for (const it of items) result.push(it.w); continue }
    const windowMs = rule.timeWindowHours * 3600 * 1000
    const inWindow = items.filter(it => { const t = parseWarningTime(it.created_at); return !isNaN(t) && (now - t) <= windowMs })
    if (inWindow.length < rule.threshold) { for (const it of items) result.push(it.w); continue }
    const channelName = cid ? (getIotChannel(cid)?.channelName || sikongStreamLabel(cid) || cid) : '全部通道'
    const maxLevel = inWindow.reduce((m, it) => Math.max(m, Number(it.w.level) || 0), 0)
    const latestTime = inWindow.reduce((m, it) => it.created_at > m ? it.created_at : m, '')
    // 2026-09-14 驾驶舱实时告警改造（P0）：聚合对象补 source / 置信度范围 / 坐标，
    //   让驾驶舱告警卡副标题能展示「来源 · 置信度 15%~18% · 3帧确认」等专业信息（原副标题信息密度过低）。
    const ws = inWindow.map(it => it.w)
    const confs = ws.map(w => Number(w.aiConfidence)).filter(n => Number.isFinite(n))
    const firstLoc = ws.find(w => w.lat != null || w.lon != null)
    // 组处理状态：全部 handled → handled；否则 pending（前端状态色差）
    const allHandled = inWindow.length > 0 && inWindow.every(it => (it.w && it.w.status) === 'handled')
    const agg = {
      isAggregate: true, ruleId: rule.id, ruleName: rule.name, channelSipId: cid, aiType: ai, channelName,
      windowHours: rule.timeWindowHours, threshold: rule.threshold, count: inWindow.length, maxLevel, latestTime,
      status: allHandled ? 'handled' : (inWindow.some(it => (it.w && it.w.status) === 'handled') ? 'partial' : 'pending'),
      memberIds: inWindow.map(it => it.id),
      // P0：来源 + 置信度聚合 + 首条坐标（straw 组可展示置信度范围与地理坐标）
      source: ws.find(w => w.source)?.source || '',
      confidenceMin: confs.length ? Math.min(...confs) : null,
      confidenceMax: confs.length ? Math.max(...confs) : null,
      confidenceAvg: confs.length ? Number((confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(3)) : null,
      lat: firstLoc && firstLoc.lat != null ? firstLoc.lat : null,
      lon: firstLoc && firstLoc.lon != null ? firstLoc.lon : null,
      // 轻量级轮询也附带一张预览图（取组内首条含 picUrl 的成员），让前端聚合卡片能显示真实图片
      // 2026-09-03 D 加固：跳过 6882 认证网关形态死链（上游 9/2 19:32 切换后新图多为此形态）取首个健康成员；
      //   全组无健康图则退回首条含图成员（iotsource 后端 5001 回退仍可能救活），不再因首条死链整组挂图。
      previewPicUrl: (() => {
        const withPic = inWindow.filter(it => it.w && it.w.picUrl)
        if (withPic.length === 0) return null
        return (withPic.find(it => !is6882GatewayPic(it.w.picUrl)) || withPic[0]).w.picUrl
      })(),
    }
    if (!lightweight) {
      agg.members = inWindow.map(it => ({ id: it.id, picUrl: it.w.picUrl, createdAt: it.w.createdAt, level: it.w.level, aiConfidence: it.w.aiConfidence, channelName: it.w.channelName }))
    }
    result.push(agg)
  }
  result.sort((a, b) => {
    const ta = a.isAggregate ? a.latestTime : a.createdAt
    const tb = b.isAggregate ? b.latestTime : b.createdAt
    return (tb || '').localeCompare(ta || '')
  })
  return result.slice(0, Number(limit) || 200)
}

// 按 id 批量查询 warning 成员详情（供研判依据弹窗按需拉取）
function getWarningsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return []
  const capped = ids.slice(0, 100)
  const placeholders = capped.map(() => '?').join(',')
  return db.prepare(`SELECT data_json FROM warnings WHERE id IN (${placeholders})`).all(...capped)
    .map(r => JSON.parse(r.data_json))
    // P2 补丁：补 status/review —— 研判依据弹窗「已处置 n/N」「组归因徽标」依赖成员状态，缺则恒不渲染
    .map(w => ({ id: w.id, picUrl: w.picUrl || '', createdAt: w.createdAt, level: w.level, aiConfidence: w.aiConfidence, channelName: w.channelName, aiType: w.aiType, status: w.status, review: w.review }))
}

// 汇总一次推送/结案涉及的全部 AI 置信度样本 → { min, max, avg, count }
// 数据源：event.raw_json.memberIds → 反查 warnings.aiConfidence（聚合告警：多图多置信度）；
//        无 memberIds（单条告警）→ 取 raw_json.aiConfidence。
// 无样本时返回全 ''（count=0），保证不产生坏数据。供 getClosureReportData 与 executePush 共用。
function computeAiConfidenceStats(events) {
  // 把原始值转成有效置信度数字；null/undefined/''/非数字 → null（跳过，避免 Number(null)=0 被误判）
  const toConf = v => {
    if (v === null || v === undefined || v === '') return null
    const c = Number(v)
    return Number.isFinite(c) ? c : null
  }
  const samples = []
  for (const ev of (events || [])) {
    let raw = null
    try { raw = ev.raw_json ? JSON.parse(ev.raw_json) : null } catch {}
    if (!raw) continue
    if (Array.isArray(raw.memberIds) && raw.memberIds.length) {
      // 聚合告警：memberIds 指向 AI分析存档多条记录，逐条取 aiConfidence（getWarningsByIds cap 100）
      for (const w of getWarningsByIds(raw.memberIds)) {
        const c = toConf(w.aiConfidence)
        if (c !== null) samples.push(c)
      }
    } else {
      // 单条告警：取其自身 aiConfidence
      const c = toConf(raw.aiConfidence)
      if (c !== null) samples.push(c)
    }
  }
  if (!samples.length) return { min: '', max: '', avg: '', count: 0 }
  const min = Math.min(...samples), max = Math.max(...samples)
  const avg = samples.reduce((s, c) => s + c, 0) / samples.length
  return { min: min.toFixed(2), max: max.toFixed(2), avg: avg.toFixed(2), count: samples.length }
}

// 批量标记一组原始记录为已处理（聚合告警"标记处理"用）
function handleGroupWarnings(memberIds, handledBy, review) {
  const now = new Date().toISOString()
  const upd = db.prepare('UPDATE warnings SET status = ?, data_json = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    let n = 0
    for (const id of memberIds) {
      const w = getWarning(id)
      if (!w || w.status === 'handled') continue
      w.status = 'handled'; w.handledAt = now; w.handledBy = handledBy || '值守人员'
      // T18: 误报归因持久化（review={verdict,note,by,at}）—— 向后兼容，无 review 时不写
      if (review && (review.verdict || review.note)) {
        w.review = {
          verdict: review.verdict || 'valid',
          note: review.note || '',
          by: review.by || handledBy || '值守人员',
          at: now,
        }
      }
      upd.run('handled', JSON.stringify(w), id)
      n++
    }
    db.exec('COMMIT')
    return n
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

// 预警类型分布（供 /api/stats），返回 { [warningType]: count }
function warningTypeDistribution() {
  const rows = db.prepare('SELECT warning_type, COUNT(*) c FROM warnings GROUP BY warning_type').all()
  const out = {}
  for (const r of rows) out[r.warning_type] = r.c
  return out
}
function warningCount() { return db.prepare('SELECT COUNT(*) c FROM warnings').get().c }

// 近 N 天告警趋势：按「上海本地日期」聚合每天告警数（含今天），返回完整日期序列（无数据的日子计 0）
// 服务器时区为 UTC，故 created_at 用 date(created_at,'+8 hours') 映射到上海日历日；
// 日期序列同样以「上海此刻」为锚点倒推，保证前后端时区一致。
const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
function warningTrend(days) {
  const n = Math.max(1, Math.min(Number(days) || 7, 30))
  const rows = db.prepare(
    "SELECT date(created_at, '+8 hours') AS d, COUNT(*) c FROM warnings WHERE created_at IS NOT NULL"
    // P0-1：前台统计口径不包含被研判拦下的记录
    + " AND (judge_status IS NULL OR judge_status <> 'blocked') GROUP BY d"
  ).all()
  const map = {}
  for (const r of rows) map[r.d] = r.c
  const result = []
  // 上海此刻（服务器 UTC + 8h）
  const shNow = new Date(Date.now() + 8 * 3600 * 1000)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(shNow)
    d.setDate(d.getDate() - i)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const key = `${y}-${m}-${day}`
    result.push({ date: key, weekday: WEEK_LABELS[d.getDay()], count: map[key] || 0 })
  }
  return result
}

// 轻量计数（健康检查用，避免全表反序列化）
function tableCount(table) {
  const ok = { collect_logs: 1, sms_history: 1, sms_reports: 1, warnings: 1, collected: 1 }
  if (!ok[table]) return 0
  return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
}

// ── 采集日志 collect_logs ──
function insertCollectLog(entry) {
  db.prepare('INSERT OR REPLACE INTO collect_logs (id, time, status, data_json) VALUES (?,?,?,?)')
    .run(entry.id, entry.time ?? null, entry.status ?? null, JSON.stringify(entry))
}
function queryCollectLogs({ status, limit } = {}) {
  let sql = 'SELECT data_json FROM collect_logs'
  const args = []
  if (status) { sql += ' WHERE status = ?'; args.push(status) }
  sql += ' ORDER BY rowid DESC'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  return db.prepare(sql).all(...args).map(r => JSON.parse(r.data_json))
}

// ── 短信历史 sms_history ──
function insertSmsHistory(entry) {
  db.prepare('INSERT OR REPLACE INTO sms_history (id, time, status, data_json) VALUES (?,?,?,?)')
    .run(entry.id, entry.time ?? null, entry.status ?? null, JSON.stringify(entry))
}
function querySmsHistory({ status, limit } = {}) {
  let sql = 'SELECT data_json FROM sms_history'
  const args = []
  if (status) { sql += ' WHERE status = ?'; args.push(status) }
  sql += ' ORDER BY rowid DESC'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  return db.prepare(sql).all(...args).map(r => JSON.parse(r.data_json))
}

// ── 短信回执/上行 sms_reports ──
function insertSmsReport(entry) {
  db.prepare('INSERT OR REPLACE INTO sms_reports (id, received_at, type, data_json) VALUES (?,?,?,?)')
    .run(entry.id, entry.receivedAt ?? null, entry.type ?? null, JSON.stringify(entry))
}
function querySmsReports({ type, limit } = {}) {
  let sql = 'SELECT data_json FROM sms_reports'
  const args = []
  if (type) { sql += ' WHERE type = ?'; args.push(type) }
  sql += ' ORDER BY rowid DESC'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  return db.prepare(sql).all(...args).map(r => JSON.parse(r.data_json))
}

// ════════════════════════════════════════════════════════════
//  配置型集合层：streams / map_points / datasources / sms_contacts
//                / sms_templates / sms_blacklist （表名 coll_<name>）
//  对外等价"数组进数组出"，但底层逐行存储；按 rowid 保序。
//  允许的集合白名单，防 SQL 注入表名。
// ════════════════════════════════════════════════════════════
const COLL_OK = {
  streams: 1, map_points: 1, datasources: 1,
  sms_contacts: 1, sms_templates: 1, sms_blacklist: 1,
}
function collTable(name) {
  if (!COLL_OK[name]) throw new Error('未知集合: ' + name)
  return 'coll_' + name
}

// 读出整个集合为数组（按 rowid 保序）
function collList(name) {
  const t = collTable(name)
  return db.prepare(`SELECT data_json FROM ${t} ORDER BY rowid ASC`).all().map(r => JSON.parse(r.data_json))
}

// 用给定数组整体替换集合（事务内 清空+按序插入）。保留原 saveXxx(arr) 语义。
function collReplaceAll(name, arr) {
  const t = collTable(name)
  const del = db.prepare(`DELETE FROM ${t}`)
  const ins = db.prepare(`INSERT INTO ${t} (id, data_json) VALUES (?, ?)`)
  db.exec('BEGIN')
  try {
    del.run()
    for (const item of (arr || [])) {
      const id = item.id != null ? String(item.id) : null
      if (id == null) continue
      ins.run(id, JSON.stringify(item))
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
}

// 按 id 精准更新单条（合并 patch）。探测器用它，避免整表覆盖竞态。
// 返回更新后的对象；不存在返回 null。
function collPatchById(name, id, patch) {
  const t = collTable(name)
  const row = db.prepare(`SELECT data_json FROM ${t} WHERE id = ?`).get(String(id))
  if (!row) return null
  const obj = { ...JSON.parse(row.data_json), ...patch, id: String(id) }
  db.prepare(`UPDATE ${t} SET data_json = ? WHERE id = ?`).run(JSON.stringify(obj), String(id))
  return obj
}

function collCount(name) {
  const t = collTable(name)
  return db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
}

// ── 键值配置（icon_config 等单对象）──
function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT v_json FROM kv_config WHERE k = ?').get(key)
  if (!row) return fallback
  try { return JSON.parse(row.v_json) } catch { return fallback }
}
function kvSet(key, value) {
  db.prepare('INSERT OR REPLACE INTO kv_config (k, v_json) VALUES (?, ?)').run(key, JSON.stringify(value))
  return value
}

// ════════════════════════════════════════════════════════════
//  用户与会话（登录鉴权）
// ════════════════════════════════════════════════════════════
function userByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) || null
}
function userById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null
}
function userCount() { return db.prepare('SELECT COUNT(*) c FROM users').get().c }
function listUsers() {
  // 不返回 password_hash/salt
  return db.prepare('SELECT id, username, role, enabled, force_change, created_at, last_login_at FROM users ORDER BY rowid ASC').all()
}
function insertUser(u) {
  db.prepare(`INSERT INTO users (id, username, password_hash, salt, role, enabled, force_change, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(u.id, u.username, u.password_hash, u.salt, u.role, u.enabled === false ? 0 : 1,
         u.force_change ? 1 : 0, u.created_at || new Date().toISOString())
}
function updateUser(id, patch) {
  const u = userById(id)
  if (!u) return null
  const fields = []
  const args = []
  for (const k of ['username', 'password_hash', 'salt', 'role', 'enabled', 'force_change', 'last_login_at']) {
    if (patch[k] === undefined) continue
    fields.push(`${k} = ?`)
    args.push(k === 'enabled' || k === 'force_change' ? (patch[k] ? 1 : 0) : patch[k])
  }
  if (!fields.length) return u
  args.push(id)
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...args)
  return userById(id)
}
function deleteUser(id) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(id)
  return r.changes > 0
}

function createSession(s) {
  db.prepare('INSERT INTO sessions (token, user_id, username, role, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(s.token, s.user_id, s.username, s.role, s.created_at || new Date().toISOString(), s.expires_at)
}
function getSession(token) {
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token)
  if (!row) return null
  if (row.expires_at && Date.now() > row.expires_at) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return null
  }
  return row
}
function deleteSession(token) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token) }
function deleteUserSessions(userId) { db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId) }
function purgeExpiredSessions() { db.prepare('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now()) }

// ── IoT 通道接入（iot_channels）──
// 返回未软删的通道（camelCase），供后台「通道接入」与 fetcher 使用
function listIotChannels() {
  return db.prepare(`SELECT * FROM iot_channels WHERE deleted_at IS NULL ORDER BY created_at`)
    .all().map(r => ({
      channelSipId: r.channel_sip_id, channelName: r.channel_name,
      deviceSipId: r.device_sip_id, deviceName: r.device_name,
      streamId: r.stream_id, enabled: !!r.enabled, remark: r.remark || '',
      aiTypes: parseArr(r.ai_types),
      roi: parseObj(r.roi),
      createdAt: r.created_at, updatedAt: r.updated_at,
    }))
}
// 含软删行的总数（用于首次种子判定：只在表完全为空时种子）
function countIotChannelsAll() {
  return db.prepare('SELECT COUNT(*) c FROM iot_channels').get().c
}
// 接入（upsert）：已存在（含软删）则复活+刷新快照，否则新增
function upsertIotChannel(ch) {
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT created_at FROM iot_channels WHERE channel_sip_id = ?').get(ch.channelSipId)
  if (existing) {
    db.prepare(`UPDATE iot_channels SET channel_name=?, device_sip_id=?, device_name=?, stream_id=?, enabled=?, remark=?, updated_at=?, deleted_at=NULL WHERE channel_sip_id=?`)
      .run(ch.channelName, ch.deviceSipId || null, ch.deviceName || null, ch.streamId || null, ch.enabled ? 1 : 0, ch.remark || '', now, ch.channelSipId)
  } else {
    db.prepare(`INSERT INTO iot_channels (channel_sip_id, channel_name, device_sip_id, device_name, stream_id, enabled, remark, ai_types, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`)
      .run(ch.channelSipId, ch.channelName, ch.deviceSipId || null, ch.deviceName || null, ch.streamId || null, ch.enabled ? 1 : 0, ch.remark || '', '[]', now, now)
  }
  return getIotChannel(ch.channelSipId)
}
function getIotChannel(channelSipId) {
  const r = db.prepare('SELECT * FROM iot_channels WHERE channel_sip_id = ?').get(channelSipId)
  if (!r) return null
  return {
    channelSipId: r.channel_sip_id, channelName: r.channel_name,
    deviceSipId: r.device_sip_id, deviceName: r.device_name,
    streamId: r.stream_id, enabled: !!r.enabled, remark: r.remark || '',
    aiTypes: parseArr(r.ai_types),
    roi: parseObj(r.roi),
    createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
  }
}
// 更新映射/启停/备注/快照字段（patch）
function updateIotChannel(channelSipId, patch) {
  const fields = []
  const args = []
  if (patch.channelName !== undefined) { fields.push('channel_name = ?'); args.push(patch.channelName) }
  if (patch.deviceSipId !== undefined) { fields.push('device_sip_id = ?'); args.push(patch.deviceSipId) }
  if (patch.deviceName !== undefined) { fields.push('device_name = ?'); args.push(patch.deviceName) }
  if (patch.streamId !== undefined) { fields.push('stream_id = ?'); args.push(patch.streamId || null) }
  if (patch.enabled !== undefined) { fields.push('enabled = ?'); args.push(patch.enabled ? 1 : 0) }
  if (patch.remark !== undefined) { fields.push('remark = ?'); args.push(patch.remark) }
  if (patch.aiTypes !== undefined) { fields.push('ai_types = ?'); args.push(JSON.stringify(Array.isArray(patch.aiTypes) ? patch.aiTypes : [])) }
  if (patch.roi !== undefined) {
    const rv = (patch.roi && typeof patch.roi === 'object' && !Array.isArray(patch.roi)) ? patch.roi : {}
    fields.push('roi = ?'); args.push(JSON.stringify(rv))
  }
  if (!fields.length) return getIotChannel(channelSipId)
  fields.push("updated_at = ?")
  args.push(new Date().toISOString())
  args.push(channelSipId)
  db.prepare(`UPDATE iot_channels SET ${fields.join(', ')} WHERE channel_sip_id = ? AND deleted_at IS NULL`).run(...args)
  return getIotChannel(channelSipId)
}
function updateIotChannelAiTypes(channelSipId, aiTypes) {
  return updateIotChannel(channelSipId, { aiTypes: Array.isArray(aiTypes) ? aiTypes : [] })
}
// ROI 电子围栏：按算法名整体覆盖写入（roi 为 {算法名: {enable,polygon,...}}）
function updateIotChannelRoi(channelSipId, roi) {
  return updateIotChannel(channelSipId, { roi: (roi && typeof roi === 'object' && !Array.isArray(roi)) ? roi : {} })
}
// 供各识别链拉取：返回 [{channelSipId, channelName, algo, roi}]，可按 algo 过滤
function listIotRoiConfigs(algo) {
  const rows = db.prepare(`SELECT channel_sip_id, channel_name, roi FROM iot_channels
                           WHERE deleted_at IS NULL AND enabled = 1 ORDER BY created_at`).all()
  const out = []
  for (const r of rows) {
    const roi = parseObj(r.roi)
    if (algo) {
      if (roi[algo]) out.push({ channelSipId: r.channel_sip_id, channelName: r.channel_name, algo, roi: roi[algo] })
    } else if (Object.keys(roi).length) {
      out.push({ channelSipId: r.channel_sip_id, channelName: r.channel_name, roi })
    }
  }
  return out
}
// 1:1 冲突兜底：把占用某 streamId 的其它通道的 streamId 清空
function clearStreamMapping(streamId, exceptChannelSipId) {
  if (!streamId) return 0
  const now = new Date().toISOString()
  const r = db.prepare(`UPDATE iot_channels SET stream_id = NULL, updated_at = ? WHERE stream_id = ? AND channel_sip_id <> ? AND deleted_at IS NULL`).run(now, streamId, exceptChannelSipId)
  return r.changes
}
// 软删除
function softDeleteIotChannel(channelSipId) {
  const now = new Date().toISOString()
  const r = db.prepare(`UPDATE iot_channels SET deleted_at = ?, updated_at = ? WHERE channel_sip_id = ? AND deleted_at IS NULL`).run(now, now, channelSipId)
  return r.changes
}

module.exports = {
  init, insert, existsByPointTime, buildHistory,
  query, queryRange, distinctPoints, counts, getDb, rowToRecord,
  // 预警
  insertWarning, onWarningInsert, queryWarnings, getWarning, updateWarningStatus, handleAllWarnings,
  updateWarningReview, listStrawSamples, queryStrawPushLogs, saveWarningData,
  importAreaResponsibilities, listAreaResponsibilities, deleteAreaResponsibility, findResponsibility,
  listBoundaries, replaceBoundaries, updateBoundaryTown, listBoundarySnapshots, restoreBoundarySnapshot,
  upsertWarningFromChengyun, setWarningVideoUrl,
  // AI 类型主数据 + 推送规则
  listAiTypes, createAiType, deleteAiType, getAiTypeKeyMap, ensureAiTypeByKey, getAiTypeHealth,
  listPushRules, getPushRule, createPushRule, updatePushRule, deletePushRule,
  // 研判闸门（P0-1/P0-2/P0-3/P1-1~P1-4）
  judgeWarning, pickPushRule, getJudgeDefaultPolicy, setJudgeDefaultPolicy, judgeCoverage,
  judgeStats, judgeDryRun, evalRuleAgainst, inActiveHours, judgeRuleConflicts,
  onWarningAdmittedForPush, generatePushRulesForChannels,
  streamFallbackName, sikongStreamLabel, SIM_STREAM_LABEL,
  // 告警过滤规则
  listAlertFilterRules, getAlertFilterRule, createAlertFilterRule, updateAlertFilterRule, deleteAlertFilterRule,
  resolveSourceKey, alertFilterRuleHit, sikongStreamLabel,
  // 按算法保留期（软归档）· 2026-09-24
  listAlgoRetention, getAlgoRetention, upsertAlgoRetention, deleteAlgoRetention,
  retentionKeepDays, warningRetentionExpired, retentionDryRun, retentionVersion, invalidateRetentionCache,
  RETENTION_DEFAULT_KEY, RETENTION_GAS_KEY, RETENTION_RESERVED_KEYS, RETENTION_KEY_LABEL,
  queryWarningsAggregated, handleGroupWarnings, getWarningsByIds, computeAiConfidenceStats,
  queryWarningsForExport, exportWarningLevel,
  warningTypeDistribution, warningCount, warningTrend, tableCount,
  // 采集日志
  insertCollectLog, queryCollectLogs,
  // 短信历史 / 回执
  insertSmsHistory, querySmsHistory, insertSmsReport, querySmsReports,
  // 配置型集合 + 键值
  collList, collReplaceAll, collPatchById, collCount, kvGet, kvSet,
  // 用户 / 会话
  userByName, userById, userCount, listUsers, insertUser, updateUser, deleteUser,
  createSession, getSession, deleteSession, deleteUserSessions, purgeExpiredSessions,
  // IoT 通道接入
  listIotChannels, countIotChannelsAll, upsertIotChannel, getIotChannel, updateIotChannel, updateIotChannelAiTypes, clearStreamMapping, softDeleteIotChannel,
  updateIotChannelRoi, listIotRoiConfigs,
  // IoT recordId 去重留痕
  iotSeenAll, iotMarkSeen, iotSeenPrune,
  // 智治推送回调闭环
  markEventsPushed, recordSmartPushCallback, closeSmartPushHistory, getSmartPushHistory,
  // P2 目标平台
  listSmartPushPlatforms, getSmartPushPlatform, upsertSmartPushPlatform, deleteSmartPushPlatform, platformSubscribes,
  // 第③环 PDF 结案报告模板
  listReportTemplates, getReportTemplate, getDefaultReportTemplate, upsertReportTemplate, setDefaultReportTemplate, deleteReportTemplate,
  getClosureReportData, setHistoryReportPath,
  // 智治推送「工作报表」聚合
  getWorkReportData,
}
