import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { FONT_STACKS, renderPageToCanvas } from '../lib/render'
import { displaySize, layerTransform, toBaseSpace } from '../lib/geometry'
import type { Annotation, PageItem, ShapeAnn, Stamps, StoredImage, TextAnn } from '../lib/types'
import { uid } from '../lib/uid'
import { readFormFields, type FormField } from '../lib/forms'
import { readTextLines, sampleColours, type TextLine } from '../lib/textruns'
import { pageNumberText } from '../lib/stamps'

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = (typeof HANDLES)[number]

const MIN_SIZE = 4

function boxOf(a: Annotation) {
  // Lines keep a signed vector so their direction survives; everything else is
  // already stored as a positive-extent box.
  if (a.kind === 'line') {
    return {
      left: a.x + Math.min(0, a.w),
      top: a.y + Math.min(0, a.h),
      width: Math.abs(a.w),
      height: Math.abs(a.h),
    }
  }
  return { left: a.x, top: a.y, width: a.w, height: a.h }
}

function AnnotationContent({ a, images }: { a: Annotation; images: Map<string, StoredImage> }) {
  switch (a.kind) {
    case 'text': {
      const t = a as TextAnn
      return (
        <div
          className="ann-text"
          style={{
            fontFamily: FONT_STACKS[t.font],
            fontSize: t.fontSize,
            lineHeight: t.lineHeight,
            color: t.color,
            textAlign: t.align,
            fontWeight: t.bold ? 700 : 400,
            fontStyle: t.italic ? 'italic' : 'normal',
          }}
        >
          {t.text || ' '}
        </div>
      )
    }
    case 'rect': {
      const s = a as ShapeAnn
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            border: s.strokeWidth > 0 ? `${s.strokeWidth}px solid ${s.stroke}` : 'none',
            background: s.fill ?? 'transparent',
            opacity: s.opacity,
          }}
        />
      )
    }
    case 'ellipse': {
      const s = a as ShapeAnn
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            boxSizing: 'border-box',
            borderRadius: '50%',
            border: s.strokeWidth > 0 ? `${s.strokeWidth}px solid ${s.stroke}` : 'none',
            background: s.fill ?? 'transparent',
            opacity: s.opacity,
          }}
        />
      )
    }
    case 'line': {
      const s = a as ShapeAnn
      const w = Math.abs(s.w) || 1
      const h = Math.abs(s.h) || 1
      const x1 = s.w < 0 ? w : 0
      const y1 = s.h < 0 ? h : 0
      return (
        <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          <line
            x1={x1}
            y1={y1}
            x2={w - x1}
            y2={h - y1}
            stroke={s.stroke}
            strokeWidth={s.strokeWidth}
            strokeLinecap="round"
            opacity={s.opacity}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )
    }
    case 'highlight':
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            background: a.color,
            opacity: a.opacity,
            mixBlendMode: 'multiply',
          }}
        />
      )
    case 'ink': {
      const w = Math.max(a.w, 1)
      const h = Math.max(a.h, 1)
      return (
        <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {a.strokes.map((stroke, i) => (
            <polyline
              key={i}
              points={stroke.map(([px, py]) => `${px * w},${py * h}`).join(' ')}
              fill="none"
              stroke={a.stroke}
              strokeWidth={a.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )
    }
    case 'image': {
      const img = images.get(a.imageId)
      return img ? (
        <img
          src={img.url}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', opacity: a.opacity, display: 'block' }}
        />
      ) : null
    }
  }
}

export function PageView() {
  const pages = useStore((s) => s.pages)
  const currentPageId = useStore((s) => s.currentPageId)
  const zoom = useStore((s) => s.zoom)
  const tool = useStore((s) => s.tool)
  const defaults = useStore((s) => s.defaults)
  const images = useStore((s) => s.images)
  const annotations = useStore((s) => s.annotations)
  const selectedAnnId = useStore((s) => s.selectedAnnId)
  const selectAnnotation = useStore((s) => s.selectAnnotation)
  const addAnnotation = useStore((s) => s.addAnnotation)
  const updateAnnotation = useStore((s) => s.updateAnnotation)
  const setTool = useStore((s) => s.setTool)
  const addAnnotations = useStore((s) => s.addAnnotations)
  const stamps = useStore((s) => s.stamps)
  const formValues = useStore((s) => s.formValues)
  const setFormValue = useStore((s) => s.setFormValue)

  const page = useMemo(
    () => pages.find((p) => p.id === currentPageId) ?? null,
    [pages, currentPageId],
  )
  const proxy = useStore((s) => (page ? (s.sources.get(page.srcId)?.proxy ?? null) : null))

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [draft, setDraftState] = useState<Annotation | null>(null)
  /**
   * Latest draft, updated synchronously. Pointer events can arrive faster than
   * React re-renders, so on pointerup the `draft` captured by the last render
   * may be missing the final moves (shapes came out short of where the pointer
   * was released). Reading the ref instead always sees every move.
   */
  const draftRef = useRef<Annotation | null>(null)
  const setDraft = useCallback((next: Annotation | null) => {
    draftRef.current = next
    setDraftState(next)
  }, [])
  const [editingId, setEditingId] = useState<string | null>(null)
  /** anchor corner of the box being dragged out, kept out of state for stability */
  const anchorRef = useRef<{ x: number; y: number } | null>(null)

  /** Fillable fields on this page (empty for most PDFs). */
  const [fields, setFields] = useState<FormField[]>([])
  const [fieldsFor, setFieldsFor] = useState<string | null>(null)
  useEffect(() => {
    if (!proxy || !page) return
    let alive = true
    const key = `${page.srcId}:${page.srcIndex}`
    readFormFields(proxy, page.srcId, page.srcIndex).then((f) => {
      if (!alive) return
      setFields(f)
      setFieldsFor(key)
    })
    return () => {
      alive = false
    }
  }, [proxy, page?.srcId, page?.srcIndex])
  const fieldsReady = !!page && fieldsFor === `${page.srcId}:${page.srcIndex}`
  const hasFields = fieldsReady && fields.length > 0

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !proxy || !page || !fieldsReady) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const handle = renderPageToCanvas(proxy, page.srcIndex, canvas, {
      scale: zoom * dpr,
      // Fields get live inputs on top; drawing their old appearance underneath
      // as well would show the previous answer through the new one.
      hideFormFields: hasFields,
    })
    return () => handle.cancel()
  }, [proxy, page?.srcIndex, page?.id, zoom, fieldsReady, hasFields])

  /** Existing text lines, loaded only while the Edit text tool is active. */
  const [lines, setLines] = useState<TextLine[]>([])
  useEffect(() => {
    if (tool !== 'edittext' || !proxy || !page) {
      setLines([])
      return
    }
    let alive = true
    readTextLines(proxy, page.srcId, page.srcIndex).then((l) => alive && setLines(l))
    return () => {
      alive = false
    }
  }, [tool, proxy, page?.srcId, page?.srcIndex])

  useEffect(() => setEditingId(null), [currentPageId])

  const toBase = useCallback(
    (clientX: number, clientY: number) => {
      const rect = surfaceRef.current?.getBoundingClientRect()
      if (!rect || !page) return { x: 0, y: 0 }
      return toBaseSpace(
        page.rotate,
        page.baseWidth,
        page.baseHeight,
        (clientX - rect.left) / zoom,
        (clientY - rect.top) / zoom,
      )
    },
    [page, zoom],
  )

  if (!page) return null

  const display = displaySize(page)
  const list = annotations[page.id] ?? []
  const drawing =
    tool !== 'select' && tool !== 'image' && tool !== 'edittext' && tool !== 'signature'
  const pageIndex = pages.findIndex((p) => p.id === page.id)

  /** Turns a line of existing text into a cover patch plus an editable text box on top. */
  function editLine(line: TextLine) {
    if (!page) return
    const fs = line.fontSize
    const coverBox = { x: line.x - 1.5, y: line.baseline - fs * 0.95, w: line.w + 3, h: fs * 1.25 }
    const { background, ink } = canvasRef.current
      ? sampleColours(canvasRef.current, page.baseWidth, coverBox)
      : { background: '#ffffff', ink: '#000000' }
    const cover: ShapeAnn = {
      id: uid(),
      pageId: page.id,
      kind: 'rect',
      ...coverBox,
      stroke: background,
      strokeWidth: 0,
      fill: background,
      opacity: 1,
      cover: true,
    }
    const text: TextAnn = {
      id: uid(),
      pageId: page.id,
      kind: 'text',
      x: line.x,
      // Puts the box's baseline (≈0.93em down a 1.15 line box) on the original baseline.
      y: line.baseline - fs * 0.93,
      // Extra width so a slightly wider substitute font doesn't wrap the line.
      w: Math.max(line.w * 1.25 + fs, 40),
      h: fs * 1.15,
      text: line.text,
      fontSize: Math.round(fs * 2) / 2,
      color: ink,
      font: line.font,
      bold: line.bold,
      italic: line.italic,
      align: 'left',
      lineHeight: 1.15,
    }
    addAnnotations([cover, text], text.id)
    setEditingId(text.id)
    setTool('select')
  }

  function startDraw(e: React.PointerEvent) {
    if (!drawing || !page) return
    e.preventDefault()
    ;(e.target as Element).setPointerCapture(e.pointerId)
    const start = toBase(e.clientX, e.clientY)
    anchorRef.current = start

    if (tool === 'text') {
      const w = Math.min(240, page.baseWidth - start.x - 8)
      const ann: TextAnn = {
        id: uid(),
        pageId: page.id,
        kind: 'text',
        x: start.x,
        y: start.y,
        w: Math.max(w, 60),
        h: defaults.fontSize * 1.35 * 2,
        text: '',
        fontSize: defaults.fontSize,
        color: defaults.color,
        font: defaults.font,
        bold: defaults.bold,
        italic: defaults.italic,
        align: defaults.align,
        lineHeight: 1.35,
      }
      addAnnotation(ann)
      setEditingId(ann.id)
      setTool('select')
      return
    }

    if (tool === 'ink') {
      setDraft({
        id: uid(),
        pageId: page.id,
        kind: 'ink',
        x: start.x,
        y: start.y,
        w: 0,
        h: 0,
        strokes: [[[start.x, start.y]]],
        stroke: defaults.color,
        strokeWidth: defaults.strokeWidth,
      })
      return
    }

    const common = { id: uid(), pageId: page.id, x: start.x, y: start.y, w: 0, h: 0 }
    if (tool === 'highlight') {
      setDraft({ ...common, kind: 'highlight', color: defaults.highlightColor, opacity: 0.45 })
    } else if (tool === 'whiteout') {
      setDraft({
        ...common,
        kind: 'rect',
        stroke: '#ffffff',
        strokeWidth: 0,
        fill: '#ffffff',
        opacity: 1,
        redact: true,
      })
    } else {
      setDraft({
        ...common,
        kind: tool as 'rect' | 'ellipse' | 'line',
        stroke: defaults.color,
        strokeWidth: defaults.strokeWidth,
        fill: tool === 'line' ? null : defaults.fill,
        opacity: defaults.opacity,
      })
    }
  }

  function extendDraft(d: Annotation, p: { x: number; y: number }): Annotation {
    if (d.kind === 'ink') {
      const strokes = [...d.strokes]
      const last = strokes[strokes.length - 1]
      const prev = last[last.length - 1]
      if (prev && prev[0] === p.x && prev[1] === p.y) return d
      // While drawing, ink points are absolute; they are normalised on commit.
      strokes[strokes.length - 1] = [...last, [p.x, p.y]]
      return { ...d, strokes }
    }
    const anchor = anchorRef.current
    if (!anchor) return d
    if (d.kind === 'line') return { ...d, w: p.x - anchor.x, h: p.y - anchor.y }
    return {
      ...d,
      x: Math.min(anchor.x, p.x),
      y: Math.min(anchor.y, p.y),
      w: Math.abs(p.x - anchor.x),
      h: Math.abs(p.y - anchor.y),
    }
  }

  function moveDraw(e: React.PointerEvent) {
    const d = draftRef.current
    if (!d) return
    setDraft(extendDraft(d, toBase(e.clientX, e.clientY)))
  }

  function endDraw(e: React.PointerEvent) {
    const current = draftRef.current
    if (!current) return
    // Include the release point itself, in case no move event reported it.
    const draft = extendDraft(current, toBase(e.clientX, e.clientY))
    setDraft(null)
    if (draft.kind === 'ink') {
      const pts = draft.strokes.flat()
      if (pts.length < 2) return
      const pad = draft.strokeWidth / 2 + 1
      const xs = pts.map((p) => p[0])
      const ys = pts.map((p) => p[1])
      const minX = Math.min(...xs) - pad
      const minY = Math.min(...ys) - pad
      const w = Math.max(Math.max(...xs) + pad - minX, 1)
      const h = Math.max(Math.max(...ys) + pad - minY, 1)
      addAnnotation({
        ...draft,
        x: minX,
        y: minY,
        w,
        h,
        strokes: draft.strokes.map((s) =>
          s.map(([px, py]) => [(px - minX) / w, (py - minY) / h] as [number, number]),
        ),
      })
      return
    }
    if (draft.kind === 'line') {
      if (Math.abs(draft.w) < MIN_SIZE && Math.abs(draft.h) < MIN_SIZE) return
      addAnnotation(draft)
      return
    }
    if (draft.w < MIN_SIZE || draft.h < MIN_SIZE) return
    addAnnotation(draft)
  }

  return (
    <div className="page-stage">
      <div
        className="page-display"
        style={{ width: display.w * zoom, height: display.h * zoom }}
        ref={surfaceRef}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          if (drawing) startDraw(e)
          else if (e.target === e.currentTarget || (e.target as HTMLElement).tagName === 'CANVAS') {
            selectAnnotation(null)
            setEditingId(null)
          }
        }}
        onPointerMove={moveDraw}
        onPointerUp={endDraw}
        onPointerCancel={() => setDraft(null)}
        data-tool={tool}
      >
        <div
          className="page-base"
          style={{
            width: page.baseWidth,
            height: page.baseHeight,
            transform: `scale(${zoom}) ${layerTransform(page.rotate, page.baseWidth, page.baseHeight)}`,
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: page.baseWidth, height: page.baseHeight, display: 'block' }}
          />
          {hasFields && (
            <div className={`form-layer${tool === 'select' ? ' live' : ''}`}>
              {fields.map((f, i) => (
                <FormInput
                  key={`${f.name}-${i}`}
                  field={f}
                  value={formValues[page.srcId]?.[f.name]}
                  onChange={(v) => setFormValue(page.srcId, f.name, v)}
                />
              ))}
            </div>
          )}
          <div className="ann-layer">
            {list.map((a) => (
              <AnnotationBox
                key={a.id}
                a={a}
                page={page}
                images={images}
                interactive={tool === 'select'}
                selected={a.id === selectedAnnId}
                editing={a.id === editingId}
                onSelect={() => selectAnnotation(a.id)}
                onEdit={() => setEditingId(a.id)}
                onStopEdit={() => setEditingId(null)}
                onChange={(patch, coalesce) => updateAnnotation(a.id, patch, coalesce)}
                toBase={toBase}
              />
            ))}
            {tool === 'edittext' &&
              lines.map((l, i) => (
                <button
                  key={i}
                  type="button"
                  className="text-run"
                  title="Click to edit this line"
                  style={{
                    left: l.x - 2,
                    top: l.baseline - l.fontSize * 0.95,
                    width: l.w + 4,
                    height: l.fontSize * 1.25,
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => editLine(l)}
                />
              ))}
            {draft && (
              <div
                className="ann"
                style={{
                  left: boxOf(draft).left,
                  top: boxOf(draft).top,
                  width: Math.max(boxOf(draft).width, 1),
                  height: Math.max(boxOf(draft).height, 1),
                  pointerEvents: 'none',
                }}
              >
                <AnnotationContent
                  a={
                    draft.kind === 'ink'
                      ? {
                          ...draft,
                          w: Math.max(boxOf(draft).width, 1),
                          h: Math.max(boxOf(draft).height, 1),
                          strokes: draft.strokes.map((s) =>
                            s.map(
                              ([px, py]) =>
                                [
                                  (px - boxOf(draft).left) / Math.max(boxOf(draft).width, 1),
                                  (py - boxOf(draft).top) / Math.max(boxOf(draft).height, 1),
                                ] as [number, number],
                            ),
                          ),
                        }
                      : draft
                  }
                  images={images}
                />
              </div>
            )}
          </div>
        </div>
        <StampPreview stamps={stamps} index={pageIndex} total={pages.length} zoom={zoom} />
      </div>
    </div>
  )
}

