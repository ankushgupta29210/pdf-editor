import { useEffect, useRef, useState } from 'react'
// Handwriting fonts for typed signatures. They ship with the site (no font
// CDN), and this whole module is loaded only when the dialog first opens.
// Latin + Latin Extended covers names with accents (é, ñ, ł…).
import '@fontsource/dancing-script/latin-600.css'
import '@fontsource/dancing-script/latin-ext-600.css'
import '@fontsource/great-vibes/latin-400.css'
import '@fontsource/great-vibes/latin-ext-400.css'
import '@fontsource/caveat/latin-500.css'
import '@fontsource/caveat/latin-ext-500.css'
import '@fontsource/sacramento/latin-400.css'
import '@fontsource/sacramento/latin-ext-400.css'
import { Icon } from './Icon'

const FONTS = [
  { family: 'Dancing Script', weight: 600, label: 'Flowing' },
  { family: 'Great Vibes', weight: 400, label: 'Formal' },
  { family: 'Sacramento', weight: 400, label: 'Light' },
  { family: 'Caveat', weight: 500, label: 'Handwritten' },
]

const INKS = [
  { c: '#101828', l: 'Black' },
  { c: '#1d3fb0', l: 'Blue' },
]

const STORE_KEY = 'pdfeditor.signatures.v1'
const MAX_SAVED = 6

interface Saved {
  id: string
  url: string
}

/** Saved signatures live only in this browser's storage. Storage can be
 *  unavailable (private mode, blocked site data), so every access is guarded. */
function loadSaved(): Saved[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const list = raw ? (JSON.parse(raw) as Saved[]) : []
    return Array.isArray(list) ? list.filter((s) => typeof s?.url === 'string' && s.url.startsWith('data:image/png')) : []
  } catch {
    return []
  }
}

function writeSaved(list: Saved[]): boolean {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, MAX_SAVED)))
    return true
  } catch {
    return false
  }
}

/** Crops a canvas to its ink, with a little padding, and returns a PNG blob. */
async function trimToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const { width, height } = canvas
  const data = ctx.getImageData(0, 0, width, height).data
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  const pad = 6
  x0 = Math.max(0, x0 - pad)
  y0 = Math.max(0, y0 - pad)
  x1 = Math.min(width - 1, x1 + pad)
  y1 = Math.min(height - 1, y1 + pad)
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext('2d')!.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return new Promise((r) => out.toBlob(r, 'image/png'))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

