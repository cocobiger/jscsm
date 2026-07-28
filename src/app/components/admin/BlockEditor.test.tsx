import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import BlockEditor from './BlockEditor'
import { newBlock, blocksToHtml, fillTemplateClient, WR_SAMPLE_DATA } from './reportBlocks'

const noop = () => {}
const initialOf = (blocks: any[]) => ({ name: '测试模板', description: '', blocks })

// 与 reportBlocks.ts BLOCK_DEFS 一致的 8 类标签（防止回归：面板必须渲染全部 8 类入口）
const ALL_LABELS = ['标题', '单位名称', '汇总卡片', '按类型表', '按状态表', '趋势块', '明细台账', '落款']

// happy-dom 在加载 srcdoc 时会多产出一个 iframe 副本，需选取 srcdoc 含文本的那个
function previewIframe(): any {
  const iframes = Array.from(document.querySelectorAll('iframe')) as any[]
  return iframes.find(f => (f.srcdoc || f.getAttribute('srcdoc') || '').includes('集成测试样例文本XYZ'))
}

describe('BlockEditor 组件', () => {
  it('渲染标题与 8 类区块按钮（防区块类型回归）', () => {
    render(<BlockEditor initial={initialOf([])} onClose={noop} onSaved={noop} />)
    expect(screen.getByText('新建工作报表模板')).toBeTruthy()
    const allBtnText = screen.getAllByRole('button').map(b => (b.textContent || '')).join(' ')
    ALL_LABELS.forEach(label => expect(allBtnText).toContain(label))
  })

  it('区块经 blocksToHtml+样例填充后含文本（渲染管线对接）', () => {
    const block = { ...newBlock('title'), text: '集成测试样例文本XYZ' }
    const html = fillTemplateClient(blocksToHtml([block]), WR_SAMPLE_DATA)
    expect(html).toContain('集成测试样例文本XYZ')
  })

  it('实时预览 iframe 的 srcdoc 含区块文本（组件接线）', () => {
    const block = { ...newBlock('title'), text: '集成测试样例文本XYZ' }
    const { container } = render(<BlockEditor initial={initialOf([block])} onClose={noop} onSaved={noop} />)

    // 计数「显示 1 / 共 1」（React 将数字拆为独立文本节点，用整体 textContent 断言更稳）
    expect(container.textContent || '').toContain('显示 1 / 共 1')

    // 实时预览 iframe 的 srcdoc 经 blocksToHtml + 样例数据填充，包含区块文本
    const iframe = previewIframe()
    expect(iframe).toBeTruthy()
    expect((iframe.srcdoc || iframe.getAttribute('srcdoc') || '')).toContain('集成测试样例文本XYZ')
  })

  it('点击面板「添加区块」按钮追加 1 个区块 → 计数更新为「显示 2 / 共 2」', () => {
    const block = { ...newBlock('title'), text: '集成测试样例文本XYZ' }
    const { container } = render(<BlockEditor initial={initialOf([block])} onClose={noop} onSaved={noop} />)
    expect(container.textContent || '').toContain('显示 1 / 共 1')

    // 仅「添加区块」面板里的 8 个按钮带 title={d.desc}（BlockRow 删除按钮/顶栏按钮/iframe 内联内容均无此属性），
    // 借此精确隔离出面板按钮，避开 happy-dom 内联 iframe 副本带来的多匹配。
    const paletteButtons = Array.from(container.querySelectorAll('button'))
      .filter(b => b.getAttribute('title'))
    expect(paletteButtons.length).toBe(8)

    const titleBtn = paletteButtons.find(b => (b.textContent || '').includes('标题'))
    expect(titleBtn).toBeTruthy()

    fireEvent.click(titleBtn!)
    expect(container.textContent || '').toContain('显示 2 / 共 2')
  })
})
