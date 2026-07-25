// 智治推送 · 工作报表区块编辑器（非技术友好）
// 选区块 → 填表单（标题/文字/变量） → 拖拽排序 → 实时预览 → 保存 / 预览真实 PDF
import { useState, useEffect, useRef, useMemo } from 'react'
import { DndProvider, useDrag, useDrop } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import { apiFetch, authFetch } from '../../lib/apiFetch'
import {
  Block, BlockType, BLOCK_DEFS, BLOCK_DEF_MAP, WORKREPORT_VARS,
  newBlock, blocksToHtml, fillTemplateClient, WR_SAMPLE_DATA,
} from './reportBlocks'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const RED = '#ff4444'

const inputStyle: React.CSSProperties = {
  background: '#07182f', border: '1px solid rgba(0,150,220,0.3)', color: '#c8e6ff',
  borderRadius: 4, padding: '7px 10px', fontSize: 12, outline: 'none',
}
function btnStyle(color: string, ghost = false): React.CSSProperties {
  return {
    background: ghost ? 'transparent' : color, color: ghost ? color : '#04111f',
    border: `1px solid ${color}`, borderRadius: 4, padding: '6px 14px',
    fontSize: 12, cursor: 'pointer', fontWeight: 600,
  }
}

const ItemTypes = { BLOCK: 'block' }

interface BlockEditorProps {
  initial: { id?: string; name: string; description: string; blocks: Block[] }
  onClose: () => void
  onSaved: () => void
}