export function SignatureDialog({
  onClose,
  onPlace,
}: {
  onClose: () => void
  /** receives a transparent PNG of the signature */
  onPlace: (file: File) => void
}) {
  const [saved, setSaved] = useState<Saved[]>(loadSaved)
  const [tab, setTab] = useState<'draw' | 'type' | 'saved'>(saved.length ? 'saved' : 'draw')
  const [ink, setInk] = useState(INKS[0].c)
  const [name, setName] = useState('')
  const [font, setFont] = useState(FONTS[0].family)
  const [remember, setRemember] = useState(true)
  const [hasInk, setHasInk] = useState(false)
  const [storageOk, setStorageOk] = useState(true)
  const pad = useRef<HTMLCanvasElement>(null)
  const drawing = useRef<{ x: number; y: number } | null>(null)

  // Size the drawing pad to its box at device resolution.
  useEffect(() => {
    if (tab !== 'draw') return
    const c = pad.current
    if (!c) return
    const r = c.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    c.width = Math.round(r.width * dpr)
    c.height = Math.round(r.height * dpr)
    setHasInk(false)
  }, [tab])

  // Wait for the handwriting fonts so previews and the PNG use them.
  const [fontsReady, setFontsReady] = useState(false)
  useEffect(() => {
    void Promise.all(FONTS.map((f) => document.fonts.load(`${f.weight} 40px "${f.family}"`))).finally(() =>
      setFontsReady(true),
    )
  }, [])

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const c = e.currentTarget
    const r = c.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
  }

  function stroke(from: { x: number; y: number }, to: { x: number; y: number }) {
    const c = pad.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const dpr = c.width / c.getBoundingClientRect().width
    ctx.strokeStyle = ink
    ctx.lineWidth = 2.6 * dpr
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }

  function clearPad() {
    const c = pad.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setHasInk(false)
  }

  async function typedPng(): Promise<Blob | null> {
    const c = document.createElement('canvas')
    const f = FONTS.find((x) => x.family === font)!
    const size = 120
    const ctx = c.getContext('2d')!
    ctx.font = `${f.weight} ${size}px "${f.family}"`
    const w = Math.ceil(ctx.measureText(name).width) + 80
    c.width = Math.min(Math.max(w, 200), 4000)
    c.height = Math.round(size * 1.9)
    const g = c.getContext('2d')!
    g.font = `${f.weight} ${size}px "${f.family}"`
    g.fillStyle = ink
    g.textBaseline = 'middle'
    g.fillText(name, 40, c.height / 2)
    return trimToPng(c)
  }

  async function place(blob: Blob | null) {
    if (!blob) return
    if (remember && tab !== 'saved') {
      const url = await blobToDataUrl(blob)
      if (!saved.some((s) => s.url === url)) {
        const next = [{ id: String(Date.now()), url }, ...saved].slice(0, MAX_SAVED)
        setStorageOk(writeSaved(next))
        setSaved(next)
      }
    }
    onPlace(new File([blob], 'signature.png', { type: 'image/png' }))
  }

  function remove(id: string) {
    const next = saved.filter((s) => s.id !== id)
    writeSaved(next)
    setSaved(next)
  }

  const canPlace = tab === 'draw' ? hasInk : tab === 'type' ? !!name.trim() && fontsReady : false

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal sig-modal" role="dialog" aria-label="Signature" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Icon name="signature" size={18} /> Add a signature
          </h2>
          <button className="icon" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">
          <div className="seg wide">
            <button className={tab === 'draw' ? 'on' : ''} onClick={() => setTab('draw')}>
              Draw
            </button>
            <button className={tab === 'type' ? 'on' : ''} onClick={() => setTab('type')}>
              Type
            </button>
            <button className={tab === 'saved' ? 'on' : ''} onClick={() => setTab('saved')}>
              Saved{saved.length ? ` (${saved.length})` : ''}
            </button>
          </div>

          {tab !== 'saved' && (
            <div className="field">
              <label>Ink</label>
              <div className="seg">
                {INKS.map((i) => (
                  <button key={i.c} className={ink === i.c ? 'on' : ''} onClick={() => setInk(i.c)}>
                    <span className="ink-dot" style={{ background: i.c }} /> {i.l}
                  </button>
                ))}
              </div>
            </div>
          )}

          {tab === 'draw' && (
            <>
              <div className="sig-pad-wrap">
                <canvas
                  ref={pad}
                  className="sig-pad"
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId)
                    drawing.current = point(e)
                    stroke(drawing.current, { x: drawing.current.x + 0.1, y: drawing.current.y })
                    setHasInk(true)
                  }}
                  onPointerMove={(e) => {
                    if (!drawing.current) return
                    // Coalesced events keep fast strokes smooth on touch screens.
                    const evs = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent]
                    for (const ev of evs) {
                      const r = e.currentTarget.getBoundingClientRect()
                      const p = {
                        x: ((ev.clientX - r.left) / r.width) * e.currentTarget.width,
                        y: ((ev.clientY - r.top) / r.height) * e.currentTarget.height,
                      }
                      stroke(drawing.current, p)
                      drawing.current = p
                    }
                  }}
                  onPointerUp={() => (drawing.current = null)}
                  onPointerCancel={() => (drawing.current = null)}
                />
                <span className="sig-line" aria-hidden="true" />
                {!hasInk && <span className="sig-hint">Sign here with your mouse, finger or pen</span>}
              </div>
              <button className="ghost small" onClick={clearPad} disabled={!hasInk}>
                Clear
              </button>
            </>
          )}

          {tab === 'type' && (
            <>
              <div className="field">
                <label>Your name</label>
                <input
                  type="text"
                  value={name}
                  maxLength={60}
                  autoFocus
                  placeholder="Type your name"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="sig-fonts">
                {FONTS.map((f) => (
                  <button
                    key={f.family}
                    className={`sig-font${font === f.family ? ' on' : ''}`}
                    onClick={() => setFont(f.family)}
                    title={f.label}
                  >
                    <span style={{ fontFamily: `"${f.family}"`, fontWeight: f.weight, color: ink }}>
                      {name.trim() || 'Your name'}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {tab === 'saved' &&
            (saved.length ? (
              <div className="sig-saved">
                {saved.map((s) => (
                  <div key={s.id} className="sig-saved-item">
                    <button
                      className="sig-saved-pick"
                      title="Place this signature"
                      onClick={async () => place(await (await fetch(s.url)).blob())}
                    >
                      <img src={s.url} alt="Saved signature" />
                    </button>
                    <button className="icon danger" title="Forget this signature" onClick={() => remove(s.id)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">
                Nothing saved yet. Signatures you draw or type can be kept here for next time.
              </p>
            ))}

          {tab !== 'saved' && (
            <label className="check standalone">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Save for next time (kept only in this browser, on this device)
            </label>
          )}
          {!storageOk && (
            <p className="hint warn-text">This browser isn't allowing saved data, so it won't be remembered.</p>
          )}
        </div>
        <footer>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          {tab !== 'saved' && (
            <button
              className="primary"
              disabled={!canPlace}
              onClick={async () => place(tab === 'draw' && pad.current ? await trimToPng(pad.current) : await typedPng())}
            >
              <Icon name="check" /> Place signature
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
