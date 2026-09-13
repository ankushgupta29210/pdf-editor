import { useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../lib/geometry'
import {
  heavyShrinkBytes,
  isMobileBrowser,
  maxShrinkBytes,
  shrinkTooLargeMessage,
} from '../lib/limits'
import type { ShrinkProgress } from '../lib/shrink'
import { Icon } from './Icon'

type Phase = 'ready' | 'working' | 'done' | 'error' | 'blocked'

const MB = 1024 * 1024
const TARGETS = [5, 10, 25, 50, 100]

/** How sharp the output is allowed to get; the run only ever works down from it. */
const CEILINGS: Array<{ id: string; label: string; hint: string; dpi: number }> = [
  { id: 'text', label: 'Readable text', hint: 'Up to 150 DPI — fine to print', dpi: 150 },
  { id: 'screen', label: 'Screen & email', hint: 'Up to 110 DPI — the usual choice', dpi: 110 },
  { id: 'tiny', label: 'Smallest', hint: 'Up to 80 DPI — on-screen reading', dpi: 80 },
]

const PHASE_LABEL: Record<ShrinkProgress['phase'], string> = {
  reading: 'Reading the file…',
  opening: 'Opening the document…',
  pages: 'Compressing pages',
  writing: 'Writing the new PDF…',
}

/**
 * The large-file path. Deliberately separate from CompressDialog: that one works
 * on whatever is open in the editor, which caps out around 80 MB. This one takes
 * the file straight off disk and never builds a page list, so it can take the
 * 300–400 MB scans people actually need to get under an upload limit.
 */
export function ShrinkDialog({ file, onClose }: { file: File; onClose: () => void }) {
  const onPhone = useMemo(isMobileBrowser, [])
  const tooBig = file.size > maxShrinkBytes()

  const [phase, setPhase] = useState<Phase>(tooBig ? 'blocked' : 'ready')
  const [message, setMessage] = useState(tooBig ? shrinkTooLargeMessage(file.name, file.size) : '')
  const [targetMb, setTargetMb] = useState(25)
  const [ceiling, setCeiling] = useState('screen')
  const [grayscale, setGrayscale] = useState(false)
  const [progress, setProgress] = useState<ShrinkProgress | null>(null)
  const [result, setResult] = useState<Uint8Array | null>(null)
  const [missed, setMissed] = useState(false)

  const abort = useRef<AbortController | null>(null)
  useEffect(() => () => abort.current?.abort(), [])

  // A job this long is lost if the tab is closed, so make leaving deliberate.
  useEffect(() => {
    if (phase !== 'working') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase])

  async function run() {
    const controller = new AbortController()
    abort.current = controller
    setPhase('working')
    setResult(null)
    setMissed(false)
    setProgress({ phase: 'reading', done: 0, total: 0, bytes: 0, dpi: 0 })
    try {
      const { shrinkToTarget } = await import('../lib/shrink')
      const out = await shrinkToTarget(file, {
        targetBytes: targetMb * MB,
        maxDpi: CEILINGS.find((c) => c.id === ceiling)!.dpi,
        grayscale,
        signal: controller.signal,
        onProgress: setProgress,
      })
      setResult(out.bytes)
      setMissed(out.missedTarget)
      setPhase('done')
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase('ready')
        setProgress(null)
        return
      }
      setMessage(
        err instanceof Error && /allocat|memory|out of/i.test(err.message)
          ? 'The browser ran out of memory on this file. Close other tabs and try again, ' +
            'or pick a smaller target size.'
          : err instanceof Error
            ? err.message
            : 'Compression failed.',
      )
      setPhase('error')
    } finally {
      abort.current = null
    }
  }

  const saved = result ? Math.max(0, 1 - result.byteLength / file.size) : null
  const pct = progress?.total ? progress.done / progress.total : 0
  const busy = phase === 'working'

  return (
    <div className="modal-backdrop" onPointerDown={busy ? undefined : onClose}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Icon name="compress" size={18} /> Compress a large PDF
          </h2>
          <button className="icon" onClick={onClose} disabled={busy} title="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="modal-body">
          <div className="size-row">
            <div className="grow">
              <span className="k">File</span>
              <strong className="ellipsis" title={file.name}>
                {file.name}
              </strong>
            </div>
            <Icon name="line" size={20} />
            <div>
              <span className="k">{result ? 'After' : 'Now'}</span>
              <strong className={result ? 'good' : ''}>
                {formatBytes(result ? result.byteLength : file.size)}
              </strong>
            </div>
            {saved !== null && <div className="saved">−{Math.round(saved * 100)}%</div>}
          </div>

          {phase === 'blocked' || phase === 'error' ? (
            <p className="error-text">{message}</p>
          ) : (
            <>
              {onPhone ? (
                <div className="device-warn">
                  <Icon name="info" size={15} />
                  <div>
                    <strong>Use a computer for this, not a phone.</strong>
                    <p>
                      Everything runs inside this tab, and a phone or tablet browser will close the
                      tab part-way through a file this size — with no warning. Email the file to
                      yourself and open this page on a laptop or desktop.
                    </p>
                  </div>
                </div>
              ) : (
                file.size > heavyShrinkBytes() && (
                  <div className="device-warn">
                    <Icon name="info" size={15} />
                    <div>
                      <strong>This is a big job — give it room.</strong>
                      <p>
                        {formatBytes(file.size)} is rebuilt page by page inside this tab, which can
                        take several minutes and a few GB of free memory. Close other heavy tabs,
                        keep this one in front and the screen awake — closing it loses the work.
                        Do this on a computer; a phone will not finish it.
                      </p>
                    </div>
                  </div>
                )
              )}

              <div className="field-block">
                <span className="field-label">Target size</span>
                <div className="chip-row">
                  {TARGETS.map((mb) => (
                    <button
                      key={mb}
                      className={`chip${targetMb === mb ? ' on' : ''}`}
                      disabled={busy}
                      onClick={() => setTargetMb(mb)}
                    >
                      {mb} MB
                    </button>
                  ))}
                  <label className="chip custom">
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={targetMb}
                      disabled={busy}
                      onChange={(e) =>
                        setTargetMb(Math.min(500, Math.max(1, Number(e.target.value) || 1)))
                      }
                    />
                    MB
                  </label>
                </div>
                <p className="hint">
                  Resolution and image quality are chosen for you, page by page, to land near this
                  size — you do not have to guess at a DPI.
                </p>
              </div>

              <div className="presets">
                {CEILINGS.map((c) => (
                  <button
                    key={c.id}
                    className={`preset${ceiling === c.id ? ' on' : ''}`}
                    disabled={busy}
                    onClick={() => setCeiling(c.id)}
                  >
                    <strong>{c.label}</strong>
                    <span>{c.hint}</span>
                  </button>
                ))}
              </div>

              <label className="check standalone">
                <input
                  type="checkbox"
                  checked={grayscale}
                  disabled={busy}
                  onChange={(e) => setGrayscale(e.target.checked)}
                />
                Convert to greyscale (much smaller for scans, no colour)
              </label>

              <p className="hint">
                Every page becomes an image, so text stops being selectable or searchable. To keep
                text intact, open the file in the editor and use Compress → “Keep text sharp”.
              </p>

              {progress && (
                <div className="run-state">
                  <div className="run-line">
                    <span>
                      {PHASE_LABEL[progress.phase]}
                      {progress.phase === 'pages' && ` ${progress.done}/${progress.total}`}
                    </span>
                    {progress.phase === 'pages' && (
                      <span className="mono">
                        {formatBytes(progress.bytes)} · {progress.dpi} DPI
                      </span>
                    )}
                  </div>
                  <div className="progress">
                    <div
                      className={progress.phase === 'pages' ? '' : 'indeterminate'}
                      style={
                        progress.phase === 'pages'
                          ? { width: `${Math.round(pct * 100)}%` }
                          : undefined
                      }
                    />
                  </div>
                </div>
              )}

              {phase === 'done' && missed && (
                <p className="hint warn-text">
                  This is as small as it goes — {result && formatBytes(result.byteLength)} — without
                  dropping below readable resolution. Try greyscale, or the “Smallest” ceiling, to
                  get under {targetMb} MB.
                </p>
              )}
            </>
          )}
        </div>

        <footer>
          {busy ? (
            <button className="ghost" onClick={() => abort.current?.abort()}>
              Stop
            </button>
          ) : (
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          )}
          <button className="primary" disabled={busy || phase === 'blocked'} onClick={run}>
            {busy ? 'Compressing…' : result ? 'Try other settings' : 'Compress'}
          </button>
          <button
            className="primary"
            disabled={!result || busy}
            onClick={async () => {
              if (!result) return
              const { downloadBytes } = await import('../lib/export')
              downloadBytes(result, file.name.replace(/\.pdf$/i, '') + '-compressed.pdf')
            }}
          >
            <Icon name="download" /> Download
          </button>
        </footer>
      </div>
    </div>
  )
}