// ── 可拖拽区块行 ─────────────────────────────────────────────
function BlockRow({ block, index, moveBlock, updateBlock, removeBlock }: {
  block: Block; index: number; moveBlock: (from: number, to: number) => void
  updateBlock: (id: string, patch: Partial<Block>) => void
  removeBlock: (id: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLSpanElement>(null)
  const def = BLOCK_DEF_MAP[block.type]

  const [, drop] = useDrop<{ index: number }, unknown, unknown>({
    accept: ItemTypes.BLOCK,
    hover(item, monitor) {
      if (!ref.current) return
      const dragIndex = item.index
      const hoverIndex = index
      if (dragIndex === hoverIndex) return
      const rect = ref.current.getBoundingClientRect()
      const clientOffset = monitor.getClientOffset()
      if (!clientOffset) return
      const hoverClientY = clientOffset.y - rect.top
      const hoverMiddleY = (rect.bottom - rect.top) / 2
      if (dragIndex < hoverIndex && hoverClientY < hoverMiddleY) return
      if (dragIndex > hoverIndex && hoverClientY > hoverMiddleY) return
      moveBlock(dragIndex, hoverIndex)
      item.index = hoverIndex
    },
  })
  const [{ isDragging }, drag] = useDrag<{ id: string; index: number }, unknown, { isDragging: boolean }>({
    type: ItemTypes.BLOCK,
    item: { id: block.id, index },
    collect: m => ({ isDragging: m.isDragging() }),
  })
  drop(ref)
  drag(handleRef)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const insertVar = (key: string) => {
    const ta = taRef.current
    const token = `{{${key}}}`
    if (!ta) { updateBlock(block.id, { text: (block.text || '') + token }); return }
    const start = ta.selectionStart ?? (block.text || '').length
    const end = ta.selectionEnd ?? (block.text || '').length
    const cur = block.text || ''
    const next = cur.slice(0, start) + token + cur.slice(end)
    updateBlock(block.id, { text: next })
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + token.length
      ta.setSelectionRange(pos, pos)
    })
  }

  return (
    <div
      ref={ref}
      style={{
        background: '#07182f', border: '1px solid rgba(0,150,220,0.22)', borderRadius: 6,
        padding: 10, marginBottom: 8, opacity: isDragging ? 0.4 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span ref={handleRef} title="拖拽排序" style={{ cursor: 'grab', color: '#5a8aaa', fontSize: 16, userSelect: 'none' }}>⠿</span>
        <span style={{ color: CYAN, fontSize: 13 }}>{def.icon}</span>
        <span style={{ color: '#c8e6ff', fontSize: 12, fontWeight: 600 }}>{def.label}</span>
        <span style={{ color: '#3a5a70', fontSize: 10, marginLeft: 2 }}>{def.desc}</span>
        <span style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#5a8aaa', fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={block.visible} onChange={e => updateBlock(block.id, { visible: e.target.checked })} />显示
        </label>
        <button style={{ ...btnStyle(RED, true), padding: '3px 8px' }} onClick={() => removeBlock(block.id)}>删除</button>
      </div>

      {def.hasTitle && (
        <input
          style={{ ...inputStyle, width: '100%', marginBottom: 6 }}
          placeholder="区块标题（如：一、总体情况）"
          value={block.title}
          onChange={e => updateBlock(block.id, { title: e.target.value })}
        />
      )}

      {def.hasText && (
        <div>
          <textarea
            ref={taRef}
            style={{ ...inputStyle, width: '100%', minHeight: 56, fontFamily: "'JetBrains Mono',monospace", fontSize: 11, resize: 'vertical' }}
            placeholder="文字内容，可插入变量，如 {{periodLabel}}"
            value={block.text || ''}
            onChange={e => updateBlock(block.id, { text: e.target.value })}
          />
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#5a8aaa', fontSize: 11 }}>插入变量：</span>
            <select
              style={{ ...inputStyle, fontSize: 11, padding: '3px 8px' }}
              value=""
              onChange={e => { if (e.target.value) insertVar(e.target.value); e.target.value = '' }}
            >
              <option value="">选择…</option>
              {WORKREPORT_VARS.map(v => <option key={v.key} value={v.key}>{`{{${v.key}}} — ${v.label}`}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}

// ── 主编辑器 ───────────────────────────────────────────────
export default function BlockEditor({ initial, onClose, onSaved }: BlockEditorProps) {
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [blocks, setBlocks] = useState<Block[]>(initial.blocks)
  const [saving, setSaving] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfMsg, setPdfMsg] = useState('')

  // 实时预览：区块 → HTML → 样例数据填充（不调后端）
  const previewHtml = useMemo(() => fillTemplateClient(blocksToHtml(blocks), WR_SAMPLE_DATA), [blocks])

  const addBlock = (type: BlockType) => setBlocks(b => [...b, newBlock(type)])
  const updateBlock = (id: string, patch: Partial<Block>) =>
    setBlocks(b => b.map(x => (x.id === id ? { ...x, ...patch } : x)))
  const removeBlock = (id: string) => setBlocks(b => b.filter(x => x.id !== id))
  const moveBlock = (from: number, to: number) =>
    setBlocks(b => { const n = [...b]; const [m] = n.splice(from, 1); n.splice(to, 0, m); return n })

  const visibleCount = blocks.filter(b => b.visible).length

  const save = async () => {
    if (!name.trim()) { alert('请填写模板名称'); return }
    if (blocks.length === 0) { alert('请至少添加 1 个区块'); return }
    setSaving(true)
    try {
      const content = blocksToHtml(blocks)
      const payload = { name: name.trim(), description, kind: 'workreport', content, blocks_json: JSON.stringify(blocks) }
      if (initial.id) {
        await apiFetch(`/api/smart-push/report-templates/${initial.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      } else {
        await apiFetch('/api/smart-push/report-templates', { method: 'POST', body: JSON.stringify(payload) })
      }
      onSaved()
    } catch (e: any) { alert('保存失败: ' + (e?.error || e?.message || e)) }
    finally { setSaving(false) }
  }

  const previewPdf = async () => {
    const content = blocksToHtml(blocks)
    setPdfLoading(true); setPdfMsg('')
    try {
      const resp = await authFetch('/api/smart-push/work-report/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, params: { range: 'month' } }),
      })
      if (!resp.ok) { const j = await resp.json().catch(() => ({})); throw new Error(j.error || `HTTP ${resp.status}`) }
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e: any) { setPdfMsg('预览失败: ' + (e?.error || e?.message || e)) }
    finally { setPdfLoading(false) }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{ width: 1080, maxHeight: '92vh', display: 'flex', flexDirection: 'column', background: '#040e25', border: '1px solid rgba(0,150,220,0.3)', borderRadius: 6 }}>
        {/* 顶栏 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid rgba(0,100,180,0.2)' }}>
          <div style={{ color: '#c8e6ff', fontSize: 15, fontWeight: 600 }}>{initial.id ? '编辑工作报表模板' : '新建工作报表模板'}</div>
          <span style={{ color: '#5a8aaa', fontSize: 11 }}>（区块编排 · 双击变量可插入）</span>
          <span style={{ flex: 1 }} />
          <button style={{ ...btnStyle(CYAN, true), opacity: pdfLoading ? 0.6 : 1 }} onClick={previewPdf} disabled={pdfLoading}>{pdfLoading ? '生成中…' : '预览真实 PDF'}</button>
          <button style={{ ...btnStyle(GREEN, false), opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
          <button style={{ ...btnStyle('#5a8aaa', true) }} onClick={onClose}>取消</button>
        </div>

        {/* 名称/说明 */}
        <div style={{ display: 'flex', gap: 10, padding: '12px 18px', borderBottom: '1px solid rgba(0,100,180,0.15)' }}>
          <input style={{ ...inputStyle, flex: 1 }} placeholder="模板名称（如：周报表-网格巡查版）" value={name} onChange={e => setName(e.target.value)} />
          <input style={{ ...inputStyle, flex: 1 }} placeholder="说明（可选）" value={description} onChange={e => setDescription(e.target.value)} />
        </div>

        {/* 主体：左面板 + 右预览 */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* 左：区块面板 */}
          <div style={{ width: 440, overflow: 'auto', padding: 14, borderRight: '1px solid rgba(0,100,180,0.15)' }}>
            <div style={{ color: '#7ab8e0', fontSize: 12, marginBottom: 8 }}>① 添加区块</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {BLOCK_DEFS.map(d => (
                <button key={d.type} style={{ ...btnStyle('#1c3a5c', true), fontSize: 11, padding: '5px 9px' }} onClick={() => addBlock(d.type)} title={d.desc}>
                  {d.icon} {d.label}
                </button>
              ))}
            </div>
            <div style={{ color: '#7ab8e0', fontSize: 12, marginBottom: 8 }}>② 编排与排序（显示 {visibleCount} / 共 {blocks.length}）</div>
            <DndProvider backend={HTML5Backend}>
              {blocks.length === 0
                ? <div style={{ color: '#3a5a70', fontSize: 12, padding: 20, textAlign: 'center', border: '1px dashed rgba(0,100,180,0.25)', borderRadius: 6 }}>尚未添加区块，点击上方按钮开始</div>
                : blocks.map((b, i) => (
                    <BlockRow key={b.id} block={b} index={i} moveBlock={moveBlock} updateBlock={updateBlock} removeBlock={removeBlock} />
                  ))
              }
            </DndProvider>
          </div>

          {/* 右：实时预览 */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ color: '#7ab8e0', fontSize: 12, padding: '10px 16px 4px' }}>③ 实时预览（样例数据填充，点"预览真实 PDF"出实际数据）</div>
            {pdfMsg && <div style={{ color: RED, fontSize: 11, padding: '0 16px 4px' }}>{pdfMsg}</div>}
            <iframe
              title="preview"
              srcDoc={previewHtml}
              style={{ flex: 1, width: '100%', border: 'none', background: '#ffffff', margin: '4px 12px 12px', borderRadius: 4, minHeight: 380 }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
