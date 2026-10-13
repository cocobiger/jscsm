#!/usr/bin/env node
/**
 * 密钥门禁（被 pre-push 钩子调用）· 2026-10-13 新增
 *
 * 为什么有它：2026-10-13 发现本仓库是 **public**，而 ZLM API secret、司空 ZLM restful-secret、
 * ZLM 推流密钥自 2026-08-27 ~ 09-30 起就以明文躺在 `infra/` `server/` `deploy/` 里被公开了一个半月，
 * 且 `server/index.js` / `server/drone-events.js` 当时正是用「`process.env.X || '<明文>'`」的写法。
 * 光靠人眼 review 挡不住 ⇒ 前置成门禁。
 *
 * 判定三类（命中即阻断，非 0 退出）：
 *   ① **敏感名 + 非空字面量**：形如 `X_SECRET = ... || 'abc12345'`、`"password": "xxxx"`；
 *   ② **URL 里的 secret**：`?secret=<8+ 字符>` / `&secret=<8+ 字符>`；
 *   ③ **已知泄漏值黑名单**：`scripts/secret-denylist.txt` 里逐行写的 sha256 前 16 位
 *      （只存哈希不存明文 ⇒ 本文件自身不敏感）。
 *
 * 允许写法（不会误报）：`process.env.X || ''`、含 `<占位符>`、含 `示例/example/your_/change-me`、
 * 或者行内加 `secret-scan:ok` 标记。
 *
 * 用法：node scripts/secret-scan.mjs        （钩子自动调用；临时跳过 git push --no-verify）
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'

const TEXT_EXT = /\.(js|cjs|mjs|ts|tsx|jsx|py|sh|bash|json|ya?ml|toml|ini|conf|env|md|html|txt|ps1|cmd|sql|service)$/i
const SENSITIVE_NAME = /(secret|passwd|password|\bpwd\b|api[_-]?key|apikey|access[_-]?key|private[_-]?key|token|credential)/i
// ⚠️ 注意：这里**不能**排除 `process.env` —— 因为最该抓的正是
//   `process.env.X_SECRET || '<明文>'`（不带字面量的 process.env 本来就不会命中那条规则）。
const PLACEHOLDER = /(<[^>]*>|占位|示例|见服务器|未配置|example|your[_-]?|change[_-]?me|xxx+|\*\*\*|REDACTED|secret-scan:ok)/i

// ── 文件清单来源：**由钩子用 stdin 喂进来**（`git ls-files -z | node scripts/secret-scan.mjs`）。
//    为什么不自己 spawn git：① 本机安全策略会拦 Node 起的子进程（实测 `spawnSync git EBUSY`）；
//    ② 更要紧的是——如果"扫不了就静默通过"，门禁等于没有，比不装更危险。
//    ⇒ 拿不到清单时**显式阻断**并给出跳过办法。
let raw = ''
try { raw = fs.readFileSync(0, 'utf8') } catch { raw = '' }
let files = raw.split('\0').map(s => s.trim()).filter(Boolean)
let via = 'stdin'
if (!files.length) {
  try {
    files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').map(s => s.trim()).filter(Boolean)
    via = 'execFileSync'
  } catch (e) {
    console.error('[secret-scan] ✗ 拿不到被跟踪文件清单：' + (e && e.message))
    console.error('[secret-scan]   正常由 pre-push 钩子喂入：git ls-files -z | node ./scripts/secret-scan.mjs')
    console.error('[secret-scan]   **故意不静默通过**；确要跳过本次推送：git push --no-verify')
    process.exit(1)
  }
}

// 已知泄漏值黑名单（`scripts/secret-denylist.txt`，只存 sha256 前 16 位，不存明文）
let deny = []
try {
  deny = fs.readFileSync('scripts/secret-denylist.txt', 'utf8')
    .split('\n')
    .map(s => s.split('#')[0].trim())
    .filter(Boolean)
} catch { /* 没有黑名单文件也能跑（只做启发式检查） */ }

const sha16 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

