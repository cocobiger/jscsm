const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const s = new DatabaseSync('data/jsc.db');
const user = s.prepare("SELECT * FROM users WHERE username='admin'").get();
const token = crypto.randomBytes(32).toString('hex');
const expires_at = Date.now() + 3600000;
s.prepare("INSERT INTO sessions (token, user_id, username, role, expires_at) VALUES (?,?,?,?,?)").run(token, user.id, user.username, user.role, expires_at);
console.log(token);
