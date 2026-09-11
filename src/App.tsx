import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from './state/store'
import { PageList } from './components/PageList'
import { PageView } from './components/PageView'
import { Properties } from './components/Properties'
import { CompressDialog } from './components/CompressDialog'
import { OcrDialog } from './components/OcrDialog'
import { ImagesDialog } from './components/ImagesDialog'
import { Icon } from './components/Icon'
import { displaySize, formatBytes } from './lib/geometry'
import type { ImageAnn, Tool } from './lib/types'
import type { FallbackPage } from './lib/export'
import { IMAGE_ACCEPT, isImageFile, type ImagePageOptions } from './lib/image'
import { uid } from './lib/uid'

/** Explains which pages had to be flattened to images, and why. */
function describeFallback(bad: FallbackPage[]): string {
  const files = [...new Set(bad.map((b) => b.fileName))]
  const numbers = bad.map((b) => b.pageNumber).join(', ')
  return (
    `Page${bad.length > 1 ? 's' : ''} ${numbers} could not be copied as text — ` +
    `${files.join(', ')} ${files.length > 1 ? 'have' : 'has'} damaged internal structure. ` +
    'Those pages were exported as images instead, so they look right but are no longer selectable.'
  )
}

const TOOLS: Array<{ id: Tool; icon: string; label: string; key: string }> = [
  { id: 'select', icon: 'select', label: 'Select & move', key: 'V' },
  { id: 'text', icon: 'text', label: 'Text box', key: 'T' },
  { id: 'ink', icon: 'ink', label: 'Draw / sign', key: 'D' },
  { id: 'highlight', icon: 'highlight', label: 'Highlight', key: 'H' },
  { id: 'rect', icon: 'rect', label: 'Rectangle', key: 'R' },
  { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', key: 'O' },
  { id: 'line', icon: 'line', label: 'Line', key: 'L' },
  { id: 'whiteout', icon: 'whiteout', label: 'Whiteout / redact', key: 'W' },
  { id: 'image', icon: 'image', label: 'Place image', key: 'I' },
]

export default function App() {
  const store = useStore()
  const {
    pages,
    sources,
    annotations,
    images,
    selectedPageIds,
    currentPageId,
    tool,
    zoom,
    busy,
    error,
    notice,
  } = store

  const [showCompress, setShowCompress] = useState(false)
  const [showOcr, setShowOcr] = useState(false)
  const [imageQueue, setImageQueue] = useState<File[] | null>(null)
  /** On narrow screens the side panels become drawers; null means both closed. */
  const [panel, setPanel] = useState<'pages' | 'props' | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const pageImageInput = useRef<HTMLInputElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  /**
   * PDFs are merged straight away; images go through the dialog so their page
   * size and scaling can be chosen before they become pages.
   */
  function intake(files: File[]) {
    const pdfs = files.filter((f) => !isImageFile(f))
    const imgs = files.filter(isImageFile)
    if (pdfs.length) void store.addFiles(pdfs)
    if (imgs.length) setImageQueue(imgs)
  }

  const filename = useMemo(() => {
    const first = pages[0] && sources.get(pages[0].srcId)?.name
    return first ? first.replace(/\.pdf$/i, '') + '-edited.pdf' : 'document.pdf'
  }, [pages, sources])

  const targets = selectedPageIds.length
    ? selectedPageIds
    : currentPageId
      ? [currentPageId]
      : []

  const currentIndex = pages.findIndex((p) => p.id === currentPageId)

  const fitZoom = useCallback(() => {
    const page = pages[currentIndex]
    const el = stageRef.current
    if (!page || !el) return
    const d = displaySize(page)
    store.setZoom(Math.min((el.clientWidth - 80) / d.w, (el.clientHeight - 80) / d.h))
  }, [pages, currentIndex, store])

  async function download() {
    if (!pages.length) return
    store.setBusy({ label: 'Building PDF', done: 0, total: pages.length })
    try {
      const { buildPdf, downloadBytes } = await import('./lib/export')
      const bytes = await buildPdf(pages, sources, annotations, images, {
        onProgress: (done, total) => store.setBusy({ label: 'Building PDF', done, total }),
        onFallback: (bad) => store.setNotice(describeFallback(bad)),
      })
      downloadBytes(bytes, filename)
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Export failed.')
    } finally {
      store.setBusy(null)
    }
  }

  async function extractSelection() {
    const chosen = pages.filter((p) => selectedPageIds.includes(p.id))
    if (!chosen.length) return
    store.setBusy({ label: 'Extracting', done: 0, total: chosen.length })
    try {
      const { buildPdf, downloadBytes } = await import('./lib/export')
      const bytes = await buildPdf(chosen, sources, annotations, images, {
        onFallback: (bad) => store.setNotice(describeFallback(bad)),
      })
      downloadBytes(bytes, filename.replace(/\.pdf$/i, '') + `-${chosen.length}-pages.pdf`)
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Extract failed.')
    } finally {
      store.setBusy(null)
    }
  }

  async function placeImage(file: File) {
    const page = pages[currentIndex]
    if (!page) return
    try {
      const stored = await store.addImageAsset(file)
      const maxW = page.baseWidth * 0.5
      const scale = Math.min(maxW / stored.width, (page.baseHeight * 0.5) / stored.height, 1)
      const w = stored.width * scale
      const h = stored.height * scale
      const ann: ImageAnn = {
        id: uid(),
        pageId: page.id,
        kind: 'image',
        x: (page.baseWidth - w) / 2,
        y: (page.baseHeight - h) / 2,
        w,
        h,
        imageId: stored.id,
        opacity: 1,
      }
      store.addAnnotation(ann)
      store.setTool('select')
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'That image could not be placed.')
    }
  }

  function pickTool(id: Tool) {
    if (id === 'image') {
      imageInput.current?.click()
      return
    }
    store.setTool(id)
  }

  useEffect(() => {
    if (panel === 'pages') setPanel(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPageId])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? store.redo() : store.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void download()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        store.selectAll()
        return
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        store.setZoom(zoom * 1.2)
        return
      }
      if (mod && e.key === '-') {
        e.preventDefault()
        store.setZoom(zoom / 1.2)
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selectedAnnId) {
          e.preventDefault()
          store.deleteAnnotation(store.selectedAnnId)
        } else if (selectedPageIds.length) {
          e.preventDefault()
          store.deletePages(selectedPageIds)
        }
        return
      }
      if (e.key === 'Escape') {
        store.selectAnnotation(null)
        store.setTool('select')
        return
      }
      if (!mod && !e.altKey) {
        const hit = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase())
        if (hit) {
          e.preventDefault()
          pickTool(hit.id)
          return
        }
        if ((e.key === 'ArrowDown' || e.key === 'PageDown') && currentIndex < pages.length - 1) {
          e.preventDefault()
          store.selectPage(pages[currentIndex + 1].id)
        }
        if ((e.key === 'ArrowUp' || e.key === 'PageUp') && currentIndex > 0) {
          e.preventDefault()
          store.selectPage(pages[currentIndex - 1].id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const totalSize = useMemo(
    () => [...sources.values()].reduce((n, s) => n + s.bytes.byteLength, 0),
    [sources],
  )

  return (
    <div
      className={`app${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragOver(false)
        intake([...e.dataTransfer.files])
      }}
    >
      <header className="topbar">
        <div className="brand">
          <Icon name="files" size={18} />
          <span>PDF Editor</span>
        </div>

        <div className="group">
          <button className="primary" onClick={() => fileInput.current?.click()}>
            <Icon name="plus" /> {pages.length ? 'Add files' : 'Open PDFs'}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={`application/pdf,${IMAGE_ACCEPT}`}
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length) intake(files)
            }}
          />
          <input
            ref={imageInput}
            type="file"
            accept={IMAGE_ACCEPT}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void placeImage(file)
            }}
          />
          <input
            ref={pageImageInput}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])]
              e.target.value = ''
              if (files.length) setImageQueue(files)
            }}
          />
        </div>

        {pages.length > 0 && (
          <div className="group compact-only">
            <button
              className={panel === 'pages' ? 'on' : ''}
              onClick={() => setPanel(panel === 'pages' ? null : 'pages')}
              title="Pages"
            >
              <Icon name="files" />
            </button>
            <button
              className={panel === 'props' ? 'on' : ''}
              onClick={() => setPanel(panel === 'props' ? null : 'props')}
              title="Properties"
            >
              <Icon name="edit" />
            </button>
          </div>
        )}

        <div className="group">
          <button onClick={store.undo} disabled={!store.past.length} title="Undo (Ctrl+Z)">
            <Icon name="undo" />
          </button>
          <button onClick={store.redo} disabled={!store.future.length} title="Redo (Ctrl+Shift+Z)">
            <Icon name="redo" />
          </button>
        </div>

        <div className="group">
          <button onClick={() => store.setZoom(zoom / 1.2)} title="Zoom out">
            <Icon name="zoomOut" />
          </button>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <button onClick={() => store.setZoom(zoom * 1.2)} title="Zoom in">
            <Icon name="zoomIn" />
          </button>
          <button onClick={fitZoom} title="Fit page">
            <Icon name="fit" />
          </button>
        </div>

        <div className="spacer" />

        {pages.length > 0 && (
          <div className="doc-stats" title="Source bytes currently loaded">
            {pages.length} page{pages.length > 1 ? 's' : ''} · {sources.size} file
            {sources.size > 1 ? 's' : ''} · {formatBytes(totalSize)}
          </div>
        )}

        <div className="group">
          <button onClick={() => setShowOcr(true)} disabled={!pages.length} title="Make scanned pages searchable">
            <Icon name="ocr" /> Make searchable
          </button>
          <button onClick={() => setShowCompress(true)} disabled={!pages.length}>
            <Icon name="compress" /> Compress
          </button>
          <button className="primary" onClick={download} disabled={!pages.length}>
            <Icon name="download" /> Download
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error">
          <Icon name="info" size={14} /> {error}
          <button onClick={() => store.setError(null)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {notice && (
        <div className="banner warn">
          <Icon name="info" size={14} /> {notice}
          <button onClick={() => store.setNotice(null)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}

      {pages.length === 0 ? (
        <main className="empty">
          <div className="empty-card">
            <Icon name="files" size={40} />
            <h1>Edit, merge and compress PDFs</h1>
            <p>
              Drop PDFs or images here, or open them below. Everything runs inside your browser —
              no file ever leaves this device.
            </p>
            <div className="empty-actions">
              <button className="primary big" onClick={() => fileInput.current?.click()}>
                <Icon name="plus" /> Choose files
              </button>
              <button className="ghost big" onClick={() => pageImageInput.current?.click()}>
                <Icon name="image" /> Images to PDF
              </button>
            </div>
            <ul className="features">
              <li>
                <strong>Merge</strong> any number of PDFs, reorder pages by dragging, rotate,
                duplicate, delete or extract them.
              </li>
              <li>
                <strong>Edit</strong> with text boxes, highlights, shapes, freehand signatures,
                images and whiteout.
              </li>
              <li>
                <strong>Convert images</strong> — PNG, JPEG, WebP, AVIF, GIF, BMP or SVG become
                pages at the size, orientation and scaling you pick.
              </li>
              <li>
                <strong>Compress</strong> with presets from “keep text sharp” down to aggressive
                rasterising.
              </li>
            </ul>
            <p className="empty-footer">
              <a href="/privacy.html">Privacy</a> · Your files are processed on this device and are
              never uploaded.
            </p>
          </div>
        </main>
      ) : (
        <main className="workspace">
          <nav className="tool-rail">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={tool === t.id ? 'on' : ''}
                title={`${t.label} (${t.key})`}
                onClick={() => pickTool(t.id)}
              >
                <Icon name={t.icon} size={19} />
              </button>
            ))}
          </nav>

          <aside className={`panel pages-panel${panel === 'pages' ? ' open' : ''}`}>
            <div className="panel-head">
              <span>Pages</span>
              <button className="panel-close" onClick={() => setPanel(null)} title="Close">
                <Icon name="close" size={14} />
              </button>
              <div className="row-actions">
                <button title="Rotate left" onClick={() => store.rotatePages(targets, -90)}>
                  <Icon name="rotateLeft" />
                </button>
                <button title="Rotate right" onClick={() => store.rotatePages(targets, 90)}>
                  <Icon name="rotateRight" />
                </button>
                <button title="Duplicate" onClick={() => store.duplicatePages(targets)}>
                  <Icon name="copy" />
                </button>
                <button
                  title="Insert blank page after"
                  onClick={() => store.addBlankPage(currentIndex)}
                >
                  <Icon name="page" />
                </button>
                <button
                  title="Add images as new pages"
                  onClick={() => pageImageInput.current?.click()}
                >
                  <Icon name="image" />
                </button>
                <button
                  title="Save selected pages as a new PDF"
                  onClick={extractSelection}
                  disabled={!selectedPageIds.length}
                >
                  <Icon name="download" />
                </button>
                <button
                  title="Delete (Del)"
                  className="danger"
                  onClick={() => store.deletePages(targets)}
                >
                  <Icon name="trash" />
                </button>
              </div>
            </div>
            <PageList />
            <div className="panel-foot">
              {selectedPageIds.length
                ? `${selectedPageIds.length} selected`
                : 'Drag to reorder · Ctrl/Shift-click to multi-select'}
            </div>
          </aside>

          <section className="stage" ref={stageRef}>
            <PageView />
          </section>

          <aside className={`panel props-panel${panel === 'props' ? ' open' : ''}`}>
            <button className="panel-close floating" onClick={() => setPanel(null)} title="Close">
              <Icon name="close" size={14} />
            </button>
            <Properties />
          </aside>

          {panel && <div className="scrim" onClick={() => setPanel(null)} />}
        </main>
      )}

      {busy && (
        <div className="busy">
          <div className="busy-card">
            <div className="spinner" />
            <span>
              {busy.label}
              {busy.total > 1 ? ` ${busy.done}/${busy.total}` : ''}
            </span>
          </div>
        </div>
      )}

      {showCompress && (
        <CompressDialog filename={filename} onClose={() => setShowCompress(false)} />
      )}
      {showOcr && <OcrDialog filename={filename} onClose={() => setShowOcr(false)} />}

      {imageQueue && (
        <ImagesDialog
          files={imageQueue}
          onCancel={() => setImageQueue(null)}
          onConfirm={(files: File[], options: ImagePageOptions) => {
            setImageQueue(null)
            void store.addFiles(files, undefined, options)
          }}
        />
      )}
    </div>
  )
}
