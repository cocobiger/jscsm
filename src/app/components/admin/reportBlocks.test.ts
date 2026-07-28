import { describe, it, expect } from 'vitest'
import {
  BLOCK_DEFS,
  BLOCK_DEF_MAP,
  WORKREPORT_VARS,
  newBlock,
  blocksToHtml,
  fillTemplateClient,
  WR_SAMPLE_DATA,
  shouldOpenBlockEditor,
} from './reportBlocks'

describe('reportBlocks 元数据', () => {
  it('BLOCK_DEFS 含 8 类区块', () => {
    expect(BLOCK_DEFS).toHaveLength(8)
    expect(Object.keys(BLOCK_DEF_MAP)).toHaveLength(8)
  })

  it('WORKREPORT_VARS 含 7 个标量变量', () => {
    expect(WORKREPORT_VARS).toHaveLength(7)
    const keys = WORKREPORT_VARS.map((v) => v.key)
    expect(keys).toContain('periodLabel')
    expect(keys).toContain('closedCount')
  })
})

describe('newBlock 工厂', () => {
  it('title 区块默认含周期变量', () => {
    const b = newBlock('title')
    expect(b.type).toBe('title')
    expect(b.visible).toBe(true)
    expect(b.text).toContain('{{periodLabel}}')
  })

  it('summaryCards 有默认标题', () => {
    const b = newBlock('summaryCards')
    expect(b.title).toBe('一、总体情况')
  })
})

describe('blocksToHtml 序列化', () => {
  it('隐藏区块被过滤', () => {
    const blocks = [newBlock('title'), { ...newBlock('footer'), visible: false }]
    const html = blocksToHtml(blocks)
    // 渲染体里应含可见区块，且不含被隐藏区块的 DOM 节点；
    // 注意 <style> 会始终输出全部 class 定义，故需按渲染节点 class="wr-*" 断言，而非裸字符串。
    expect(html).toContain('class="wr-title"')
    expect(html).not.toContain('class="wr-footer"')
  })

  it('输出完整 HTML 骨架含 style', () => {
    const html = blocksToHtml([newBlock('title')])
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<style>')
  })
})

describe('fillTemplateClient 变量替换', () => {
  it('标量变量被替换', () => {
    const html = '<p>{{unitName}}</p>'
    expect(fillTemplateClient(html, { unitName: '万州区生态环保局' })).toBe(
      '<p>万州区生态环保局</p>',
    )
  })

  it('未定义变量替换为空串', () => {
    expect(fillTemplateClient('<p>{{missing}}</p>', {})).toBe('<p></p>')
  })

  it('{__html} 不转义', () => {
    const html = '<div>{{byTypeTable}}</div>'
    const data = { byTypeTable: { __html: '<table></table>' } }
    expect(fillTemplateClient(html, data)).toBe('<div><table></table></div>')
  })

  it('与样例数据渲染出表格', () => {
    const html = blocksToHtml([newBlock('byTypeTable')])
    const out = fillTemplateClient(html, WR_SAMPLE_DATA)
    expect(out).toContain('事件类型')
  })
})

describe('shouldOpenBlockEditor 模板编辑分支（closure 防回归）', () => {
  it('closure 预设（无 blocks_json）走文本域，不触发 BlockEditor（防回归）', () => {
    expect(shouldOpenBlockEditor('closure', null)).toBe(false)
    expect(shouldOpenBlockEditor('closure', '')).toBe(false)
    expect(shouldOpenBlockEditor('closure', '[]')).toBe(false)
  })

  it('workreport 带非空 blocks_json 才进区块编辑器', () => {
    expect(shouldOpenBlockEditor('workreport', '[{"type":"title","text":"x","visible":true}]')).toBe(true)
    expect(shouldOpenBlockEditor('workreport', null)).toBe(false)
    expect(shouldOpenBlockEditor('workreport', '')).toBe(false)
    expect(shouldOpenBlockEditor('workreport', '   ')).toBe(false)
  })

  it('未知/缺省 kind 一律文本域', () => {
    expect(shouldOpenBlockEditor(undefined, '[]')).toBe(false)
    expect(shouldOpenBlockEditor('', '[]')).toBe(false)
    expect(shouldOpenBlockEditor('other', '[]')).toBe(false)
  })
})