/** Live preview of page numbers and the watermark, in displayed page space. */
function StampPreview({
  stamps,
  index,
  total,
  zoom,
}: {
  stamps: Stamps
  index: number
  total: number
  zoom: number
}) {
  const wm = stamps.watermark
  const pn = stamps.pageNumbers
  const label = pn ? pageNumberText(pn, index, total) : null
  if (!(wm && wm.text.trim()) && !label) return null
  const [v, h] = (pn?.position ?? 'bottom-center').split('-')
  return (
    <div className="stamp-layer">
      {wm && wm.text.trim() && (
        <div
          className="stamp-watermark"
          style={{
            fontSize: wm.fontSize * zoom,
            color: wm.color,
            opacity: wm.opacity,
            transform: `translate(-50%, -50%) rotate(${-wm.angle}deg)`,
          }}
        >
          {wm.text}
        </div>
      )}
      {pn && label && (
        <div
          className="stamp-number"
          style={{
            fontSize: pn.fontSize * zoom,
            color: pn.color,
            [v === 'top' ? 'top' : 'bottom']: pn.margin * zoom,
            ...(h === 'left'
              ? { left: pn.margin * zoom }
              : h === 'right'
                ? { right: pn.margin * zoom }
                : { left: '50%', transform: 'translateX(-50%)' }),
          }}
        >
          {label}
        </div>
      )}
    </div>
  )
}

