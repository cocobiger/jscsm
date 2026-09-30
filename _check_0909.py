import sqlite3
c = sqlite3.connect('/opt/jsc/backend/data/jsc.db')
c.row_factory = sqlite3.Row
n = c.execute("SELECT COUNT(*) FROM straw_detections WHERE stream_id LIKE '%0S4G%' AND ts LIKE '2026-09-09%'").fetchone()[0]
print('9/9 0S4G straw_detections 记录数:', n)
print()
for r in c.execute("SELECT id, ts, label, max_conf, source, review_status FROM straw_detections WHERE stream_id LIKE '%0S4G%' AND ts LIKE '2026-09-09%' ORDER BY id DESC LIMIT 8"):
    print('  id=%s ts=%s label=%s conf=%s source=%s review=%s' % (r['id'], r['ts'], r['label'], r['max_conf'], r['source'], r['review_status']))
print()
# 9/9 各天的 0S4G 记录分布
for r in c.execute("SELECT substr(ts,1,10) d, COUNT(*) c FROM straw_detections WHERE stream_id LIKE '%0S4G%' GROUP BY d ORDER BY d DESC LIMIT 5"):
    print('  %s: %s 条' % (r['d'], r['c']))
