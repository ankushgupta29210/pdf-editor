import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_IMAGE_OPTIONS,
  PAGE_SIZES,
  PAGE_SIZE_LABELS,
  type ImagePageOptions,
  type PageSizeId,
} from '../lib/image'
import { formatBytes } from '../lib/geometry'
import { Icon } from './Icon'

interface Props {
  files: File[]
  onCancel: () => void
  onConfirm: (files: File[], options: ImagePageOptions) => void
}

export function ImagesDialog({ files, onCancel, onConfirm }: Props) {
  const [opts, setOpts] = useState<ImagePageOptions>(DEFAULT_IMAGE_OPTIONS)
  const [chosen, setChosen] = useState<File[]>(files)
  const [ratio, setRatio] = useState(1)

  const previews = useMemo(
    () => chosen.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
    [chosen],
  )
  useEffect(
    () => () => previews.forEach((p) => URL.revokeObjectURL(p.url)),
    [previews],
  )

  // The preview page shape follows the first image when sizes are automatic.
  const first = previews[0]
  useEffect(() => {
    if (!first) return
    const img = new Image()
    img.onload = () => setRatio(img.naturalWidth / Math.max(img.naturalHeight, 1))
    img.src = first.url
  }, [first])

  const pageRatio = useMemo(() => {
    if (opts.pageSize === 'fit') return ratio
    const s = PAGE_SIZES[opts.pageSize]
    const landscape =
      opts.orientation === 'landscape' || (opts.orientation === 'auto' && ratio > 1)
    return landscape ? s.h / s.w : s.w / s.h
  }, [opts.pageSize, opts.orientation, ratio])

  const totalBytes = chosen.reduce((n, f) => n + f.size, 0)
  const set = (patch: Partial<ImagePageOptions>) => setOpts({ ...opts, ...patch })

  return (
    <div className="modal-backdrop" onPointerDown={onCancel}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <header>
          <h2>
            <Icon name="image" size={18} /> Images to PDF
          </h2>
          <button className="icon" onClick={onCancel} title="Close">
            <Icon name="close" />
          </button>
        </header>

        <div className="modal-body">
          <p className="hint">
            {chosen.length} image{chosen.length === 1 ? '' : 's'} · {formatBytes(totalBytes)} —
            one page each, added to the end of the document.
          </p>

          <div className="image-strip">
            {previews.map(({ file, url }, i) => (
              <div className="image-chip" key={`${file.name}-${i}`}>
                <img src={url} alt="" />
                <span title={file.name}>{file.name}</span>
                <button
                  title="Remove"
                  onClick={() => setChosen(chosen.filter((_, j) => j !== i))}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="image-layout">
            <div className="field">
              <label>Page size</label>
              <select
                value={opts.pageSize}
                onChange={(e) => set({ pageSize: e.target.value as PageSizeId })}
              >
                {(Object.keys(PAGE_SIZE_LABELS) as PageSizeId[]).map((id) => (
                  <option key={id} value={id}>
                    {PAGE_SIZE_LABELS[id]}
                  </option>
                ))}
              </select>

              {opts.pageSize !== 'fit' && (
                <>
                  <label>Orientation</label>
                  <div className="seg wide">
                    {(['auto', 'portrait', 'landscape'] as const).map((o) => (
                      <button
                        key={o}
                        className={opts.orientation === o ? 'on' : ''}
                        onClick={() => set({ orientation: o })}
                      >
                        {o[0].toUpperCase() + o.slice(1)}
                      </button>
                    ))}
                  </div>

                  <label>Scaling</label>
                  <div className="seg wide">
                    <button
                      className={opts.fit === 'contain' ? 'on' : ''}
                      onClick={() => set({ fit: 'contain' })}
                      title="Show the whole image, letterboxed if needed"
                    >
                      Fit inside
                    </button>
                    <button
                      className={opts.fit === 'cover' ? 'on' : ''}
                      onClick={() => set({ fit: 'cover' })}
                      title="Fill the page, cropping the overflow"
                    >
                      Fill page
                    </button>
                  </div>
                </>
              )}

              <label>
                Margin <span className="value">{opts.margin} pt</span>
              </label>
              <input
                type="range"
                min={0}
                max={72}
                step={2}
                value={opts.margin}
                onChange={(e) => set({ margin: Number(e.target.value) })}
              />
            </div>

            <div className="image-preview">
              <div className="preview-page" style={{ aspectRatio: String(pageRatio) }}>
                {first && (
                  <img
                    src={first.url}
                    alt=""
                    style={{
                      inset: `${opts.margin / 5}%`,
                      objectFit: opts.pageSize === 'fit' ? 'contain' : opts.fit,
                    }}
                  />
                )}
              </div>
              <span className="hint">Preview</span>
            </div>
          </div>
        </div>

        <footer>
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={!chosen.length}
            onClick={() => onConfirm(chosen, opts)}
          >
            <Icon name="plus" /> Add {chosen.length} page{chosen.length === 1 ? '' : 's'}
          </button>
        </footer>
      </div>
    </div>
  )
}
