import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from './state/store'
import { PageList } from './components/PageList'
import { PageView } from './components/PageView'
import { Properties } from './components/Properties'
import { CompressDialog } from './components/CompressDialog'
import { ShrinkDialog } from './components/ShrinkDialog'
import { OcrDialog } from './components/OcrDialog'
import { ImagesDialog } from './components/ImagesDialog'
import { Icon } from './components/Icon'
import { Landing } from './components/Landing'
import {
  ExportImagesDialog,
  PageNumbersDialog,
  PasswordPromptDialog,
  ProtectDialog,
  SplitDialog,
  WatermarkDialog,
  type ToolDialog,
} from './components/ToolsDialogs'
import { displaySize, formatBytes } from './lib/geometry'
import type { ImageAnn, Tool } from './lib/types'
import type { FallbackPage } from './lib/export'
import { IMAGE_ACCEPT, isImageFile, type ImagePageOptions } from './lib/image'
import { maxFileBytes } from './lib/limits'
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

const SignatureDialog = lazy(() =>
  import('./components/SignatureDialog').then((m) => ({ default: m.SignatureDialog })),
)

const TOOLS: Array<{ id: Tool; icon: string; label: string; key: string }> = [
  { id: 'select', icon: 'select', label: 'Select & move / fill forms', key: 'V' },
  { id: 'text', icon: 'text', label: 'Add text', key: 'T' },
  { id: 'edittext', icon: 'textEdit', label: 'Edit existing text', key: 'E' },
  { id: 'signature', icon: 'signature', label: 'Signature', key: 'S' },
  { id: 'ink', icon: 'ink', label: 'Draw', key: 'D' },
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
    stamps,
    formValues,
  } = store

  const [showCompress, setShowCompress] = useState(false)
  /** A PDF too big for the editor, or one picked explicitly for shrinking. */
  const [shrinkFile, setShrinkFile] = useState<File | null>(null)
  const [showOcr, setShowOcr] = useState(false)
  const [imageQueue, setImageQueue] = useState<File[] | null>(null)
  const [toolDialog, setToolDialog] = useState<ToolDialog | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [showSignature, setShowSignature] = useState(false)
  /** On narrow screens the side panels become drawers; null means both closed. */
  const [panel, setPanel] = useState<'pages' | 'props' | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const shrinkInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const pageImageInput = useRef<HTMLInputElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  /**
   * PDFs are merged straight away; images go through the dialog so their page
   * size and scaling can be chosen before they become pages. A PDF too big for
   * the editor is not an error — shrinking it is almost always why someone
   * brought a file that size here, so it goes to the compressor instead.
   */
  function intake(files: File[]) {
    const pdfs = files.filter((f) => !isImageFile(f))
    const imgs = files.filter(isImageFile)
    const huge = pdfs.filter((f) => f.size > maxFileBytes())
    const rest = pdfs.filter((f) => f.size <= maxFileBytes())
    if (huge.length) setShrinkFile(huge[0])
    if (rest.length) void store.addFiles(rest)
    if (imgs.length) setImageQueue(imgs)
  }

  const filename = useMemo(() => {
    const first = pages[0] && sources.get(pages[0].srcId)?.name
    // Sources can be images too ("photo.png"), so strip whatever extension it has.
    return first ? first.replace(/\.[a-z0-9]{1,5}$/i, '') + '-edited.pdf' : 'document.pdf'
  }, [pages, sources])

  // Page actions apply to the multi-selection only while the page on screen is
  // part of it. Otherwise a selection made earlier (then left behind by moving
  // to another page) would be what Delete or Rotate silently acts on.
  const targets =
    currentPageId && selectedPageIds.includes(currentPageId)
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
        stamps,
        formValues,
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
        stamps,
        formValues,
        onFallback: (bad) => store.setNotice(describeFallback(bad)),
      })
      downloadBytes(bytes, filename.replace(/\.pdf$/i, '') + `-${chosen.length}-pages.pdf`)
    } catch (err) {
      store.setError(err instanceof Error ? err.message : 'Extract failed.')
    } finally {
      store.setBusy(null)
    }
  }

  async function placeImage(file: File, opts: { maxWidth?: number } = {}) {
    const page = pages[currentIndex]
    if (!page) return
    try {
      const stored = await store.addImageAsset(file)
      const maxW = Math.min(opts.maxWidth ?? Infinity, page.baseWidth * 0.5)
      const scale = Math.min(maxW / stored.width, (page.baseHeight * 0.5) / stored.height, 1)
      const w = stored.width * scale
      const h = stored.height * scale
      // Step each new image down-right if one already sits at the centre, so a
      // second signature doesn't land exactly on top of the first.
      let x = (page.baseWidth - w) / 2
      let y = (page.baseHeight - h) / 2
      const taken = (annotations[page.id] ?? []).filter((a) => a.kind === 'image')
      while (taken.some((a) => Math.abs(a.x - x) < 4 && Math.abs(a.y - y) < 4) && y + h < page.baseHeight - 24) {
        x += 18
        y += 24
      }
      const ann: ImageAnn = {
        id: uid(),
        pageId: page.id,
        kind: 'image',
        x,
        y,
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
    if (id === 'signature') {
      setShowSignature(true)
      return
    }
    store.setTool(id)
  }

  /** Moves the page(s) being worked on one place up or down. */
  function nudgePages(dir: -1 | 1) {
    if (!targets.length) return
    const idx = targets.map((id) => pages.findIndex((p) => p.id === id)).filter((i) => i >= 0)
    const first = Math.min(...idx)
    const last = Math.max(...idx)
    if (dir < 0 && first > 0) store.movePages(targets, first - 1)
    if (dir > 0 && last < pages.length - 1) store.movePages(targets, last + 2)
  }

  // Tell people when a file has fillable fields — it's easy to miss otherwise.
  const formChecked = useRef(new Set<string>())
  useEffect(() => {
    for (const src of sources.values()) {
      if (formChecked.current.has(src.id) || src.generated) continue
      formChecked.current.add(src.id)
      void import('./lib/forms').then(async ({ hasForm }) => {
        if (await hasForm(src.proxy)) {
          store.setNotice(
            `${src.name} has fillable form fields. Click a field to type in it (Select tool); your answers are saved into the PDF you download.`,
          )
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources])

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
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault()
        nudgePages(e.key === 'ArrowUp' ? -1 : 1)
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
        } else if (targets.length) {
          e.preventDefault()
          store.deletePages(targets)
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

  /** Files the user actually opened that still have pages in the document. */
  const openedFiles = useMemo(() => {
    const used = new Set(pages.map((p) => p.srcId))
    return [...sources.values()].filter((s) => !s.generated && used.has(s.id))
  }, [pages, sources])
  const totalSize = openedFiles.reduce((n, s) => n + s.bytes.byteLength, 0)

  // Open new documents at a size that fits the window (never above 100%), so a
  // landscape page on a laptop or any page on a phone isn't cut off. The zoom
  // buttons are hidden on phones, so this is their only way to see a full page.
  const hadPages = useRef(false)
  useEffect(() => {
    if (!pages.length) {
      hadPages.current = false
      return
    }
    if (hadPages.current) return
    hadPages.current = true
    const page = pages.find((p) => p.id === currentPageId) ?? pages[0]
    requestAnimationFrame(() => {
      const el = stageRef.current
      if (!el) return
      const d = displaySize(page)
      store.setZoom(Math.min(1, (el.clientWidth - 40) / d.w))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length])

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report the same way)
  // zooms the page instead of the whole browser window.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const { zoom: z, setZoom } = useStore.getState()
      setZoom(z * Math.exp(-e.deltaY * 0.0025))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [pages.length > 0])

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
        ref={shrinkInput}
        type="file"
        accept="application/pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) setShrinkFile(file)
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

      {pages.length > 0 && (
        <header className="topbar">
          <div className="brand">
            <Icon name="files" size={18} />
            <span>PDF Editor</span>
          </div>

          <div className="group">
            <button className="primary" onClick={() => fileInput.current?.click()} title="Add files">
              <Icon name="plus" /> <span className="btn-label">{pages.length ? 'Add files' : 'Open PDFs'}</span>
            </button>
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
            <div className="doc-stats" title="Combined size of the files you opened, before edits">
              {pages.length} page{pages.length > 1 ? 's' : ''} · {openedFiles.length} file
              {openedFiles.length === 1 ? '' : 's'} · {formatBytes(totalSize)} opened
            </div>
          )}

          <div className="group tools-menu">
            <button
              className={toolsOpen ? 'on' : ''}
              onClick={() => setToolsOpen(!toolsOpen)}
              title="More tools"
              aria-haspopup="menu"
              aria-expanded={toolsOpen}
            >
              <Icon name="tools" /> <span className="btn-label">Tools</span>
              <span className="btn-label chev">
                <Icon name="chevron" size={12} />
              </span>
            </button>
            {toolsOpen && (
              <>
                <div className="menu-scrim" onClick={() => setToolsOpen(false)} />
                <div className="menu" role="menu">
                  {(
                    [
                      ['pageNumbers', 'hash', 'Page numbers', stamps.pageNumbers ? 'On' : ''],
                      ['watermark', 'stamp', 'Watermark', stamps.watermark ? 'On' : ''],
                      ['split', 'split', 'Split into files', ''],
                      ['images', 'image', 'Save pages as images', ''],
                      ['protect', 'lock', 'Protect with password', ''],
                    ] as Array<[ToolDialog, string, string, string]>
                  ).map(([id, icon, label, badge]) => (
                    <button
                      key={id}
                      role="menuitem"
                      onClick={() => {
                        setToolsOpen(false)
                        setToolDialog(id)
                      }}
                    >
                      <Icon name={icon} /> {label}
                      {badge && <span className="menu-badge">{badge}</span>}
                    </button>
                  ))}
                  <button
                    role="menuitem"
                    className="compact-menu-only"
                    onClick={() => {
                      setToolsOpen(false)
                      shrinkInput.current?.click()
                    }}
                  >
                    <Icon name="file" /> Shrink a large file
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="group">
            <button onClick={() => setShowOcr(true)} disabled={!pages.length} title="Make scanned pages searchable">
              <Icon name="ocr" /> <span className="btn-label">Make searchable</span>
            </button>
            <button onClick={() => setShowCompress(true)} disabled={!pages.length} title="Compress">
              <Icon name="compress" /> <span className="btn-label">Compress</span>
            </button>
            {/* Hidden on phones: a phone browser can't finish a large-file shrink anyway. */}
            <button
              className="hide-phone"
              onClick={() => shrinkInput.current?.click()}
              title="Shrink a file too big to open here"
            >
              <Icon name="file" /> <span className="btn-label">Large file</span>
            </button>
            <button className="primary" onClick={download} disabled={!pages.length} title="Download">
              <Icon name="download" /> <span className="btn-label">Download</span>
            </button>
          </div>
        </header>
      )}

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
        <Landing
          onChooseFiles={() => fileInput.current?.click()}
          onImagesToPdf={() => pageImageInput.current?.click()}
          onShrinkBigPdf={() => shrinkInput.current?.click()}
        />
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

      {toolDialog === 'pageNumbers' && <PageNumbersDialog onClose={() => setToolDialog(null)} />}
      {toolDialog === 'watermark' && <WatermarkDialog onClose={() => setToolDialog(null)} />}
      {toolDialog === 'split' && <SplitDialog filename={filename} onClose={() => setToolDialog(null)} />}
      {toolDialog === 'images' && <ExportImagesDialog filename={filename} onClose={() => setToolDialog(null)} />}
      {toolDialog === 'protect' && <ProtectDialog filename={filename} onClose={() => setToolDialog(null)} />}

      {showSignature && (
        <Suspense
          fallback={
            <div className="busy">
              <div className="busy-card">
                <div className="spinner" />
                <span>Opening signature pad</span>
              </div>
            </div>
          }
        >
          <SignatureDialog
            onClose={() => setShowSignature(false)}
            onPlace={(file) => {
              setShowSignature(false)
              void placeImage(file, { maxWidth: 190 })
            }}
          />
        </Suspense>
      )}

      <PasswordPromptDialog />

      {shrinkFile && <ShrinkDialog file={shrinkFile} onClose={() => setShrinkFile(null)} />}

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
