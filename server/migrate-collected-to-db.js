'use strict'
/**
 * 一次性迁移脚本：把 server/data 下的 JSON 历史记录导入 SQLite。
 *
 * 覆盖：
 *   collected.json     → collected 表（采集数据）
 *   warnings.json      → warnings 表（预警记录）
 *   collect_logs.json  → collect_logs 表（采集日志）
 *   sms_history.json   → sms_history 表（短信发送历史）
 *   sms_reports.json   → sms_reports 表（短信回执/上行）
 *
 * 用法（server 目录下）：
 *   node migrate-collected-to-db.js
 *
 * 特性：
 *   - 幂等：以记录 id 去重，已存在的跳过，可安全重复运行
 *   - 不删除原 json（保留作备份）
 *   - 事务批量插入，速度快
 *   - 顺序：原 json 为"新→旧"(unshift)，按"旧→新"插入，使 rowid DESC 读出仍为"新→旧"
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const store = require('./store-db')

const DATA_DIR = path.join(__dirname, 'data')

function readArr(file) {
  const p = path.join(DATA_DIR, file)
  if (!fs.existsSync(p)) return null
  try {
    const a = JSON.parse(fs.readFileSync(p, 'utf8'))
    return Array.isArray(a) ? a : []
  } catch (e) {
    console.error(`${file} 解析失败，跳过该文件：`, e.message)
    return []
  }
}

// 通用迁移：用 existQuery 取已有 id 集，insertFn 插入单条。reversed=true 时按旧→新插入。
function migrateTable(label, file, getExistingIds, insertFn) {
  const records = readArr(file)
  if (records === null) { console.log(`[${label}] 无 ${file}，跳过。`); return }
  if (records.length === 0) { console.log(`[${label}] ${file} 为空，跳过。`); return }

  const existing = getExistingIds()
  let inserted = 0, skipped = 0
  const db = store.getDb()
  db.exec('BEGIN')
  try {
    // 反转：原数组新→旧，倒序后变旧→新，保证 rowid 递增=时间递增
    for (const rec of [...records].reverse()) {
      const id = rec.id || crypto.randomUUID()
      if (existing.has(id)) { skipped++; continue }
      insertFn({ ...rec, id })
      existing.add(id)
      inserted++
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error(`[${label}] 迁移失败，已回滚：`, e.message)
    process.exit(1)
  }
  console.log(`[${label}] 新增 ${inserted} 条，跳过 ${skipped} 条（已存在）。原 ${file} 保留作备份。`)
}

function idSet(table) {
  return () => new Set(store.getDb().prepare(`SELECT id FROM ${table}`).all().map(r => r.id))
}

function main() {
  store.init(DATA_DIR, console)

  // collected（采集数据）：复用 store.insert
  migrateTable('采集数据', 'collected.json', idSet('collected'), (rec) => {
    store.insert(rec)
  })

  // warnings（预警）
  migrateTable('预警记录', 'warnings.json', idSet('warnings'), (rec) => {
    store.insertWarning(rec)
  })

  // collect_logs（采集日志）
  migrateTable('采集日志', 'collect_logs.json', idSet('collect_logs'), (rec) => {
    store.insertCollectLog(rec)
  })

  // sms_history（短信历史）
  migrateTable('短信历史', 'sms_history.json', idSet('sms_history'), (rec) => {
    store.insertSmsHistory(rec)
  })

  // sms_reports（短信回执/上行）
  migrateTable('短信回执', 'sms_reports.json', idSet('sms_reports'), (rec) => {
    store.insertSmsReport(rec)
  })

  // ── 配置型集合：从 json 数组导入对应集合表 ──
  // 规则：仅当集合当前为空时导入（幂等；避免覆盖运行中已改动的数据）。
  // 想强制以 json 为准重置，删掉库里对应 coll_ 表再跑即可。
  function migrateColl(label, file, coll) {
    const arr = readArr(file)
    if (arr === null) { console.log(`[${label}] 无 ${file}，跳过。`); return }
    if (arr.length === 0) { console.log(`[${label}] ${file} 为空，跳过。`); return }
    if (store.collCount(coll) > 0) { console.log(`[${label}] 集合已有 ${store.collCount(coll)} 条，跳过（避免覆盖）。`); return }
    store.collReplaceAll(coll, arr)
    console.log(`[${label}] 导入 ${arr.length} 条 → ${coll}。原 ${file} 保留作备份。`)
  }
  migrateColl('视频流',   'streams.json',       'streams')
  migrateColl('地图点位', 'map_points.json',    'map_points')
  migrateColl('数据源',   'datasources.json',   'datasources')
  migrateColl('短信联系人', 'sms_contacts.json', 'sms_contacts')
  migrateColl('短信模板', 'sms_templates.json', 'sms_templates')
  migrateColl('短信黑名单', 'sms_blacklist.json', 'sms_blacklist')

  // icon_config（单对象 → kv）
  ;(() => {
    const p = path.join(DATA_DIR, 'icon_config.json')
    if (!fs.existsSync(p)) { console.log('[图标配置] 无 icon_config.json，跳过。'); return }
    if (store.kvGet('icon_config') != null) { console.log('[图标配置] 库内已有，跳过。'); return }
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
      store.kvSet('icon_config', obj)
      console.log('[图标配置] 已导入 → kv_config。')
    } catch (e) { console.error('[图标配置] 解析失败，跳过：', e.message) }
  })()

  // 汇总
  console.log('────────────────────────────')
  console.log('迁移完成。当前库内条数：')
  console.log(`  采集数据 collected   : ${store.counts().total}（有效 ${store.counts().valid}）`)
  console.log(`  预警     warnings    : ${store.tableCount('warnings')}`)
  console.log(`  采集日志 collect_logs: ${store.tableCount('collect_logs')}`)
  console.log(`  短信历史 sms_history : ${store.tableCount('sms_history')}`)
  console.log(`  短信回执 sms_reports : ${store.tableCount('sms_reports')}`)
  console.log(`  视频流   streams     : ${store.collCount('streams')}`)
  console.log(`  地图点位 map_points  : ${store.collCount('map_points')}`)
  console.log(`  数据源   datasources : ${store.collCount('datasources')}`)
  console.log(`  短信联系人 contacts  : ${store.collCount('sms_contacts')}`)
  console.log(`  短信模板 templates   : ${store.collCount('sms_templates')}`)
  console.log(`  短信黑名单 blacklist : ${store.collCount('sms_blacklist')}`)
  console.log('原 json 文件均已保留作备份（未删除）。')
}

main()
