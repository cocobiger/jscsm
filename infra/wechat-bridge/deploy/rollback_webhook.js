#!/usr/bin/env node
/**
 * rollback_webhook.js
 *
 * 一键回滚 area_responsibility.webhook 从 wechat-bridge 切回企业微信
 * 数据源: area_responsibility_20260830_backup (switch_webhook.js 切换时自动创建的克隆)
 *
 * 用法:
 *   node rollback_webhook.js                    # 预览回滚动作
 *   node rollback_webhook.js --execute          # 真正执行回滚
 *   node rollback_webhook.js --drop-backup      # 回滚后删除备份表(慎用)
 */

const { DatabaseSync } = require('node:sqlite');
const DB_PATH = '/opt/jsc/backend/data/jsc.db';
const BACKUP_SUFFIX = '20260830';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    execute: args.includes('--execute'),
    dropBackup: args.includes('--drop-backup'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

function main() {
  const opts = parseArgs();
  if (opts.help) {
    console.log(`
rollback_webhook.js - 把 area_responsibility.webhook 从 wechat-bridge 切回企微

用法:
  (无参数)         仅预览, 不写库
  --execute        真正执行回滚
  --drop-backup    回滚后删除 area_responsibility_${BACKUP_SUFFIX}_backup
  --help           本帮助
`);
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  const backupName = `area_responsibility_${BACKUP_SUFFIX}_backup`;

  const exists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name=?
  `).get(backupName);
  if (!exists) {
    console.error(`ERROR: 备份表 ${backupName} 不存在, 无法回滚`);
    process.exit(1);
  }

  // 对比差异
  const diffs = db.prepare(`
    SELECT a.id, a.town, a.community, a.unit, a.webhook AS cur, b.webhook AS orig
    FROM area_responsibility a
    LEFT JOIN ${backupName} b ON a.id = b.id
    WHERE a.webhook IS NOT b.webhook OR (a.webhook IS NULL) != (b.webhook IS NULL)
    ORDER BY a.id
  `).all();

  if (diffs.length === 0) {
    console.log('当前表与备份表完全一致, 无需回滚');
    return;
  }

  console.log(`发现 ${diffs.length} 条记录被修改过:`);
  for (const d of diffs) {
    const cur = d.cur || 'NULL', orig = d.orig || 'NULL';
    const cs = cur.length > 80 ? cur.substring(0, 80) + '...' : cur;
    const os = orig.length > 80 ? orig.substring(0, 80) + '...' : orig;
    console.log(`  id=${d.id} | ${d.town}/${d.community}`);
    console.log(`    当前:  ${cs}`);
    console.log(`    原值:  ${os}`);
  }

  if (!opts.execute) {
    console.log('\n[PREVIEW] 加上 --execute 真正执行回滚');
    return;
  }

  // 执行回滚: 把 backup 表的 webhook 复制回主表
  const upd = db.prepare(`UPDATE area_responsibility SET webhook = (SELECT webhook FROM ${backupName} WHERE id = area_responsibility.id)`);
  const r = upd.run();
  console.log(`已回滚 ${r.changes} 条记录`);

  if (opts.dropBackup) {
    db.exec(`DROP TABLE ${backupName}`);
    console.log(`已删除备份表 ${backupName}`);
  } else {
    console.log(`(备份表 ${backupName} 仍保留, 可手动 DROP 或加 --drop-backup 自动删)`);
  }
}

try { main(); } catch (e) { console.error('FATAL:', e.message); process.exit(1); }
