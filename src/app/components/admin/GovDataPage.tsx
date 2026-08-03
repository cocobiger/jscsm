import { useState, useEffect, useCallback, useRef } from 'react'
import * as XLSX from 'xlsx'
import { apiFetch } from '../../lib/apiFetch'
import { GOV_MODULE_DEFS, GOV_DEF_MAP, validateRows, type GovModuleKey } from '../../lib/govModules'

const CYAN = '#00aaff'
const GREEN = '#00e676'
const AMBER = '#ffd740'
const RED = '#ff4444'

/** payload 中数据数组的键名 */
const ARRAY_KEY: Record<GovModuleKey, string> = {
  forecast: 'days',
  pyramid: 'levels',
  documents: 'docs',
  assessment: 'metrics',
}

interface ModuleStatus {
  updated_at: string | null
  updated_by: string | null
  payload: Record<string, unknown> | null
}

type ParseState =
  | { ok: true; payload: Record<string, unknown>; warnings: string[]; rawCount: number }
  | { ok: false; errors: string[]; rawCount: number }

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '6px 10px', color: '#5a8aaa', fontSize: 12, fontWeight: 600,
  borderBottom: '1px solid rgba(0,150,220,0.2)', whiteSpace: 'nowrap',
}
const tdStyle: React.CSSProperties = {
  padding: '5px 10px', color: '#c8e6ff', fontSize: 12,
  borderBottom: '1px solid rgba(0,80,150,0.12)', whiteSpace: 'nowrap',
}

