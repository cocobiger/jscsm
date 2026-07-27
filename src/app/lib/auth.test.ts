import { describe, it, expect } from 'vitest'
import { roleAtLeast, ROLE_LABELS, type Role } from './auth'

// roleAtLeast(actual, required)：actual 角色等级 >= required 等级才放行。
// 等级映射：viewer=1, operator=2, admin=3（来自 auth.ts 的 ROLE_LEVEL）。
describe('roleAtLeast', () => {
  it('admin 满足所有角色要求', () => {
    expect(roleAtLeast('admin', 'viewer')).toBe(true)
    expect(roleAtLeast('admin', 'operator')).toBe(true)
    expect(roleAtLeast('admin', 'admin')).toBe(true)
  })

  it('operator 满足 operator/viewer，但不满足 admin', () => {
    expect(roleAtLeast('operator', 'operator')).toBe(true)
    expect(roleAtLeast('operator', 'viewer')).toBe(true)
    expect(roleAtLeast('operator', 'admin')).toBe(false)
  })

  it('viewer 仅满足 viewer', () => {
    expect(roleAtLeast('viewer', 'viewer')).toBe(true)
    expect(roleAtLeast('viewer', 'operator')).toBe(false)
    expect(roleAtLeast('viewer', 'admin')).toBe(false)
  })

  it('actual 为 undefined 一律拒绝（未登录态）', () => {
    expect(roleAtLeast(undefined, 'viewer')).toBe(false)
    expect(roleAtLeast(undefined, 'admin')).toBe(false)
  })

  it('等价角色放行（边界 >= 而非 >）', () => {
    const roles: Role[] = ['viewer', 'operator', 'admin']
    for (const r of roles) {
      expect(roleAtLeast(r, r)).toBe(true)
    }
  })
})

describe('ROLE_LABELS 元数据', () => {
  it('提供三角色中文标签', () => {
    expect(ROLE_LABELS.admin).toBe('管理员')
    expect(ROLE_LABELS.operator).toBe('值守员')
    expect(ROLE_LABELS.viewer).toBe('访客')
  })
})
