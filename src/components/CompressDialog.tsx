import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { PRESETS, type CompressSettings } from '../lib/compress-presets'
import { formatBytes } from '../lib/geometry'
import { Icon } from './Icon'

type Phase = 'preparing' | 'ready' | 'working' | 'done' | 'error'

export function CompressDialog({ onClose, filename }: { onClose: () => void; filename: string }) {
  const pages = useStore((s) => s.pages)
  const sources = useStore((s) => s.sources)
  const annotations = useStore((s) => s.annotations)
  const images = useStore((s) => s.images)

  const [phase, setPhase] = useState<Phase>('preparing')
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState(0)
  const [presetId, setPresetId] = useState('balanced')
  const [settings, setSettings] = useState<CompressSettings>(
    () => PRESETS.find((p) => p.id === 'balanced')!.settings,
  )
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

  function choosePreset(id: string) {
    const preset = PRESETS.find((p) => p.id === id)
    if (!preset) return
    setPresetId(id)
    setSettings({ ...preset.settings, grayscale: settings.grayscale })
    setResult(null)
  }

  async function run() {
    if (!original) return
    setPhase('working')
    setProgress(0)
    setResult(null)
    try {
      const { compressPdf } = await import('../lib/compress')
      const out = await compressPdf(original, settings, (done, total) =>
        setProgress(total ? done / total : 0),
      )
      if (cancelled.current) return
      setResult(out)
      setPhase('done')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Compression failed.')
      setPhase('error')
    }
  }

  const saved =
    original && result ? Math.max(0, 1 - result.byteLength / original.byteLength) : null

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Icon name="compress" size={18} /> Compress
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
              <div className="size-row">
                <div>
                  <span className="k">Current</span>
                  <strong>{original ? formatBytes(original.byteLength) : '—'}</strong>
                </div>
                <Icon name="line" size={20} />
                <div>
                  <span className="k">After</span>
                  <strong className={result ? 'good' : ''}>
                    {result ? formatBytes(result.byteLength) : '—'}
                  </strong>
                </div>
                {saved !== null && (
                  <div className="saved">−{Math.round(saved * 100)}%</div>
                )}
              </div>

              <div className="presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    className={`preset${presetId === p.id ? ' on' : ''}`}
                    onClick={() => choosePreset(p.id)}
                  >
                    <strong>{p.label}</strong>
                    <span>{p.hint}</span>
                  </button>
                ))}
              </div>

              {settings.mode === 'rasterize' && (
                <div className="advanced">
                  <label>
                    Resolution <span className="value">{settings.dpi} DPI</span>
                    <input
                      type="range"
                      min={50}
                      max={200}
                      step={5}
                      value={settings.dpi}
                      onChange={(e) => {
                        setSettings({ ...settings, dpi: Number(e.target.value) })
                        setResult(null)
                      }}
                    />
                  </label>
                  <label>
                    Image quality <span className="value">{Math.round(settings.quality * 100)}</span>
                    <input
                      type="range"
                      min={20}
                      max={95}
                      step={1}
                      value={Math.round(settings.quality * 100)}
                      onChange={(e) => {
                        setSettings({ ...settings, quality: Number(e.target.value) / 100 })
                        setResult(null)
                      }}
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={settings.grayscale}
                      onChange={(e) => {
                        setSettings({ ...settings, grayscale: e.target.checked })
                        setResult(null)
                      }}
                    />
                    Convert to greyscale (smaller, no colour)
                  </label>
                  <p className="hint">
                    Rasterising flattens each page to an image — text is no longer selectable or
                    searchable. Use “Keep text sharp” if that matters.
                  </p>
                </div>
              )}

              {phase === 'working' && (
                <div className="progress">
                  <div style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
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
            {phase === 'working' ? 'Compressing…' : result ? 'Compress again' : 'Compress'}
          </button>
          <button
            className="primary"
            disabled={!result}
            onClick={async () => {
              if (!result) return
              const { downloadBytes } = await import('../lib/export')
              downloadBytes(result, filename.replace(/\.pdf$/i, '') + '-compressed.pdf')
            }}
          >
            <Icon name="download" /> Download
          </button>
        </footer>
      </div>
    </div>
  )
}