export function GovDataPage() {
  const [mod, setMod] = useState<GovModuleKey>('forecast')
  const [status, setStatus] = useState<ModuleStatus | null>(null)
  const [parsed, setParsed] = useState<ParseState | null>(null)
  const [importing, setImporting] = useState(false)
  const [toast, setToast] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3200) }

  const loadStatus = useCallback((m: GovModuleKey) => {
    apiFetch<{ payload: Record<string, unknown> | null; updated_at: string | null; updated_by: string | null }>(`/api/gov/${m}`)
      .then(d => setStatus({ payload: d.payload, updated_at: d.updated_at, updated_by: d.updated_by }))
      .catch(() => setStatus(null))
  }, [])

  useEffect(() => { setParsed(null); loadStatus(mod) }, [mod, loadStatus])

  const def = GOV_DEF_MAP[mod]

  /** 下载 Excel 模板（表头 + 示例行） */
  const downloadTemplate = () => {
    const headers = def.columns.map(c => c.header)
    const ws = XLSX.utils.json_to_sheet(def.sample, { header: headers })
    ws['!cols'] = def.columns.map(c => ({ wch: Math.max(10, c.header.length * 2 + 6) }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, def.label)
    XLSX.writeFile(wb, `${def.label}-导入模板.xlsx`)
  }

  /** 上传文件 → 解析 → 校验 */
  const onFile = async (f: File) => {
    try {
      const buf = await f.arrayBuffer()
      const wb = XLSX.read(buf)
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws) { setParsed({ ok: false, errors: ['文件中没有工作表'], rawCount: 0 }); return }
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
      const result = validateRows(mod, rows)
      setParsed(result.ok
        ? { ok: true, payload: result.payload, warnings: result.warnings, rawCount: rows.length }
        : { ok: false, errors: result.errors, rawCount: rows.length })
    } catch (e: any) {
      setParsed({ ok: false, errors: [`文件解析失败：${e?.message || e}`], rawCount: 0 })
    }
  }

  /** 确认导入 */
  const doImport = async () => {
    if (!parsed?.ok) return
    setImporting(true)
    try {
      await apiFetch(`/api/gov/${mod}`, { method: 'PUT', body: JSON.stringify({ payload: parsed.payload }) })
      flash(`「${def.label}」导入成功，驾驶舱已更新`)
      setParsed(null)
      if (fileRef.current) fileRef.current.value = ''
      loadStatus(mod)
    } catch (e: any) {
      flash('导入失败：' + (e.error || e))
    } finally {
      setImporting(false)
    }
  }

  /** 预览行：payload 中的数据数组 */
  const previewRows: Record<string, unknown>[] = (() => {
    if (parsed?.ok) return (parsed.payload[ARRAY_KEY[mod]] as Record<string, unknown>[]) || []
    if (!parsed && status?.payload) return (status.payload[ARRAY_KEY[mod]] as Record<string, unknown>[]) || []
    return []
  })()
  /** 预览列：校验后用 payload 字段名；当前数据预览同样 */
  const previewCols = def.columns.map(c => c.key)

  return (
    <div style={{ padding: 20, color: '#c8e6ff', height: '100%', overflowY: 'auto' }}>
      {/* 标题 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>政务数据导入</div>
        <div style={{ color: '#5a8aaa', fontSize: 12, marginTop: 3 }}>
          业务方用 Excel 维护政务数据，此处导入后驾驶舱「政务驾驶舱」面板即时展示。流程：下载模板 → 填写 → 上传校验 → 确认导入。
        </div>
      </div>

      {/* 模块选择卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {GOV_MODULE_DEFS.map(d => (
          <button
            key={d.key}
            onClick={() => setMod(d.key)}
            style={{
              textAlign: 'left', padding: '10px 12px', cursor: 'pointer',
              background: mod === d.key ? 'rgba(0,120,200,0.18)' : 'rgba(0,30,70,0.35)',
              border: `1px solid ${mod === d.key ? 'rgba(0,180,255,0.5)' : 'rgba(0,150,220,0.18)'}`,
              borderRadius: 5, transition: 'all 0.15s',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: mod === d.key ? '#00d4ff' : '#c8e6ff' }}>
              {d.icon} {d.label}
            </div>
            <div style={{ color: '#5a8aaa', fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>{d.desc}</div>
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 14, alignItems: 'start' }}>
        {/* 左：模板与上传 */}
        <div style={{ background: 'rgba(0,25,60,0.4)', border: '1px solid rgba(0,150,220,0.18)', borderRadius: 5, padding: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>① 模板与列说明</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 10 }}>
            <thead>
              <tr><th style={thStyle}>列名</th><th style={thStyle}>必填</th><th style={thStyle}>说明</th></tr>
            </thead>
            <tbody>
              {def.columns.map(c => (
                <tr key={c.key}>
                  <td style={tdStyle}>{c.header}</td>
                  <td style={{ ...tdStyle, color: c.required ? AMBER : '#3a5a70' }}>{c.required ? '是' : '否'}</td>
                  <td style={{ ...tdStyle, color: '#7ab8e0', whiteSpace: 'normal' }}>{c.desc || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={downloadTemplate}
            style={{
              width: '100%', padding: '8px 0', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: 'rgba(0,120,200,0.2)', border: '1px solid rgba(0,180,255,0.4)',
              borderRadius: 4, color: '#00d4ff',
            }}
          >
            ⬇ 下载「{def.label}」Excel 模板
          </button>

          <div style={{ fontSize: 13, fontWeight: 700, margin: '16px 0 8px' }}>② 上传填写好的表格</div>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f) }}
            style={{
              width: '100%', padding: '7px', fontSize: 12, color: '#7ab8e0',
              background: 'rgba(0,20,60,0.6)', border: '1px dashed rgba(0,150,220,0.35)', borderRadius: 4,
            }}
          />
          <div style={{ color: '#3a5a70', fontSize: 11, marginTop: 6 }}>
            支持 .xlsx / .xls / .csv；读取第一个工作表；上传后先校验再导入，不会直接覆盖。
          </div>

          {/* 校验结果 */}
          {parsed && !parsed.ok && (
            <div style={{ marginTop: 12, padding: 10, background: 'rgba(255,68,68,0.08)', border: '1px solid rgba(255,68,68,0.35)', borderRadius: 4 }}>
              <div style={{ color: RED, fontSize: 12, fontWeight: 700, marginBottom: 5 }}>校验未通过（{parsed.rawCount} 行）</div>
              {parsed.errors.slice(0, 8).map((e, i) => (
                <div key={i} style={{ color: '#ff9a9a', fontSize: 12, lineHeight: 1.7 }}>· {e}</div>
              ))}
              {parsed.errors.length > 8 && <div style={{ color: '#ff9a9a', fontSize: 12 }}>…共 {parsed.errors.length} 个问题</div>}
            </div>
          )}
          {parsed?.ok && (
            <div style={{ marginTop: 12, padding: 10, background: 'rgba(0,230,118,0.07)', border: '1px solid rgba(0,230,118,0.3)', borderRadius: 4 }}>
              <div style={{ color: GREEN, fontSize: 12, fontWeight: 700 }}>✓ 校验通过：{previewRows.length} 条数据（原表 {parsed.rawCount} 行）</div>
              {parsed.warnings.map((w, i) => (
                <div key={i} style={{ color: AMBER, fontSize: 12, marginTop: 4 }}>⚠ {w}</div>
              ))}
              <button
                onClick={doImport}
                disabled={importing}
                style={{
                  marginTop: 10, width: '100%', padding: '9px 0', cursor: importing ? 'wait' : 'pointer',
                  fontSize: 14, fontWeight: 700, borderRadius: 4,
                  background: importing ? 'rgba(0,100,80,0.3)' : 'linear-gradient(180deg, #00c853, #00a047)',
                  border: 'none', color: '#fff',
                }}
              >
                {importing ? '导入中…' : `③ 确认导入「${def.label}」`}
              </button>
            </div>
          )}
        </div>

        {/* 右：数据预览 */}
        <div style={{ background: 'rgba(0,25,60,0.4)', border: '1px solid rgba(0,150,220,0.18)', borderRadius: 5, padding: 14, minHeight: 300 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {parsed?.ok ? '待导入数据预览' : '当前已导入数据'}
            </div>
            {!parsed?.ok && status && (
              <div style={{ color: '#3a5a70', fontSize: 11 }}>
                {status.updated_at ? `更新于 ${status.updated_at}${status.updated_by ? ` · ${status.updated_by}` : ''}` : '尚未导入'}
              </div>
            )}
          </div>
          {previewRows.length === 0 ? (
            <div style={{ color: '#3a5a70', fontSize: 12, textAlign: 'center', padding: '60px 0' }}>
              {parsed?.ok ? '无数据' : '该模块暂无数据，请下载模板填写后上传导入'}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: 34 }}>#</th>
                    {def.columns.map(c => <th key={c.key} style={thStyle}>{c.header}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i}>
                      <td style={{ ...tdStyle, color: '#3a5a70' }}>{i + 1}</td>
                      {previewCols.map(k => (
                        <td key={k} style={tdStyle}>{row[k] == null ? '—' : String(row[k])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)', zIndex: 99,
          padding: '8px 20px', background: 'rgba(0,40,90,0.95)', border: `1px solid ${CYAN}`,
          borderRadius: 4, color: '#c8e6ff', fontSize: 13, boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
        }}>
          {toast}
        </div>
      )}
    </div>
  )
}
