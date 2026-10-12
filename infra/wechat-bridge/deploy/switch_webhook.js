#!/usr/bin/env node
/**
 * switch_webhook.js
 *
 * 把 area_responsibility 表的 webhook 从企业微信切到 wechat-bridge
 * 用法:
 *   # 1. 先看当前清单(列出所有记录, 方便对照填群名)
 *   node switch_webhook.js --list
 *
 *   # 2. 单条切换(把 id=1 的 webhook 改为指定群名)
 *   node switch_webhook.js --set 1 --group '天城街道秸秆处置群'
 *
 *   # 3. 批量切换(从 JSON 文件读映射, 一次性切)
 *   node switch_webhook.js --batch group_mapping.json
 *
 *   # 4. 全表预览切换结果(不写库, 仅打印)
 *   node switch_webhook.js --preview --batch group_mapping.json
 *
 *   # 5. 一键回滚
 *   node rollback_webhook.js
 *
 * 自动行为:
 *   - 切换前自动把原表改名为 area_responsibility_20260830_backup
 *   - 在新表 area_responsibility 上 UPDATE
 *   - 同时保留新旧两张表, 任意时刻可回滚
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = '/opt/jsc/backend/data/jsc.db';
const BRIDGE_HOST = process.env.WXBRIDGE_HOST || '172.16.8.15';
const BRIDGE_PORT = process.env.WXBRIDGE_PORT || '18888';
const BACKUP_SUFFIX = '20260830';

function openDb() {
  return new DatabaseSync(DB_PATH);
}

function listAll(db) {
  const rows = db.prepare(`
    SELECT id, town, community, unit, person, webhook
    FROM area_responsibility
    ORDER BY id
  `).all();
  return rows;
}

function ensureBackupTable(db) {
  // 备份原表(用 CREATE TABLE ... AS SELECT 克隆, 保留所有数据)
  const exists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='area_responsibility_${BACKUP_SUFFIX}_backup'
  `).get();
  if (!exists) {
    db.exec(`
      CREATE TABLE area_responsibility_${BACKUP_SUFFIX}_backup AS
      SELECT * FROM area_responsibility
    `);
    console.log(`[BACKUP] 已创建 area_responsibility_${BACKUP_SUFFIX}_backup (原始数据)`);
  } else {
    console.log(`[BACKUP] area_responsibility_${BACKUP_SUFFIX}_backup 已存在, 跳过`);
  }
}

function buildWebhookUrl(groupName) {
  // wechat-bridge 的 group 参数接受模糊匹配, URL encode 安全
  return `http://${BRIDGE_HOST}:${BRIDGE_PORT}/send?group=${encodeURIComponent(groupName)}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list') opts.list = true;
    else if (a === '--set') { opts.set = parseInt(args[++i], 10); }
    else if (a === '--group') { opts.group = args[++i]; }
    else if (a === '--batch') { opts.batch = args[++i]; }
    else if (a === '--preview') opts.preview = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function showHelp() {
  console.log(`
switch_webhook.js - 把 area_responsibility.webhook 从企微切到 wechat-bridge

用法:
  --list                         列出当前所有记录
  --set <id> --group <name>      单条切换(id + 群名)
  --batch <json>                 批量切换(json 格式: [{"id":1,"group":"..."}, ...])
  --preview                      与 --batch 配合, 只打印不写库
  --help                         本帮助

环境变量:
  WXBRIDGE_HOST   默认 172.16.8.15
  WXBRIDGE_PORT   默认 18888
`);
}

async function main() {
  const opts = parseArgs();
  if (opts.help || Object.keys(opts).length === 0) { showHelp(); return; }

  const db = openDb();

  if (opts.list) {
    const rows = listAll(db);
    console.log(`当前 area_responsibility 共 ${rows.length} 条:`);
    for (const r of rows) {
      const wh = r.webhook || 'NULL';
      const shortWh = wh.length > 90 ? wh.substring(0, 90) + '...' : wh;
      console.log(`  id=${r.id} | ${r.town}/${r.community} | ${r.unit} | ${r.person}`);
      console.log(`    webhook: ${shortWh}`);
    }
    return;
  }

  if (!opts.preview) ensureBackupTable(db);

  let updates = [];
  if (opts.set && opts.group) {
    updates.push({ id: opts.set, group: opts.group });
  } else if (opts.batch) {
    const data = JSON.parse(fs.readFileSync(opts.batch, 'utf8'));
    if (!Array.isArray(data)) throw new Error('--batch 参数必须是 JSON 数组');
    updates = data;
  } else {
    console.error('ERROR: 缺少参数, --set/--group 或 --batch 二选一');
    process.exit(1);
  }

  console.log(opts.preview ? '[PREVIEW] 不会写库' : '[EXECUTE] 开始切换');
  const upd = db.prepare('UPDATE area_responsibility SET webhook = ? WHERE id = ?');
  for (const u of updates) {
    const newUrl = buildWebhookUrl(u.group);
    if (!opts.preview) {
      const r = upd.run(newUrl, u.id);
      console.log(`  id=${u.id} | group="${u.group}" | ${r.changes} 行受影响 | ${newUrl}`);
    } else {
      console.log(`  id=${u.id} | group="${u.group}" | ${newUrl}`);
    }
  }
  console.log(opts.preview ? '预览完毕, 未写库' : '切换完成');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