function FormInput({
  field: f,
  value,
  onChange,
}: {
  field: FormField
  value: string | boolean | undefined
  onChange: (v: string | boolean) => void
}) {
  const box = { left: f.x, top: f.y, width: f.w, height: f.h }
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  if (f.kind === 'checkbox' || f.kind === 'radio') {
    const checked =
      f.kind === 'checkbox'
        ? Boolean(value ?? f.initial)
        : (value ?? f.initial) === f.exportValue
    return (
      <label className={`form-field form-check ${f.kind}${checked ? ' on' : ''}`} style={box} title={f.name}>
        <input
          type={f.kind}
          checked={checked}
          disabled={f.readOnly}
          name={f.kind === 'radio' ? f.name : undefined}
          onPointerDown={stop}
          onChange={(e) =>
            f.kind === 'checkbox' ? onChange(e.target.checked) : e.target.checked && onChange(f.exportValue)
          }
        />
        <span aria-hidden="true">{f.kind === 'checkbox' ? '✓' : '●'}</span>
      </label>
    )
  }
  const current = String(value ?? f.initial ?? '')
  const fontSize = f.multiline ? Math.min(12, Math.max(7, f.h / 4)) : Math.max(6, Math.min(14, f.h * 0.62))
  if (f.kind === 'select') {
    return (
      <select
        className="form-field"
        style={{ ...box, fontSize }}
        value={current}
        disabled={f.readOnly}
        title={f.name}
        onPointerDown={stop}
        onChange={(e) => onChange(e.target.value)}
      >
        {!f.options.some((o) => o.value === current) && <option value={current}>{current}</option>}
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  return f.multiline ? (
    <textarea
      className="form-field"
      style={{ ...box, fontSize }}
      value={current}
      readOnly={f.readOnly}
      maxLength={f.maxLen ?? undefined}
      title={f.name}
      onPointerDown={stop}
      onChange={(e) => onChange(e.target.value)}
    />
  ) : (
    <input
      className="form-field"
      style={{ ...box, fontSize }}
      value={current}
      readOnly={f.readOnly}
      maxLength={f.maxLen ?? undefined}
      title={f.name}
      onPointerDown={stop}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

interface BoxProps {
  a: Annotation
  page: PageItem
  images: Map<string, StoredImage>
  interactive: boolean
  selected: boolean
  editing: boolean
  onSelect: () => void
  onEdit: () => void
  onStopEdit: () => void
  onChange: (patch: Partial<Annotation>, coalesce?: boolean) => void
  toBase: (clientX: number, clientY: number) => { x: number; y: number }
}

function AnnotationBox({
  a,
  images,
  interactive,
  selected,
  editing,
  onSelect,
  onEdit,
  onStopEdit,
  onChange,
  toBase,
}: BoxProps) {
  const box = boxOf(a)
  const gesture = useRef<{
    mode: 'move' | Handle | 'p1' | 'p2'
    origin: { x: number; y: number }
    start: Annotation
    moved: boolean
  } | null>(null)

  function begin(mode: 'move' | Handle | 'p1' | 'p2', e: React.PointerEvent) {
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    gesture.current = { mode, origin: toBase(e.clientX, e.clientY), start: a, moved: false }
    onSelect()
  }

  function drag(e: React.PointerEvent) {
    const g = gesture.current
    if (!g) return
    const p = toBase(e.clientX, e.clientY)
    const dx = p.x - g.origin.x
    const dy = p.y - g.origin.y
    if (!g.moved && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    const first = !g.moved
    g.moved = true
    const s = g.start

    if (g.mode === 'move') {
      onChange({ x: s.x + dx, y: s.y + dy }, !first)
      return
    }
    if (g.mode === 'p1') {
      onChange({ x: s.x + dx, y: s.y + dy, w: s.w - dx, h: s.h - dy }, !first)
      return
    }
    if (g.mode === 'p2') {
      onChange({ w: s.w + dx, h: s.h + dy }, !first)
      return
    }

    let { x, y, w, h } = s
    if (g.mode.includes('w')) {
      x = s.x + dx
      w = s.w - dx
    }
    if (g.mode.includes('e')) w = s.w + dx
    if (g.mode.includes('n')) {
      y = s.y + dy
      h = s.h - dy
    }
    if (g.mode.includes('s')) h = s.h + dy
    if (w < MIN_SIZE) {
      w = MIN_SIZE
      x = g.mode.includes('w') ? s.x + s.w - MIN_SIZE : s.x
    }
    if (h < MIN_SIZE) {
      h = MIN_SIZE
      y = g.mode.includes('n') ? s.y + s.h - MIN_SIZE : s.y
    }
    onChange({ x, y, w, h }, !first)
  }

  const isLine = a.kind === 'line'

  return (
    <div
      className={`ann${selected ? ' selected' : ''}${interactive ? ' interactive' : ''}`}
      style={{
        left: box.left,
        top: box.top,
        width: Math.max(box.width, 1),
        height: Math.max(box.height, 1),
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: editing ? 'text' : 'move',
      }}
      onPointerDown={(e) => (editing ? undefined : begin('move', e))}
      onPointerMove={drag}
      onPointerUp={() => (gesture.current = null)}
      onDoubleClick={(e) => {
        if (a.kind === 'text') {
          e.stopPropagation()
          onEdit()
        }
      }}
    >
      {editing && a.kind === 'text' ? (
        <textarea
          className="ann-text-input"
          autoFocus
          value={a.text}
          style={{
            fontFamily: FONT_STACKS[a.font],
            fontSize: a.fontSize,
            lineHeight: a.lineHeight,
            color: a.color,
            textAlign: a.align,
            fontWeight: a.bold ? 700 : 400,
            fontStyle: a.italic ? 'italic' : 'normal',
          }}
          onChange={(e) => onChange({ text: e.target.value }, true)}
          onBlur={onStopEdit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') onStopEdit()
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <AnnotationContent a={a} images={images} />
      )}

      {selected && interactive && !editing && (
        <>
          {isLine ? (
            <>
              <div
                className="handle round"
                style={{ left: a.w < 0 ? box.width : 0, top: a.h < 0 ? box.height : 0 }}
                onPointerDown={(e) => begin('p1', e)}
                onPointerMove={drag}
                onPointerUp={() => (gesture.current = null)}
              />
              <div
                className="handle round"
                style={{ left: a.w < 0 ? 0 : box.width, top: a.h < 0 ? 0 : box.height }}
                onPointerDown={(e) => begin('p2', e)}
                onPointerMove={drag}
                onPointerUp={() => (gesture.current = null)}
              />
            </>
          ) : (
            HANDLES.map((h) => (
              <div
                key={h}
                className={`handle h-${h}`}
                onPointerDown={(e) => begin(h, e)}
                onPointerMove={drag}
                onPointerUp={() => (gesture.current = null)}
              />
            ))
          )}
        </>
      )}
    </div>
  )
}
