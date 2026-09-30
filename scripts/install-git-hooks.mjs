#!/usr/bin/env node
/**
 * 安装 Git 钩子：pre-push 类型门禁（P1 · 2026-09-14）
 *
 * 背景：CI 里的 typecheck 硬门禁不在「本地 build → scp 直发生产」链路上，
 *       导致类型错误可以绕过 CI 直接进生产（07-28 上锁后 8~9 月仍漏 15 个）。
 *       本钩子把类型检查前置到「推送前」，作为 CI 之外的双保险。
 *
 * 用法：npm run hook:pre-push
 * 临时跳过：git push --no-verify
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const gitDir = path.join(root, '.git')
if (!fs.existsSync(gitDir)) {
  console.error('✗ 当前目录不是 git 仓库：' + root)
  process.exit(1)
}

const hookPath = path.join(gitDir, 'hooks', 'pre-push')
const hook = `#!/bin/sh
# ── JSC 类型门禁（pre-push）· 由 scripts/install-git-hooks.mjs 生成 ──
# 目的：不让类型错误绕过 CI 直接发到生产；跳过用 git push --no-verify
echo "[pre-push] 类型检查 tsc --noEmit ..."
if command -v npx >/dev/null 2>&1; then
  npx tsc --noEmit
  status=$?
else
  node ./node_modules/typescript/bin/tsc --noEmit
  status=$?
fi
if [ "$status" -ne 0 ]; then
  echo ""
  echo "[pre-push] ✗ 类型检查未通过 —— 推送已阻断（修复后重试；临时跳过：git push --no-verify）"
  exit 1
fi
echo "[pre-push] ✓ 类型检查通过"
exit 0
`

fs.mkdirSync(path.dirname(hookPath), { recursive: true })
fs.writeFileSync(hookPath, hook, { mode: 0o755 })
try { fs.chmodSync(hookPath, 0o755) } catch { /* Windows 上 chmod 可能无效，Git 自带 sh 仍可执行 */ }
console.log('✓ 已安装 pre-push 钩子：' + hookPath)
