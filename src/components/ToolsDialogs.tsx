import { useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../state/store'
import { parseRanges, rangeLabel } from '../lib/ranges'
import { pageNumberText } from '../lib/stamps'
import type { PageNumberSettings, StampPosition, WatermarkSettings } from '../lib/types'
import { Icon } from './Icon'

export type ToolDialog =
  | 'pageNumbers'
  | 'watermark'
  | 'split'
  | 'images'
  | 'protect'
  | 'toWord'
  | 'toExcel'
  | 'toPowerPoint'

/** Shared modal frame. */
function Modal({
  icon,
  title,
  onClose,
  children,
  footer,
  busy = false,
}: {
  icon: string
  title: string
  onClose: () => void
  children: ReactNode
  footer: ReactNode
  busy?: boolean
}) {
  return (
    <div className="modal-backdrop" onPointerDown={busy ? undefined : onClose}>
      <div className="modal" role="dialog" aria-label={title} onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Icon name={icon} size={18} /> {title}
          </h2>
          <button className="icon" onClick={onClose} disabled={busy} title="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  )
}

function baseName(filename: string) {
  return filename.replace(/(-edited)?\.pdf$/i, '') || 'document'
}

/** Builds the current document (or a subset of its pages) with every edit applied. */
async function buildCurrent(pageIds?: string[]) {
  const s = useStore.getState()
  const pages = pageIds ? s.pages.filter((p) => pageIds.includes(p.id)) : s.pages
  const { buildPdf } = await import('../lib/export')
  return buildPdf(pages, s.sources, s.annotations, s.images, {
    stamps: s.stamps,
    formValues: s.formValues,
  })
}

// ---------------------------------------------------------------- page numbers

const POSITIONS: Array<{ id: StampPosition; label: string }> = [
  { id: 'bottom-center', label: 'Bottom centre' },
  { id: 'bottom-right', label: 'Bottom right' },
  { id: 'bottom-left', label: 'Bottom left' },
  { id: 'top-center', label: 'Top centre' },
  { id: 'top-right', label: 'Top right' },
  { id: 'top-left', label: 'Top left' },
]

const FORMATS = ['{n}', 'Page {n}', '{n} of {total}', 'Page {n} of {total}', '– {n} –']

const DEFAULT_NUMBERS: PageNumberSettings = {
  position: 'bottom-center',
  format: 'Page {n} of {total}',
  start: 1,
  fontSize: 10,
  margin: 28,
  skipFirst: false,
  color: '#333333',
}

export function PageNumbersDialog({ onClose }: { onClose: () => void }) {
  const current = useStore((s) => s.stamps.pageNumbers)
  const total = useStore((s) => s.pages.length)
  const setStamps = useStore((s) => s.setStamps)
  const [o, setO] = useState<PageNumberSettings>(current ?? DEFAULT_NUMBERS)
  const set = (p: Partial<PageNumberSettings>) => setO({ ...o, ...p })
  const example = pageNumberText({ ...o, skipFirst: false }, 0, total - (o.skipFirst ? 1 : 0)) ?? ''

  return (
    <Modal
      icon="hash"
      title="Page numbers"
      onClose={onClose}
      footer={
        <>
          {current && (
            <button
              className="ghost danger"
              onClick={() => {
                setStamps({ pageNumbers: null })
                onClose()
              }}
            >
              Remove
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => {
              setStamps({ pageNumbers: o })
              onClose()
            }}
          >
            <Icon name="check" /> {current ? 'Update' : 'Add page numbers'}
          </button>
        </>
      }
    >
      <p className="hint">
        Added to every page and kept up to date — they renumber when you reorder, add or delete
        pages. They're part of the PDF you download.
      </p>
      <div className="field">
        <label>Position</label>
        <select value={o.position} onChange={(e) => set({ position: e.target.value as StampPosition })}>
          {POSITIONS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>
          Format <span className="value">{example}</span>
        </label>
        <select value={o.format} onChange={(e) => set({ format: e.target.value })}>
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {f.replace('{n}', '1').replace('{total}', String(total))}
            </option>
          ))}
        </select>
      </div>
      <div className="field grid2">
        <label className="num">
          <span>Start at</span>
          <input
            type="number"
            min={0}
            value={o.start}
            onChange={(e) => set({ start: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="num">
          <span>Size</span>
          <input
            type="number"
            min={6}
            max={36}
            value={o.fontSize}
            onChange={(e) => set({ fontSize: Math.min(36, Math.max(6, Number(e.target.value) || 10)) })}
          />
        </label>
      </div>
      <div className="field">
        <label>
          Distance from edge <span className="value">{o.margin} pt</span>
        </label>
        <input type="range" min={10} max={72} value={o.margin} onChange={(e) => set({ margin: Number(e.target.value) })} />
      </div>
      <label className="check standalone">
        <input type="checkbox" checked={o.skipFirst} onChange={(e) => set({ skipFirst: e.target.checked })} />
        Don't number the first page (a cover)
      </label>
    </Modal>
  )
}

// ------------------------------------------------------------------ watermark

const DEFAULT_WATERMARK: WatermarkSettings = {
  text: 'CONFIDENTIAL',
  fontSize: 64,
  color: '#d92d20',
  opacity: 0.18,
  angle: 45,
}

const WM_COLOURS = ['#d92d20', '#101828', '#667085', '#1570ef', '#12b76a']

export function WatermarkDialog({ onClose }: { onClose: () => void }) {
  const current = useStore((s) => s.stamps.watermark)
  const setStamps = useStore((s) => s.setStamps)
  const [o, setO] = useState<WatermarkSettings>(current ?? DEFAULT_WATERMARK)
  const set = (p: Partial<WatermarkSettings>) => setO({ ...o, ...p })

  return (
    <Modal
      icon="stamp"
      title="Watermark"
      onClose={onClose}
      footer={
        <>
          {current && (
            <button
              className="ghost danger"
              onClick={() => {
                setStamps({ watermark: null })
                onClose()
              }}
            >
              Remove
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!o.text.trim()}
            onClick={() => {
              setStamps({ watermark: { ...o, text: o.text.trim() } })
              onClose()
            }}
          >
            <Icon name="check" /> {current ? 'Update' : 'Add watermark'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Text</label>
        <input
          type="text"
          value={o.text}
          maxLength={60}
          autoFocus
          onChange={(e) => set({ text: e.target.value })}
          placeholder="CONFIDENTIAL, DRAFT, COPY…"
        />
      </div>
      <div className="wm-preview" aria-hidden="true">
        <span
          style={{
            color: o.color,
            opacity: Math.max(o.opacity, 0.08),
            transform: `rotate(${-o.angle}deg)`,
            fontSize: Math.max(10, Math.min(30, o.fontSize / 2.6)),
          }}
        >
          {o.text || ' '}
        </span>
      </div>
      <div className="field">
        <label>Direction</label>
        <div className="seg wide">
          {[
            { a: 45, l: 'Diagonal' },
            { a: 0, l: 'Across' },
            { a: 90, l: 'Up the side' },
          ].map((d) => (
            <button key={d.a} className={o.angle === d.a ? 'on' : ''} onClick={() => set({ angle: d.a })}>
              {d.l}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>
          Size <span className="value">{o.fontSize} pt</span>
        </label>
        <input type="range" min={20} max={140} value={o.fontSize} onChange={(e) => set({ fontSize: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label>
          Opacity <span className="value">{Math.round(o.opacity * 100)}%</span>
        </label>
        <input
          type="range"
          min={5}
          max={70}
          value={Math.round(o.opacity * 100)}
          onChange={(e) => set({ opacity: Number(e.target.value) / 100 })}
        />
      </div>
      <div className="field">
        <label>Colour</label>
        <div className="swatches">
          {WM_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              className={`swatch${o.color === c ? ' on' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => set({ color: c })}
            />
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------- split

type SplitMode = 'ranges' | 'every' | 'each'

export function SplitDialog({ onClose, filename }: { onClose: () => void; filename: string }) {
  const pages = useStore((s) => s.pages)
  const [mode, setMode] = useState<SplitMode>('ranges')
  const [ranges, setRanges] = useState(() => (pages.length > 1 ? `1-${Math.ceil(pages.length / 2)}, ${Math.ceil(pages.length / 2) + 1}-${pages.length}` : '1'))
  const [every, setEvery] = useState(2)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const groups = useMemo<number[][] | string>(() => {
    const n = pages.length
    if (mode === 'ranges') return parseRanges(ranges, n)
    const size = mode === 'each' ? 1 : Math.max(1, every)
    const out: number[][] = []
    for (let i = 0; i < n; i += size) out.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k))
    return out
  }, [mode, ranges, every, pages.length])

  async function run() {
    if (typeof groups === 'string') return
    setError(null)
    try {
      const base = baseName(filename)
      const files: Array<{ name: string; bytes: Uint8Array }> = []
      for (const [i, g] of groups.entries()) {
        setWorking(`Building file ${i + 1} of ${groups.length}…`)
        const ids = g.map((k) => pages[k].id)
        files.push({ name: `${base}-pages-${rangeLabel(g)}.pdf`, bytes: await buildCurrent(ids) })
      }
      const { downloadBytes } = await import('../lib/export')
      if (files.length === 1) {
        downloadBytes(files[0].bytes, files[0].name)
      } else {
        setWorking('Zipping…')
        const { makeZip } = await import('../lib/zip')
        downloadBytes(makeZip(files), `${base}-split.zip`, 'application/zip')
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Split failed.')
    } finally {
      setWorking(null)
    }
  }

  return (
    <Modal
      icon="split"
      title="Split PDF"
      onClose={onClose}
      busy={!!working}
      footer={
        <>
          <button className="ghost" onClick={onClose} disabled={!!working}>
            Cancel
          </button>
          <button className="primary" disabled={typeof groups === 'string' || !!working} onClick={run}>
            <Icon name="download" />{' '}
            {working ??
              (typeof groups === 'string'
                ? 'Split'
                : groups.length === 1
                  ? 'Download 1 file'
                  : `Download ${groups.length} files (.zip)`)}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Split into</label>
        <div className="seg wide">
          <button className={mode === 'ranges' ? 'on' : ''} onClick={() => setMode('ranges')}>
            Page ranges
          </button>
          <button className={mode === 'every' ? 'on' : ''} onClick={() => setMode('every')}>
            Every N pages
          </button>
          <button className={mode === 'each' ? 'on' : ''} onClick={() => setMode('each')}>
            Single pages
          </button>
        </div>
      </div>
      {mode === 'ranges' && (
        <div className="field">
          <label>Ranges — one file per range</label>
          <input
            type="text"
            value={ranges}
            onChange={(e) => setRanges(e.target.value)}
            placeholder="e.g. 1-3, 4, 5-"
            autoFocus
          />
        </div>
      )}
      {mode === 'every' && (
        <div className="field grid2">
          <label className="num">
            <span>Pages per file</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, pages.length)}
              value={every}
              onChange={(e) => setEvery(Math.max(1, Math.round(Number(e.target.value) || 1)))}
            />
          </label>
        </div>
      )}
      {typeof groups === 'string' ? (
        <p className="error-text">{groups}</p>
      ) : (
        <p className="hint">
          {groups.length} file{groups.length === 1 ? '' : 's'}:{' '}
          {groups
            .slice(0, 12)
            .map((g) => `pages ${rangeLabel(g)}`)
            .join(' · ')}
          {groups.length > 12 ? ` · and ${groups.length - 12} more` : ''}. Your edits are included.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

// ----------------------------------------------------------- export as images

export function ExportImagesDialog({ onClose, filename }: { onClose: () => void; filename: string }) {
  const pages = useStore((s) => s.pages)
  const currentPageId = useStore((s) => s.currentPageId)
  const [format, setFormat] = useState<'png' | 'jpeg'>('png')
  const [dpi, setDpi] = useState(150)
  const [which, setWhich] = useState<'all' | 'current' | 'range'>(pages.length > 1 ? 'all' : 'current')
  const [range, setRange] = useState('1')
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const indices = useMemo<number[] | string>(() => {
    if (which === 'all') return pages.map((_, i) => i)
    if (which === 'current') return [Math.max(0, pages.findIndex((p) => p.id === currentPageId))]
    const r = parseRanges(range, pages.length)
    return typeof r === 'string' ? r : [...new Set(r.flat())].sort((a, b) => a - b)
  }, [which, range, pages, currentPageId])

  async function run() {
    if (typeof indices === 'string') return
    setError(null)
    try {
      setWorking('Preparing…')
      const bytes = await buildCurrent()
      const { openWithPdfjs } = await import('../lib/pdfjs')
      const doc = await openWithPdfjs(bytes)
      const base = baseName(filename)
      const ext = format === 'png' ? 'png' : 'jpg'
      const files: Array<{ name: string; bytes: Uint8Array }> = []
      const canvas = document.createElement('canvas')
      try {
        for (const [n, i] of indices.entries()) {
          setWorking(`Rendering page ${n + 1} of ${indices.length}…`)
          const page = await doc.getPage(i + 1)
          const base1 = page.getViewport({ scale: 1 })
          // Stay inside browser canvas limits on very large pages.
          const scale = Math.min(dpi / 72, 8000 / Math.max(base1.width, base1.height))
          const viewport = page.getViewport({ scale })
          canvas.width = Math.max(1, Math.floor(viewport.width))
          canvas.height = Math.max(1, Math.floor(viewport.height))
          const ctx = canvas.getContext('2d', { alpha: false })!
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, canvas.width, canvas.height)
          await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise
          const blob = await new Promise<Blob | null>((r) =>
            canvas.toBlob(r, format === 'png' ? 'image/png' : 'image/jpeg', 0.9),
          )
          if (!blob) throw new Error(`Could not encode page ${i + 1}.`)
          files.push({ name: `${base}-page-${i + 1}.${ext}`, bytes: new Uint8Array(await blob.arrayBuffer()) })
          page.cleanup()
        }
      } finally {
        canvas.width = 0
        canvas.height = 0
        void doc.destroy()
      }
      const { downloadBytes } = await import('../lib/export')
      if (files.length === 1) {
        downloadBytes(files[0].bytes, files[0].name, format === 'png' ? 'image/png' : 'image/jpeg')
      } else {
        setWorking('Zipping…')
        const { makeZip } = await import('../lib/zip')
        downloadBytes(makeZip(files), `${base}-images.zip`, 'application/zip')
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      setWorking(null)
    }
  }

  const count = typeof indices === 'string' ? 0 : indices.length
  return (
    <Modal
      icon="image"
      title="Save pages as images"
      onClose={onClose}
      busy={!!working}
      footer={
        <>
          <button className="ghost" onClick={onClose} disabled={!!working}>
            Cancel
          </button>
          <button className="primary" disabled={!count || !!working} onClick={run}>
            <Icon name="download" />{' '}
            {working ?? (count > 1 ? `Download ${count} images (.zip)` : 'Download image')}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Format</label>
        <div className="seg wide">
          <button className={format === 'png' ? 'on' : ''} onClick={() => setFormat('png')}>
            PNG — sharp
          </button>
          <button className={format === 'jpeg' ? 'on' : ''} onClick={() => setFormat('jpeg')}>
            JPG — smaller
          </button>
        </div>
      </div>
      <div className="field">
        <label>Resolution</label>
        <div className="seg wide">
          {[
            { d: 72, l: 'Screen (72)' },
            { d: 150, l: 'Standard (150)' },
            { d: 300, l: 'Print (300)' },
          ].map((r) => (
            <button key={r.d} className={dpi === r.d ? 'on' : ''} onClick={() => setDpi(r.d)}>
              {r.l}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Pages</label>
        <div className="seg wide">
          <button className={which === 'all' ? 'on' : ''} onClick={() => setWhich('all')}>
            All ({pages.length})
          </button>
          <button className={which === 'current' ? 'on' : ''} onClick={() => setWhich('current')}>
            This page
          </button>
          <button className={which === 'range' ? 'on' : ''} onClick={() => setWhich('range')}>
            Choose…
          </button>
        </div>
      </div>
      {which === 'range' && (
        <div className="field">
          <input type="text" value={range} onChange={(e) => setRange(e.target.value)} placeholder="e.g. 1-3, 7" autoFocus />
        </div>
      )}
      {typeof indices === 'string' && <p className="error-text">{indices}</p>}
      {error && <p className="error-text">{error}</p>}
      <p className="hint">Images include your edits, page numbers and watermark.</p>
    </Modal>
  )
}

// ------------------------------------------------------------------- protect

export function ProtectDialog({ onClose, filename }: { onClose: () => void; filename: string }) {
  const [pw, setPw] = useState('')
  const [again, setAgain] = useState('')
  const [show, setShow] = useState(false)
  const [allowPrinting, setAllowPrinting] = useState(true)
  const [allowCopying, setAllowCopying] = useState(true)
  const [allowEditing, setAllowEditing] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = !pw
    ? 'Choose a password.'
    : pw.length < 4
      ? 'Use at least 4 characters.'
      : pw !== again
        ? "The two passwords don't match yet."
        : null

  async function run() {
    if (problem) return
    setWorking(true)
    setError(null)
    try {
      const bytes = await buildCurrent()
      const { protectPdf } = await import('../lib/encryption')
      const out = await protectPdf(bytes, { password: pw, allowPrinting, allowCopying, allowEditing })
      const { downloadBytes } = await import('../lib/export')
      downloadBytes(out, `${baseName(filename)}-protected.pdf`)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not protect the file.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <Modal
      icon="lock"
      title="Protect with password"
      onClose={onClose}
      busy={working}
      footer={
        <>
          <button className="ghost" onClick={onClose} disabled={working}>
            Cancel
          </button>
          <button className="primary" disabled={!!problem || working} onClick={run}>
            <Icon name="lock" /> {working ? 'Encrypting…' : 'Download protected PDF'}
          </button>
        </>
      }
    >
      <p className="hint">
        Anyone opening the file will need this password. It's encrypted with AES-256 right here in
        your browser — the password never leaves this page, and there's no way to recover it if
        it's lost.
      </p>
      <div className="field">
        <label>Password</label>
        <input
          type={show ? 'text' : 'password'}
          value={pw}
          autoFocus
          autoComplete="new-password"
          onChange={(e) => setPw(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Type it again</label>
        <input
          type={show ? 'text' : 'password'}
          value={again}
          autoComplete="new-password"
          onChange={(e) => setAgain(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run()}
        />
      </div>
      <label className="check standalone">
        <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
        Show password
      </label>
      <div className="field-block">
        <span className="field-label">Once opened, people can…</span>
        <label className="check standalone">
          <input type="checkbox" checked={allowPrinting} onChange={(e) => setAllowPrinting(e.target.checked)} />
          Print it
        </label>
        <label className="check standalone">
          <input type="checkbox" checked={allowCopying} onChange={(e) => setAllowCopying(e.target.checked)} />
          Copy text and images
        </label>
        <label className="check standalone">
          <input type="checkbox" checked={allowEditing} onChange={(e) => setAllowEditing(e.target.checked)} />
          Edit, comment and rearrange pages
        </label>
        {(!allowPrinting || !allowCopying || !allowEditing) && (
          <p className="hint">
            Restrictions are honoured by mainstream PDF apps, but they're a request, not a lock —
            only the password itself truly protects the content.
          </p>
        )}
      </div>
      {pw && problem && <p className="hint warn-text">{problem}</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}

// ------------------------------------------------------- unlock prompt (open)

export function PasswordPromptDialog() {
  const prompt = useStore((s) => s.passwordPrompt)
  const answer = useStore((s) => s.answerPassword)
  const [pw, setPw] = useState('')
  const [checking, setChecking] = useState(false)
  if (!prompt) return null
  const submit = () => {
    if (!pw) return
    setChecking(true)
    answer(pw)
    setPw('')
    // The store re-opens the prompt with an error if the password was wrong.
    setTimeout(() => setChecking(false), 300)
  }
  return (
    <Modal
      icon="lock"
      title="This PDF is password-protected"
      onClose={() => answer(null)}
      footer={
        <>
          <button className="ghost" onClick={() => answer(null)}>
            Skip this file
          </button>
          <button className="primary" disabled={!pw || checking} onClick={submit}>
            <Icon name="lock" /> Unlock
          </button>
        </>
      }
    >
      <p className="hint">
        Enter the password for <strong>{prompt.fileName}</strong>. It's checked here in your browser
        and never sent anywhere.
      </p>
      <div className="field">
        <label>Password</label>
        <input
          type="password"
          value={pw}
          autoFocus
          autoComplete="current-password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      {prompt.error && <p className="error-text">{prompt.error}</p>}
    </Modal>
  )
}

// --------------------------------------------------------- PDF → Office

const OFFICE = {
  toWord: {
    title: 'Convert to Word',
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    modes: [
      { id: 'editable', label: 'Editable text', hint: 'Paragraphs, headings, bold/italic, colours and pictures rebuilt as a normal Word document you can edit.' },
      { id: 'exact', label: 'Exact look', hint: 'Every page placed as a picture — looks identical, but the text is not editable.' },
    ],
  },
  toExcel: {
    title: 'Convert to Excel',
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    modes: [
      { id: 'perPage', label: 'A sheet per page', hint: 'Each page becomes its own sheet. Columns come from how the text lines up; numbers, money and percentages become real numbers.' },
      { id: 'single', label: 'All on one sheet', hint: 'Every page stacked on one sheet, one blank row between pages — best for a long table that runs across pages.' },
    ],
  },
  toPowerPoint: {
    title: 'Convert to PowerPoint',
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    modes: [
      { id: 'editable', label: 'Editable text', hint: 'One slide per page: the page as the background with its text lifted into real, editable text boxes on top.' },
      { id: 'pictures', label: 'Pages as pictures', hint: 'One slide per page, each page as a picture — exact look, nothing editable.' },
    ],
  },
} as const

export function ConvertOutDialog({
  kind,
  onClose,
  filename,
}: {
  kind: 'toWord' | 'toExcel' | 'toPowerPoint'
  onClose: () => void
  filename: string
}) {
  const cfg = OFFICE[kind]
  const [mode, setMode] = useState<string>(cfg.modes[0].id)
  const [images, setImages] = useState(true)
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)

  async function run() {
    setError(null)
    setScanned(false)
    try {
      setWorking('Preparing…')
      const bytes = await buildCurrent()
      const mod = await import('../lib/pdf-to-office')
      const onProgress = (p: { page: number; total: number }) => setWorking(`Converting page ${p.page} of ${p.total}…`)
      let out: Uint8Array
      if (kind === 'toWord') out = await mod.pdfToWord(bytes, { mode: mode as 'editable' | 'exact', images, onProgress })
      else if (kind === 'toExcel') out = await mod.pdfToExcel(bytes, { sheets: mode as 'perPage' | 'single', onProgress })
      else out = await mod.pdfToPowerPoint(bytes, { mode: mode as 'editable' | 'pictures', onProgress })
      if (mode !== 'exact' && mode !== 'pictures') {
        // A scan has no text layer: warn rather than hand back an empty file.
        const { openWithPdfjs } = await import('../lib/pdfjs')
        const doc = await openWithPdfjs(bytes)
        let chars = 0
        for (let i = 1; i <= Math.min(doc.numPages, 5) && chars < 20; i++) {
          const t = await (await doc.getPage(i)).getTextContent()
          chars += t.items.reduce((n, it) => n + ('str' in it ? it.str.trim().length : 0), 0)
        }
        void doc.destroy()
        if (chars < 20) {
          setScanned(true)
          setWorking(null)
          return
        }
      }
      const { downloadBytes } = await import('../lib/export')
      downloadBytes(out, `${baseName(filename)}.${cfg.ext}`, cfg.mime)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed.')
    } finally {
      setWorking(null)
    }
  }

  const current = cfg.modes.find((m) => m.id === mode)!
  return (
    <Modal
      icon="convert"
      title={cfg.title}
      onClose={onClose}
      busy={!!working}
      footer={
        <>
          <button className="ghost" onClick={onClose} disabled={!!working}>
            Cancel
          </button>
          <button className="primary" disabled={!!working} onClick={run}>
            <Icon name="download" /> {working ?? `Download .${cfg.ext}`}
          </button>
        </>
      }
    >
      <div className="seg wide">
        {cfg.modes.map((m) => (
          <button key={m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        {current.hint}
      </p>
      {kind === 'toWord' && mode === 'editable' && (
        <label className="check standalone">
          <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />
          Include pictures
        </label>
      )}
      <p className="hint">
        Converted right here in your browser — the file isn't uploaded. Your edits, page numbers
        and watermark are included. Layouts are rebuilt from the page, so complex designs may need
        a little tidying afterwards.
      </p>
      {scanned && (
        <p className="hint warn-text">
          This looks like a scanned document — it has no text to convert yet. Run{' '}
          <strong>Make searchable</strong> first, or choose the{' '}
          {kind === 'toPowerPoint' ? '“Pages as pictures”' : kind === 'toWord' ? '“Exact look”' : 'Word “Exact look”'} option.
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  )
}
