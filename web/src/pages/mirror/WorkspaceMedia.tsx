import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileWarning, Save, ZoomIn, ZoomOut, Maximize, Crop as CropIcon, Square, Type, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ext, Fallback } from './WsShared'

/* XLSX: editable cells + sheet tabs → write back binary */
function XlsxView({ src, name, onSave }: { src: string; name: string; onSave: (buf: ArrayBuffer) => Promise<string | null> }) {
  const { t } = useTranslation()
  const [wb, setWb] = useState<{ book: import('xlsx').WorkBook; sheets: string[]; data: Record<string, unknown[][]> } | null>(null)
  const [sheet, setSheet] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const load = useCallback(async () => {
    try {
      const buf = await (await fetch(src)).arrayBuffer()
      const XLSX = await import('xlsx')
      const book = XLSX.read(buf, { type: 'array', cellFormula: false })
      const data: Record<string, unknown[][]> = {}
      for (const s of book.SheetNames) {
        data[s] = (XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[s], { header: 1, defval: '' }).slice(0, 2000) as unknown[][])
          .map((r) => (Array.isArray(r) ? r : [r]).map((c) => (c == null ? '' : c)))
      }
      setWb({ book, sheets: book.SheetNames, data })
    } catch (e) { setErr((e as Error).message) }
  }, [src])
  useEffect(() => { setWb(null); setErr(null); setDirty(false); void load() }, [load])
  const doSave = useCallback(() => {
    if (!wb || !dirty || saving) return
    setSaving(true)
    void (async () => {
      const XLSX = await import('xlsx')
      for (const s of wb.sheets) wb.book.Sheets[s] = XLSX.utils.aoa_to_sheet(wb.data[s])
      const out = XLSX.write(wb.book, { type: 'array', bookType: ext(name) === 'xls' ? 'biff8' : 'xlsx' }) as ArrayBuffer
      const e2 = await onSave(out)
      if (!e2) setDirty(false)
    })().finally(() => setSaving(false))
  }, [wb, dirty, saving, name, onSave])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave() } }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [doSave])
  if (err) return <Fallback path={name} src={src} msg={`Spreadsheet preview failed: ${err}`} />
  if (!wb) return <div className="p-3 text-[13px] text-muted-foreground">{t('ws.loadingSheet')}</div>
  const cur = wb.sheets[Math.min(sheet, wb.sheets.length - 1)]
  const rows = wb.data[cur] ?? []
  const setCell = (r: number, c: number, v: string) => {
    wb.data[cur][r] = [...(wb.data[cur][r] ?? [])]
    const num = v !== '' && !isNaN(Number(v)) ? Number(v) : v
    wb.data[cur][r][c] = num
    setWb({ ...wb })
    setDirty(true)
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-end gap-0.5 border-b border-border px-2 pt-1">
        {wb.sheets.map((s, i) => (
          <button key={s} onClick={() => setSheet(i)}
            className={cn('h-7 cursor-pointer rounded-t-[5px] border border-b-0 border-border px-2.5 text-[12px]', i === sheet ? 'bg-background font-medium text-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>{s}</button>
        ))}
        <div className="ml-auto flex h-full items-center gap-1.5 pb-1">
          {dirty && <span className="text-[11px] text-amber-600">{t('ws.unsaved')}</span>}
          <button onClick={doSave} disabled={!dirty || saving}
            className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-[12px]', dirty ? 'bg-accent-fill text-white' : 'text-muted-foreground opacity-50')}>
            <Save size={12} /> {saving ? t('ws.saving') : t('common.save')}
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[12px]">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={i === 0 ? 'sticky top-0 z-[1] bg-card font-medium' : 'hover:bg-tint-secondary/50'}>
                <td className="sticky left-0 border-b border-r border-border bg-card px-1.5 py-1 text-right text-[10px] text-muted-foreground">{i + 1}</td>
                {r.map((c, j) => (
                  <td key={j} className="whitespace-nowrap border-b border-r border-border px-2 py-1 align-top outline-none focus:bg-accent-fill/10"
                    contentEditable suppressContentEditableWarning
                    onBlur={(e) => setCell(i, j, e.currentTarget.textContent ?? '')}>{String(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* DOCX → mammoth HTML (read-only) */
function DocxView({ src, name }: { src: string; name: string }) {
  const { t } = useTranslation()
  const [html, setHtml] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let dead = false
    setHtml(null); setErr(null)
    void (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer()
        const { convertToHtml } = await import('mammoth')
        const r = await convertToHtml({ arrayBuffer: buf })
        if (!dead) setHtml(r.value)
      } catch (e) { if (!dead) setErr((e as Error).message) }
    })()
    return () => { dead = true }
  }, [src])
  if (err) return <Fallback path={name} src={src} msg={`DOCX preview failed: ${err}`} />
  if (html == null) return <div className="p-3 text-[13px] text-muted-foreground">{t('ws.loadingDoc')}</div>
  return (
    <div className="mx-auto max-w-[760px] p-6">
      <style>{`.docx-view h1,.docx-view h2,.docx-view h3{font-weight:600;margin:.8em 0 .4em}.docx-view h1{font-size:20px}.docx-view h2{font-size:17px}.docx-view h3{font-size:15px}.docx-view p{margin:.5em 0;font-size:13px;line-height:1.6}.docx-view table{border-collapse:collapse;margin:.6em 0}.docx-view td,.docx-view th{border:1px solid var(--color-border);padding:3px 8px;font-size:12px}.docx-view ul,.docx-view ol{padding-left:1.4em}.docx-view img{max-width:100%}`}</style>
      <div className="docx-view text-foreground" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

/* Image viewer/editor: zoom, pan, crop, red-rect annotate, text annotate, save */
function ImageEditor({ src, name, onSave }: { src: string; name: string; onSave: (blob: Blob) => Promise<string | null> }) {
  const { t } = useTranslation()
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [tool, setTool] = useState<'none' | 'crop' | 'rect' | 'text'>('none')
  const [rects, setRects] = useState<{ x: number; y: number; w: number; h: number }[]>([])
  const [texts, setTexts] = useState<{ x: number; y: number; t: string }[]>([])
  const [dragging, setDragging] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null)
  const [panning, setPanning] = useState<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const im = new Image()
    im.crossOrigin = 'same-origin'
    im.onload = () => setImg(im)
    im.onerror = () => setErr('image load failed')
    im.src = src + (nonce ? `${src.includes('?') ? '&' : '?'}r=${nonce}` : '')
    setRects([]); setTexts([]); setTool('none'); setZoom(1); setPan({ x: 0, y: 0 }); setErr(null)
  }, [src, nonce])
  const dirty = rects.length > 0 || texts.length > 0

  const toImg = (clientX: number, clientY: number) => {
    const wrap = wrapRef.current!.getBoundingClientRect()
    // image is centered + scaled by zoom, offset by pan
    const iw = img!.naturalWidth * zoom, ih = img!.naturalHeight * zoom
    const ox = wrap.left + (wrap.width - iw) / 2 + pan.x
    const oy = wrap.top + (wrap.height - ih) / 2 + pan.y
    return { x: (clientX - ox) / zoom, y: (clientY - oy) / zoom }
  }

  const applyCrop = () => {
    if (!dragging || !img) return
    const r = normRect(dragging)
    if (r.w < 8 || r.h < 8) return
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h))
    c.getContext('2d')!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
    const im = new Image()
    im.onload = () => { setImg(im); setDragging(null); setRects([]); setTexts([]); setTool('none'); setPan({ x: 0, y: 0 }) }
    im.src = c.toDataURL('image/png')
  }

  const doSave = async () => {
    if (!img || saving) return
    setSaving(true)
    try {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      g.strokeStyle = '#ef4444'; g.lineWidth = Math.max(2, img.naturalWidth / 400)
      for (const r of rects) g.strokeRect(r.x, r.y, r.w, r.h)
      g.fillStyle = '#ef4444'
      g.font = `${Math.max(14, img.naturalWidth / 45)}px sans-serif`
      for (const t of texts) g.fillText(t.t, t.x, t.y)
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, ext(name) === 'jpg' || ext(name) === 'jpeg' ? 'image/jpeg' : 'image/png'))
      if (blob) {
        const e2 = await onSave(blob)
        if (!e2) { setRects([]); setTexts([]) } else setErr(e2)
      }
    } finally { setSaving(false) }
  }

  const normRect = (d: { sx: number; sy: number; ex: number; ey: number }) => ({
    x: Math.min(d.sx, d.ex), y: Math.min(d.sy, d.ey), w: Math.abs(d.ex - d.sx), h: Math.abs(d.ey - d.sy),
  })

  const onDown = (e: React.MouseEvent) => {
    if (!img) return
    if (tool === 'crop' || tool === 'rect') { const p = toImg(e.clientX, e.clientY); setDragging({ sx: p.x, sy: p.y, ex: p.x, ey: p.y }) }
    else if (tool === 'text') {
      const p = toImg(e.clientX, e.clientY)
      const v = window.prompt(t('ws.annotText'), '')
      if (v) setTexts((t) => [...t, { x: p.x, y: p.y, t: v }])
    } else setPanning({ sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y })
  }
  const onMove = (e: React.MouseEvent) => {
    if (dragging) { const p = toImg(e.clientX, e.clientY); setDragging({ ...dragging, ex: p.x, ey: p.y }) }
    else if (panning) setPan({ x: panning.px + (e.clientX - panning.sx), y: panning.py + (e.clientY - panning.sy) })
  }
  const onUp = () => {
    if (dragging) {
      const r = normRect(dragging)
      if (tool === 'rect' && r.w > 4 && r.h > 4) setRects((x) => [...x, r])
      else if (tool === 'crop') applyCrop()
      setDragging(null)
    }
    setPanning(null)
  }

  if (err) return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
      <FileWarning size={24} className="text-red-500" />
      <div className="text-[13px] text-red-500">{err}</div>
      <button onClick={() => setNonce((n) => n + 1)} className="rounded-[6px] border border-border px-2.5 py-1 text-[12px] text-foreground hover:bg-tint-secondary">{t('common.retry')}</button>
    </div>
  )
  if (!img) return <div className="p-3 text-[13px] text-muted-foreground">{t('ws.loadingImg')}</div>
  const sel = dragging ? normRect(dragging) : null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <button title={t('ws.zoomOut')} className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" onClick={() => setZoom((z) => Math.max(0.05, z / 1.25))}><ZoomOut size={13} /></button>
        <span className="w-12 text-center text-[11px] text-muted-foreground">{Math.round(zoom * 100)}%</span>
        <button title={t('ws.zoomIn')} className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" onClick={() => setZoom((z) => Math.min(16, z * 1.25))}><ZoomIn size={13} /></button>
        <button title={t('ws.fit')} className="flex size-6 cursor-pointer items-center justify-center rounded-[4px] text-muted-foreground hover:bg-tint-secondary" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}><Maximize size={13} /></button>
        <span className="mx-1 h-4 w-px bg-border" />
        {([['crop', t('ws.crop'), CropIcon], ['rect', t('ws.rect'), Square], ['text', t('ws.text'), Type]] as const).map(([k, l, IconC]) => (
          <button key={k} title={l} onClick={() => setTool((t) => (t === k ? 'none' : k))}
            className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[4px] px-1.5 text-[12px]', tool === k ? 'bg-tint-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
            <IconC size={13} />{l}
          </button>
        ))}
        {dirty && <button title={t('ws.clearAnnot')} className="flex h-6 cursor-pointer items-center gap-1 rounded-[4px] px-1.5 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => { setRects([]); setTexts([]) }}><Undo2 size={13} />{t('ws.clearAnnotText')}</button>}
        <div className="ml-auto flex items-center gap-1.5">
          <a href={src} download className="h-6 cursor-pointer rounded-[5px] px-2 text-[12px] leading-6 text-muted-foreground hover:bg-tint-secondary hover:text-foreground">{t('common.download')}</a>
          <button onClick={() => void doSave()} disabled={saving}
            className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-[5px] px-2 text-[12px]', dirty ? 'bg-accent-fill text-white' : 'text-muted-foreground opacity-60')}>
            <Save size={12} /> {saving ? t('ws.saving') : t('common.save')}
          </button>
        </div>
      </div>
      <div
        ref={wrapRef}
        className={cn('relative min-h-0 flex-1 select-none overflow-hidden bg-[repeating-conic-gradient(#00000008_0_25%,transparent_0_50%)] bg-[size:20px_20px]', tool === 'none' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair')}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
        onWheel={(e) => setZoom((z) => Math.min(16, Math.max(0.05, z * (e.deltaY < 0 ? 1.1 : 0.9))))}
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={{ transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${zoom})`, transformOrigin: 'center' }}
        >
          <div className="relative" style={{ width: img.naturalWidth, height: img.naturalHeight }}>
            <img src={img.src} alt={name} draggable={false} className="block h-full w-full shadow-md" />
            {rects.map((r, i) => (
              <div key={i} className="pointer-events-none absolute border-2 border-red-500" style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
            ))}
            {texts.map((t, i) => (
              <div key={i} className="pointer-events-none absolute font-sans font-medium text-red-500" style={{ left: t.x, top: t.y, fontSize: Math.max(14, img.naturalWidth / 45) }}>{t.t}</div>
            ))}
            {sel && (tool === 'crop' || tool === 'rect') && (
              <div className={cn('pointer-events-none absolute border-2', tool === 'crop' ? 'border-accent-primary bg-accent-fill/10' : 'border-red-500')}
                style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export { XlsxView, DocxView, ImageEditor };
