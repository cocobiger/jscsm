import sqlite3, json

# 读 JSON 数据
with open('/tmp/sync_payload.json', 'r', encoding='utf-8') as f:
    payload = json.load(f)

streams = payload['streams']
map_points = payload['map_points']

db_path = '/opt/jsc/backend/data/jsc.db'
conn = sqlite3.connect(db_path)
cur = conn.cursor()

# 清空旧数据
cur.execute('DELETE FROM coll_streams')
cur.execute("DELETE FROM coll_map_points WHERE json_extract(data_json, '$.type')='camera'")
print('已清空旧数据')

# 插入视频流
for item in streams:
    cur.execute('INSERT INTO coll_streams (id, data_json) VALUES (?, ?)', (item['id'], item['data_json']))
print(f'已插入 {len(streams)} 条视频流')

# 插入地图点位
for item in map_points:
    cur.execute('INSERT OR REPLACE INTO coll_map_points (id, data_json) VALUES (?, ?)', (item['id'], item['data_json']))
print(f'已插入 {len(map_points)} 个摄像头地图点位')

conn.commit()

# 验证
cur.execute('SELECT COUNT(*) FROM coll_streams')
print(f'\n验证: coll_streams 共 {cur.fetchone()[0]} 条')

cur.execute("SELECT json_extract(data_json, '$.group'), COUNT(*) FROM coll_streams GROUP BY json_extract(data_json, '$.group')")
print('按群组分组:')
for g, cnt in cur.fetchall():
    print(f'  {g or "(无群组)"}: {cnt} 条')

cur.execute("SELECT COUNT(*) FROM coll_map_points WHERE json_extract(data_json, '$.type')='camera'")
print(f'\ncamera 类地图点位: {cur.fetchone()[0]} 个')

conn.close()
print('\n✅ 同步完成')
