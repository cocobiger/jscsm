// 临时重置 admin 密码为 admin123
const crypto = require('crypto')
const db = require('node:sqlite')
const s = new db.DatabaseSync('data/jsc.db')
const password = 'admin123'
const salt = crypto.randomBytes(16).toString('hex')
const hash = crypto.scryptSync(password, salt, 64).toString('hex')
s.prepare("UPDATE users SET password_hash=?, salt=?, force_change=0 WHERE username='admin'").run(hash, salt)
console.log('admin password reset to admin123 (force_change=0)')
