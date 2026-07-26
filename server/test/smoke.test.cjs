// 后端冒烟测试：用 Node 内置 node:test + node:sqlite
// 在临时目录初始化 store-db，验证关键数据往返。
// 运行：node --test server/test
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const store = require('../store-db')

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsc-test-'))
  store.init(dir, console)
  return dir
}

test('report template 增查往返', () => {
  freshDb()
  const t = {
    name: '冒烟模板',
    kind: 'workreport',
    content: '<html><body>hi</body></html>',
    blocks_json: JSON.stringify([{ id: 'b1', type: 'title' }]),
  }
  const res = store.upsertReportTemplate(t)
  assert.ok(res && res.ok, 'upsert 应返回 ok')
  const id = res.id
  assert.ok(id, 'upsert 应返回新 id')
  const got = store.getReportTemplate(id)
  assert.strictEqual(got.name, '冒烟模板')
  assert.strictEqual(got.blocks_json, t.blocks_json)
  const list = store.listReportTemplates('workreport')
  assert.ok(list.find((x) => x.id === id), '列表应包含该模板')
})

test('map_points 集合替换往返', () => {
  freshDb()
  const arr = [{ id: 'm1', name: '点位一', lat: 30.8, lon: 108.3 }]
  store.collReplaceAll('map_points', arr)
  const got = store.collList('map_points')
  assert.strictEqual(got.length, 1)
  assert.strictEqual(got[0].name, '点位一')
})
