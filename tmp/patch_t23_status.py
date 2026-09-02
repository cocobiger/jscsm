#!/usr/bin/env python3
"""P4-T23 补丁：后端 /api/warnings 支持 status 过滤"""
import sys

def patch(path, old, new, label):
    with open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    if old not in src:
        print(f'FAIL {label}: old not found ({path})')
        return False
    if src.count(old) != 1:
        print(f'FAIL {label}: old occurs {src.count(old)} times ({path})')
        return False
    new_src = src.replace(old, new, 1)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_src)
    print(f'OK {label}: written ({path})')
    return True

OK = True
OK &= patch('/opt/jsc/backend/store-db.js',
    'function queryWarnings({ type, excludeType, limit } = {}) {',
    'function queryWarnings({ type, excludeType, limit, status } = {}) {',
    'store-db.js queryWarnings signature')
OK &= patch('/opt/jsc/backend/store-db.js',
    "  if (excludeType) {\n    // \u652f\u6301\u9017\u53f7\u5206\u9694\u591a\u503c\u6392\u9664\uff1aexclude_type=iot-video-analysis,chengyun-platform\n    const excludes = excludeType.split(',').map(t => t.trim()).filter(Boolean)\n    if (excludes.length > 0) { where.push(`warning_type NOT IN (${excludes.map(() => '?').join(',')})`); args.push(...excludes) }\n  }\n  if (where.length) sql += ' WHERE ' + where.join(' AND ')",
    "  if (excludeType) {\n    // \u652f\u6301\u9017\u53f7\u5206\u9694\u591a\u503c\u6392\u9664\uff1aexclude_type=iot-video-analysis,chengyun-platform\n    const excludes = excludeType.split(',').map(t => t.trim()).filter(Boolean)\n    if (excludes.length > 0) { where.push(`warning_type NOT IN (${excludes.map(() => '?').join(',')})`); args.push(...excludes) }\n  }\n  if (status) { where.push('status = ?'); args.push(status) }\n  if (where.length) sql += ' WHERE ' + where.join(' AND ')",
    'store-db.js status WHERE')
OK &= patch('/opt/jsc/backend/index.js',
    "app.get('/api/warnings', (req, res) => {\n  const { type, exclude_type, limit, aggregate, lightweight } = req.query",
    "app.get('/api/warnings', (req, res) => {\n  const { type, exclude_type, limit, aggregate, lightweight, status } = req.query",
    'index.js /api/warnings destructure')
OK &= patch('/opt/jsc/backend/index.js',
    "  res.json(store.queryWarnings({ type: type || undefined, excludeType: exclude_type || undefined, limit: Number(limit) || 200 }))",
    "  res.json(store.queryWarnings({ type: type || undefined, excludeType: exclude_type || undefined, limit: Number(limit) || 200, status: status || undefined }))",
    'index.js /api/warnings status passthrough')
sys.exit(0 if OK else 1)