// ── 检测规则（2026-10-13 按"高信号 / 低误报"标定；首版太钝，131 处误报 ⇒ 会被绕过 = 等于没装）──
//   A  env 兜底写死：`process.env.X_SECRET || '<占位>'`  ← 抓的就是本次事故的写法
//      （本行的示例用占位符写，否则会被自己的规则命中 —— 实测被拦过一次）
//   B  直接赋值敏感名 + 值像密钥（字母+数字，或超长）
//   C  URL 里带真 secret（排除 xyz/xxx/example/REPLACE 这类人为打码值）
//   D  已知泄漏值黑名单
const RE_ENV_FALLBACK = /process\.env\.[A-Za-z_][A-Za-z0-9_]*(?:SECRET|PASSWORD|KEY|TOKEN)[A-Za-z0-9_]*\s*\|\|\s*['"]([^'"]{6,})['"]/i
const RE_ASSIGN = /(?:^|[\s,{[(])["']?([A-Za-z0-9_\-]*(?:SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH_TOKEN|CLIENT_TOKEN))["']?\s*[:=]\s*["']([^"']{8,})["']/i
const RE_URL_SECRET = /[?&]secret=([A-Za-z0-9_\-]{16,})/
const MASKED = /xyz|xxx|example|REPLACE|changeme|redacted|\*\*\*/i
const STRONG = /(?=.*[A-Za-z])(?=.*\d)/   // 同时含字母和数字

// 存量技术债 allowlist（`scripts/secret-scan-allowlist.txt`，逐行 `路径:行号  # 原因`）
//   为什么要有它：门禁要能落地 —— 一次性把 1 个半月的存量全清完不现实，
//   但**新增**泄漏必须当场拦住。allowlist 只登记"已知且已评估"的存量，新增一律阻断。
let allow = new Set()
try {
  allow = new Set(
    fs.readFileSync('scripts/secret-scan-allowlist.txt', 'utf8')
      .split('\n').map(x => x.split('#')[0].trim()).filter(Boolean)
  )
} catch { /* 没有 allowlist 也不影响 */ }

const problems = []
const denyHits = []

for (const f of files) {
  if (!TEXT_EXT.test(f)) continue
  let lines
  try { lines = fs.readFileSync(f, 'utf8').split('\n') } catch { continue }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || !line.trim() || PLACEHOLDER.test(line) || MASKED.test(line)) continue

    if (allow.has(`${f}:${i + 1}`)) continue   // 存量已登记 ⇒ 跳过

    let m = line.match(RE_ENV_FALLBACK)
    if (m && !MASKED.test(m[1])) problems.push({ f, n: i + 1, why: 'env 兜底写死', hit: m[1] })

    m = line.match(RE_ASSIGN)
    if (m && (m[2].length >= 16 || STRONG.test(m[2]))) {
      problems.push({ f, n: i + 1, why: '敏感名被赋字面量', hit: m[2] })
    }

    m = line.match(RE_URL_SECRET)
    if (m) problems.push({ f, n: i + 1, why: 'URL 里带 secret', hit: m[1] })

    for (const tok of line.match(/[A-Za-z0-9_\-]{8,}/g) || []) {
      if (deny.includes(sha16(tok))) denyHits.push({ f, n: i + 1, hit: tok.slice(0, 4) + '…' })
    }
  }
}

if (!problems.length && !denyHits.length) {
  console.log(`[secret-scan] ✓ 未发现明文密钥（已扫 ${files.length} 个被跟踪文件，来源=${via}）`)
  process.exit(0)
}

console.error('')
console.error('[secret-scan] ✗ 发现疑似明文密钥 —— 推送已阻断')
console.error('')
for (const d of denyHits) console.error(`  [黑名单] ${d.f}:${d.n}  (${d.hit})`)
for (const p of problems.slice(0, 25)) {
  console.error(`  [${p.why}] ${p.f}:${p.n}  片段=${p.hit.slice(0, 6)}…`)
}
if (problems.length > 25) console.error(`  … 另有 ${problems.length - 25} 处`)
console.error('')
console.error('  修法：改成从 env / 数据库 / 服务器上的配置文件读取，**不留硬编码兜底**；')
console.error('        确属误报就在该行加 `secret-scan:ok` 标记。')
console.error('  说明：本门禁只看**工作区尖端**。已经进过历史的密钥必须**轮换**，删文件没用。')
console.error('')
process.exit(1)
