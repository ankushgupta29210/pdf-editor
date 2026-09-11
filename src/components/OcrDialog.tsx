import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { formatBytes } from '../lib/geometry'
import { OCR_LANGUAGES } from '../lib/ocr'
import type { OcrProgress } from '../lib/ocr'
import { Icon } from './Icon'

type Phase = 'preparing' | 'ready' | 'working' | 'done' | 'error'

export function OcrDialog({ onClose, filename }: { onClose: () => void; filename: string }) {
  const pages = useStore((s) => s.pages)
  const sources = useStore((s) => s.sources)
  const annotations = useStore((s) => s.annotations)
  const images = useStore((s) => s.images)

  const [phase, setPhase] = useState<Phase>('preparing')
  const [message, setMessage] = useState('')
  const [lang, setLang] = useState(OCR_LANGUAGES[0].code)
  const [progress, setProgress] = useState<OcrProgress | null>(null)
  const [original, setOriginal] = useState<Uint8Array | null>(null)
  const [result, setResult] = useState<Uint8Array | null>(null)

  const cancelled = useRef(false)
  useEffect(() => {
    // React 18 StrictMode runs this cleanup once, immediately, on the very
    // first mount (as a deliberate double-invoke to surface effect bugs like
    // this one) — without the reset below, that phantom cleanup would leave
    // `cancelled` stuck true forever, and any async work started afterwards
    // would finish successfully but have its result silently discarded by
    // the `if (cancelled.current) return` guards below.
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const { buildPdf } = await import('../lib/export')
        const bytes = await buildPdf(pages, sources, annotations, images)
        if (!alive) return
        setOriginal(bytes)
        setPhase('ready')
      } catch (err) {
        if (!alive) return
        setMessage(err instanceof Error ? err.message : 'Could not prepare the document.')
        setPhase('error')
      }
    })()
    return () => {
      alive = false
    }
  }, [pages, sources, annotations, images])

  async function run() {
    if (!original) return
    setPhase('working')
    setProgress({ page: 0, totalPages: pages.length, fraction: 0 })
    setResult(null)
    try {
      const { makeSearchable } = await import('../lib/ocr')
      const out = await makeSearchable(original, {
        lang,
        onProgress: (p) => !cancelled.current && setProgress(p),
      })
      if (cancelled.current) return
      setResult(out)
      setPhase('done')
    } catch (err) {
      if (cancelled.current) return
      setMessage(err instanceof Error ? err.message : 'OCR failed.')
      setPhase('error')
    }
  }

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Icon name="ocr" size={18} /> Make searchable
          </h2>
          <button className="icon" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="modal-body">
          {phase === 'preparing' && <p className="hint">Preparing the document…</p>}

          {phase === 'error' && <p className="error-text">{message}</p>}

          {phase !== 'preparing' && phase !== 'error' && (
            <>
              <p className="hint">
                Scans and photographed pages don't carry real text — you can't search or select
                anything on them. This reads every page with on-device OCR and adds an invisible,
                positioned text layer behind it, so the page looks exactly the same but becomes
                searchable and selectable. The first time you run this, your browser fetches a
                small language model (a few MB, cached afterwards) — the pages themselves are
                never uploaded anywhere.
              </p>

              {OCR_LANGUAGES.length > 1 && (
                <div className="field">
                  <label>Language</label>
                  <select
                    value={lang}
                    onChange={(e) => {
                      setLang(e.target.value)
                      setResult(null)
                    }}
                    disabled={phase === 'working'}
                  >
                    {OCR_LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {phase === 'working' && progress && (
                <>
                  <p className="hint">
                    Reading page {Math.min(progress.page, progress.totalPages)} of{' '}
                    {progress.totalPages}…
                  </p>
                  <div className="progress">
                    <div
                      style={{
                        width: `${Math.round(
                          (((progress.page - 1) + progress.fraction) / Math.max(progress.totalPages, 1)) *
                            100,
                        )}%`,
                      }}
                    />
                  </div>
                </>
              )}

              {phase === 'done' && result && (
                <p className="hint good">
                  Done — {formatBytes(result.byteLength)}. Every page now has a searchable text
                  layer.
                </p>
              )}
            </>
          )}
        </div>

        <footer>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={phase === 'preparing' || phase === 'working' || !original}
            onClick={run}
          >
            {phase === 'working' ? 'Reading…' : result ? 'Run again' : 'Make searchable'}
          </button>
          <button
            className="primary"
            disabled={!result}
            onClick={async () => {
              if (!result) return
              const { downloadBytes } = await import('../lib/export')
              downloadBytes(result, filename.replace(/\.pdf$/i, '') + '-searchable.pdf')
            }}
          >
            <Icon name="download" /> Download
          </button>
        </footer>
      </div>
    </div>
  )
}
