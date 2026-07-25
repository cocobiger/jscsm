// 临时创建一个 admin session 用于测试
const crypto = require('node:crypto')
const db = require('node:sqlite')
const s = new db.DatabaseSync('data/jsc.db')
const user = s.prepare("SELECT * FROM users WHERE username='admin'").get()
if (!user) { console.log('no admin user'); process.exit(1) }
const token = crypto.randomBytes(32).toString('hex')
const expires_at = Date.now() + 24 * 3600 * 1000
s.prepare("INSERT INTO sessions (token, user_id, username, role, expires_at) VALUES (?, ?, ?, ?, ?)").run(
  token, user.id, user.username, user.role, expires_at
)
console.log('TOKEN:', token)
