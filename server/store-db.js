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

  // 为 push_rules 增加 ai_types 列
  try { db.exec(`ALTER TABLE push_rules ADD COLUMN ai_types TEXT NOT NULL DEFAULT '[]';`) } catch (e) {}

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
function insertWarning(w) {
  db.prepare('INSERT OR REPLACE INTO warnings (id, created_at, status, warning_type, data_json) VALUES (?,?,?,?,?)')
    .run(w.id, w.createdAt ?? null, w.status ?? 'pending', w.warningType ?? null, JSON.stringify(w))
}
function queryWarnings({ type, excludeType, limit } = {}) {
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
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY rowid DESC'
  if (limit) { sql += ' LIMIT ?'; args.push(Number(limit)) }
  return db.prepare(sql).all(...args).map(r => JSON.parse(r.data_json))
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
  return db.prepare('SELECT name, sort_order AS sortOrder FROM ai_types ORDER BY sort_order, name').all()
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
function listPushRules() {
  return db.prepare('SELECT * FROM push_rules ORDER BY created_at DESC').all()
    .map(r => ({ ...r, enabled: r.enabled === 1, channelSipId: r.channel_sip_id, aiTypes: parseArr(r.ai_types), timeWindowHours: r.time_window_hours }))
}
function getPushRule(id) {
  const r = db.prepare('SELECT * FROM push_rules WHERE id = ?').get(id)
  return r ? { ...r, enabled: r.enabled === 1, channelSipId: r.channel_sip_id, aiTypes: parseArr(r.ai_types), timeWindowHours: r.time_window_hours } : null
}
function createPushRule({ name, channel_sip_id, ai_types, time_window_hours, threshold, enabled }) {
  const id = require('crypto').randomUUID()
  const now = new Date().toISOString()
  const arr = Array.isArray(ai_types) ? ai_types : (ai_types ? [ai_types] : [])
  db.prepare('INSERT INTO push_rules (id,name,channel_sip_id,ai_type,ai_types,time_window_hours,threshold,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, channel_sip_id ?? null, arr[0] || '', JSON.stringify(arr), Number(time_window_hours) || 24, Number(threshold) || 20, enabled === false ? 0 : 1, now, now)
  return getPushRule(id)
}
function updatePushRule(id, patch) {
  const cur = getPushRule(id)
  if (!cur) return null
  const next = { ...cur, ...patch, id, updated_at: new Date().toISOString() }
  const arr = Array.isArray(next.aiTypes) ? next.aiTypes : (next.aiType ? [next.aiType] : [])
  db.prepare('UPDATE push_rules SET name=?, channel_sip_id=?, ai_type=?, ai_types=?, time_window_hours=?, threshold=?, enabled=?, updated_at=? WHERE id=?')
    .run(next.name, next.channelSipId ?? null, arr[0] || '', JSON.stringify(arr), Number(next.timeWindowHours) || 24, Number(next.threshold) || 20, next.enabled ? 1 : 0, next.updated_at, id)
  return getPushRule(id)
}
function deletePushRule(id) {
  return db.prepare('DELETE FROM push_rules WHERE id = ?').run(id).changes
}

// 聚合后的告警列表（供 /api/warnings?aggregate=1）：按规则把高频同组折叠成1条
// lightweight=true 时聚合对象不返回 members（供实时轮询降低 payload），点详情时用 by-ids 按需拉取
function queryWarningsAggregated({ limit, lightweight } = {}) {
  const rawRows = db.prepare(
    "SELECT id, created_at, data_json FROM warnings WHERE status='pending' AND json_extract(data_json,'$.source') IN ('iotcloud','chengyun-platform')"
  ).all()
  const rules = listPushRules().filter(r => r.enabled)
  if (rules.length === 0) {
    return rawRows.map(r => JSON.parse(r.data_json)).slice(0, Number(limit) || 200)
  }
  const groups = new Map()
  for (const r of rawRows) {
    const w = JSON.parse(r.data_json)
    const cid = w.channelSipId || null
    const ai = w.aiType || '(未知)'
    const key = cid + '|' + ai
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ id: r.id, created_at: r.created_at, w })
  }
  const result = []
  const now = Date.now()
  for (const [key, items] of groups) {
    const [cid, ai] = key.split('|')
    const rule = rules.find(rl => rl.aiTypes.includes(ai) && (rl.channelSipId == null || rl.channelSipId === cid))
    if (!rule) { for (const it of items) result.push(it.w); continue }
    const windowMs = rule.timeWindowHours * 3600 * 1000
    const inWindow = items.filter(it => { const t = parseWarningTime(it.created_at); return !isNaN(t) && (now - t) <= windowMs })
    if (inWindow.length < rule.threshold) { for (const it of items) result.push(it.w); continue }
    const channelName = cid ? (getIotChannel(cid)?.channelName || cid) : '全部通道'
    const maxLevel = inWindow.reduce((m, it) => Math.max(m, Number(it.w.level) || 0), 0)
    const latestTime = inWindow.reduce((m, it) => it.created_at > m ? it.created_at : m, '')
    const agg = {
      isAggregate: true, ruleId: rule.id, ruleName: rule.name, channelSipId: cid, aiType: ai, channelName,
      windowHours: rule.timeWindowHours, threshold: rule.threshold, count: inWindow.length, maxLevel, latestTime,
      memberIds: inWindow.map(it => it.id),
      // 轻量级轮询也附带一张预览图（取组内首条含 picUrl 的成员），让前端聚合卡片能显示真实图片
      previewPicUrl: (inWindow.find(it => it.w && it.w.picUrl)?.w.picUrl) || null,
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
    .map(w => ({ id: w.id, picUrl: w.picUrl || '', createdAt: w.createdAt, level: w.level, aiConfidence: w.aiConfidence, channelName: w.channelName, aiType: w.aiType }))
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
function handleGroupWarnings(memberIds, handledBy) {
  const now = new Date().toISOString()
  const upd = db.prepare('UPDATE warnings SET status = ?, data_json = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    let n = 0
    for (const id of memberIds) {
      const w = getWarning(id)
      if (!w || w.status === 'handled') continue
      w.status = 'handled'; w.handledAt = now; w.handledBy = handledBy || '值守人员'
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
    "SELECT date(created_at, '+8 hours') AS d, COUNT(*) c FROM warnings WHERE created_at IS NOT NULL GROUP BY d"
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
  insertWarning, queryWarnings, getWarning, updateWarningStatus, handleAllWarnings,
  upsertWarningFromChengyun, setWarningVideoUrl,
  // AI 类型主数据 + 推送规则
  listAiTypes, createAiType, deleteAiType,
  listPushRules, getPushRule, createPushRule, updatePushRule, deletePushRule,
  queryWarningsAggregated, handleGroupWarnings, getWarningsByIds, computeAiConfidenceStats,
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
