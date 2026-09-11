import { create } from 'zustand'
import { openWithPdfjs } from '../lib/pdfjs'
import { uid } from '../lib/uid'
import {
  fileTooLargeMessage,
  heavyTotalBytes,
  maxTotalBytes,
  maxFileBytes,
  totalTooLargeMessage,
} from '../lib/limits'
import {
  DEFAULT_IMAGE_OPTIONS,
  decodeImageFile,
  imageFileToPdfPage,
  isImageFile,
  type ImagePageOptions,
} from '../lib/image'
import type {
  Annotation,
  FontKey,
  PageItem,
  SourceDoc,
  StoredImage,
  Tool,
} from '../lib/types'

export interface ToolDefaults {
  color: string
  fill: string | null
  strokeWidth: number
  opacity: number
  fontSize: number
  font: FontKey
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  highlightColor: string
}

interface Snapshot {
  pages: PageItem[]
  annotations: Record<string, Annotation[]>
}

export interface Busy {
  label: string
  done: number
  total: number
}

interface State extends Snapshot {
  sources: Map<string, SourceDoc>
  images: Map<string, StoredImage>
  currentPageId: string | null
  selectedPageIds: string[]
  selectedAnnId: string | null
  tool: Tool
  defaults: ToolDefaults
  zoom: number
  busy: Busy | null
  error: string | null
  /** non-fatal information the user should see, e.g. pages that had to be flattened */
  notice: string | null
  past: Snapshot[]
  future: Snapshot[]

  addFiles: (
    files: File[],
    insertAt?: number,
    imageOptions?: ImagePageOptions,
  ) => Promise<void>
  addImageAsset: (file: File) => Promise<StoredImage>
  setTool: (t: Tool) => void
  setDefaults: (d: Partial<ToolDefaults>) => void
  setZoom: (z: number) => void
  setBusy: (b: Busy | null) => void
  setError: (e: string | null) => void
  setNotice: (n: string | null) => void

  selectPage: (id: string, opts?: { additive?: boolean; range?: boolean }) => void
  setCurrentPage: (id: string) => void
  selectAll: () => void
  clearPageSelection: () => void

  rotatePages: (ids: string[], deltaCw: number) => void
  deletePages: (ids: string[]) => void
  duplicatePages: (ids: string[]) => void
  movePages: (ids: string[], toIndex: number) => void
  addBlankPage: (afterIndex: number) => void

  selectAnnotation: (id: string | null) => void
  addAnnotation: (a: Annotation) => void
  updateAnnotation: (id: string, patch: Partial<Annotation>, coalesce?: boolean) => void
  deleteAnnotation: (id: string) => void
  bringToFront: (id: string) => void
  sendToBack: (id: string) => void

  undo: () => void
  redo: () => void
  resetAll: () => void
}

const HISTORY_LIMIT = 60

function snapshot(s: State): Snapshot {
  return { pages: s.pages, annotations: s.annotations }
}

/** Push the pre-change state onto the undo stack. */
function withHistory(s: State): Pick<State, 'past' | 'future'> {
  return { past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT), future: [] }
}

function findAnnotation(
  annotations: Record<string, Annotation[]>,
  id: string,
): { pageId: string; index: number } | null {
  for (const [pageId, list] of Object.entries(annotations)) {
    const index = list.findIndex((a) => a.id === id)
    if (index !== -1) return { pageId, index }
  }
  return null
}

export const useStore = create<State>((set, get) => ({
  pages: [],
  annotations: {},
  sources: new Map(),
  images: new Map(),
  currentPageId: null,
  selectedPageIds: [],
  selectedAnnId: null,
  tool: 'select',
  defaults: {
    color: '#d92d20',
    fill: null,
    strokeWidth: 2,
    opacity: 1,
    fontSize: 14,
    font: 'Helvetica',
    bold: false,
    italic: false,
    align: 'left',
    highlightColor: '#ffe25a',
  },
  zoom: 1,
  busy: null,
  error: null,
  notice: null,
  past: [],
  future: [],

  async addFiles(files, insertAt, imageOptions) {
    const accepted = files.filter(
      (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name) || isImageFile(f),
    )
    if (!accepted.length) {
      set({ error: 'Only PDFs and image files can be added.' })
      return
    }

    const oversized = accepted.filter((f) => f.size > maxFileBytes())
    const withinLimit = accepted.filter((f) => f.size <= maxFileBytes())
    const alreadyOpen = [...get().sources.values()].reduce((n, s) => n + s.bytes.byteLength, 0)
    const incoming = withinLimit.reduce((n, f) => n + f.size, 0)
    if (alreadyOpen + incoming > maxTotalBytes()) {
      set({ error: totalTooLargeMessage(), busy: null })
      return
    }
    if (!withinLimit.length) {
      set({ error: fileTooLargeMessage(oversized[0].name, oversized[0].size), busy: null })
      return
    }

    set({
      busy: { label: 'Reading files', done: 0, total: withinLimit.length },
      error: null,
      notice: null,
    })
    const newSources: SourceDoc[] = []
    const newPages: PageItem[] = []
    const failures: string[] = oversized.map((f) => fileTooLargeMessage(f.name, f.size))
    const flattened: string[] = []

    for (const [i, file] of withinLimit.entries()) {
      try {
        const isImage = isImageFile(file)
        const bytes = isImage
          ? await imageFileToPdfPage(file, imageOptions ?? DEFAULT_IMAGE_OPTIONS)
          : new Uint8Array(await file.arrayBuffer())
        const proxy = await openWithPdfjs(bytes)
        // pdf.js is far more forgiving than pdf-lib, so a file can display fine
        // yet be impossible to copy page-for-page on export. Find out now
        // instead of at download time.
        let vectorOk = true
        try {
          const { PDFDocument } = await import('pdf-lib')
          const probe = await PDFDocument.load(bytes, {
            ignoreEncryption: true,
            throwOnInvalidObject: false,
          })
          probe.getPageCount()
        } catch {
          vectorOk = false
          flattened.push(file.name)
        }
        const src: SourceDoc = {
          id: uid(),
          name: file.name,
          bytes,
          proxy,
          pageCount: proxy.numPages,
          vectorOk,
        }
        newSources.push(src)
        for (let p = 1; p <= proxy.numPages; p++) {
          const view = (await proxy.getPage(p)).getViewport({ scale: 1 })
          newPages.push({
            id: uid(),
            srcId: src.id,
            srcIndex: p - 1,
            rotate: 0,
            baseWidth: view.width,
            baseHeight: view.height,
          })
        }
      } catch (err) {
        failures.push(`${file.name}: ${err instanceof Error ? err.message : 'could not be read'}`)
      }
      set({ busy: { label: 'Reading files', done: i + 1, total: withinLimit.length } })
    }

    set((s) => {
      const sources = new Map(s.sources)
      for (const src of newSources) sources.set(src.id, src)
      const at = insertAt ?? s.pages.length
      const pages = [...s.pages.slice(0, at), ...newPages, ...s.pages.slice(at)]
      return {
        ...withHistory(s),
        sources,
        pages,
        currentPageId: s.currentPageId ?? newPages[0]?.id ?? null,
        busy: null,
        error: failures.length
          ? failures.length === 1
            ? failures[0]
            : `Skipped ${failures.length} files. ${failures[0]}`
          : null,
        notice: flattened.length
          ? `${flattened.join(', ')} ${flattened.length > 1 ? 'have' : 'has'} damaged internal structure. ` +
            'It opens fine here, but its pages will be exported as images rather than editable text.'
          : alreadyOpen + incoming > heavyTotalBytes()
            ? 'That is a lot of open data — exporting and compressing may take a while and will use a lot of memory.'
            : null,
      }
    })
  },

  async addImageAsset(file) {
    const { bytes, mime, width, height } = await decodeImageFile(file)
    const buf = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buf).set(bytes)
    const url = URL.createObjectURL(new Blob([buf], { type: mime }))
    const stored: StoredImage = { id: uid(), bytes, mime, url, width, height }
    set((s) => {
      const images = new Map(s.images)
      images.set(stored.id, stored)
      return { images }
    })
    return stored
  },

  setTool: (tool) => set({ tool, selectedAnnId: tool === 'select' ? get().selectedAnnId : null }),
  setDefaults: (d) => set((s) => ({ defaults: { ...s.defaults, ...d } })),
  setZoom: (zoom) => set({ zoom: Math.min(4, Math.max(0.15, zoom)) }),
  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),

  selectPage(id, opts = {}) {
    const { pages, selectedPageIds, currentPageId } = get()
    if (opts.additive) {
      const next = selectedPageIds.includes(id)
        ? selectedPageIds.filter((p) => p !== id)
        : [...selectedPageIds, id]
      set({ selectedPageIds: next, currentPageId: id })
      return
    }
    if (opts.range && currentPageId) {
      const a = pages.findIndex((p) => p.id === currentPageId)
      const b = pages.findIndex((p) => p.id === id)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        set({ selectedPageIds: pages.slice(lo, hi + 1).map((p) => p.id), currentPageId: id })
        return
      }
    }
    set({ selectedPageIds: [id], currentPageId: id, selectedAnnId: null })
  },

  setCurrentPage: (id) => set({ currentPageId: id, selectedAnnId: null }),
  selectAll: () => set((s) => ({ selectedPageIds: s.pages.map((p) => p.id) })),
  clearPageSelection: () => set({ selectedPageIds: [] }),

  rotatePages(ids, deltaCw) {
    if (!ids.length) return
    set((s) => ({
      ...withHistory(s),
      pages: s.pages.map((p) =>
        ids.includes(p.id)
          ? { ...p, rotate: ((((p.rotate + deltaCw) % 360) + 360) % 360) as PageItem['rotate'] }
          : p,
      ),
    }))
  },

  deletePages(ids) {
    if (!ids.length) return
    set((s) => {
      const pages = s.pages.filter((p) => !ids.includes(p.id))
      const annotations = { ...s.annotations }
      for (const id of ids) delete annotations[id]
      const removedIndex = s.pages.findIndex((p) => p.id === s.currentPageId)
      const fallback = pages[Math.min(removedIndex, pages.length - 1)] ?? pages[0] ?? null
      return {
        ...withHistory(s),
        pages,
        annotations,
        selectedPageIds: s.selectedPageIds.filter((p) => !ids.includes(p)),
        currentPageId:
          s.currentPageId && ids.includes(s.currentPageId)
            ? (fallback?.id ?? null)
            : s.currentPageId,
        selectedAnnId: null,
      }
    })
  },

  duplicatePages(ids) {
    if (!ids.length) return
    set((s) => {
      const pages: PageItem[] = []
      const annotations = { ...s.annotations }
      for (const p of s.pages) {
        pages.push(p)
        if (ids.includes(p.id)) {
          const copy: PageItem = { ...p, id: uid() }
          pages.push(copy)
          const anns = s.annotations[p.id]
          if (anns?.length) {
            annotations[copy.id] = anns.map((a) => ({ ...a, id: uid(), pageId: copy.id }))
          }
        }
      }
      return { ...withHistory(s), pages, annotations }
    })
  },

  movePages(ids, toIndex) {
    if (!ids.length) return
    set((s) => {
      const moving = s.pages.filter((p) => ids.includes(p.id))
      if (!moving.length) return {}
      const rest = s.pages.filter((p) => !ids.includes(p.id))
      // toIndex refers to a slot in the original list; shift it by the number of
      // moved pages that sat before it so the drop lands where the user aimed.
      const before = s.pages.slice(0, toIndex).filter((p) => ids.includes(p.id)).length
      const at = Math.max(0, Math.min(rest.length, toIndex - before))
      return {
        ...withHistory(s),
        pages: [...rest.slice(0, at), ...moving, ...rest.slice(at)],
      }
    })
  },

  addBlankPage(afterIndex) {
    const { pages, sources } = get()
    const template = pages[afterIndex]
    const size = template
      ? template.rotate % 180 === 90
        ? { w: template.baseHeight, h: template.baseWidth }
        : { w: template.baseWidth, h: template.baseHeight }
      : { w: 595.28, h: 841.89 }

    void (async () => {
      const { PDFDocument } = await import('pdf-lib')
      const doc = await PDFDocument.create()
      doc.addPage([size.w, size.h])
      const bytes = await doc.save()
      const proxy = await openWithPdfjs(bytes)
      const src: SourceDoc = {
        id: uid(),
        name: 'Blank page',
        bytes,
        proxy,
        pageCount: 1,
        vectorOk: true,
      }
      const page: PageItem = {
        id: uid(),
        srcId: src.id,
        srcIndex: 0,
        rotate: 0,
        baseWidth: size.w,
        baseHeight: size.h,
      }
      set((s) => {
        const next = new Map(s.sources)
        next.set(src.id, src)
        const at = Math.min(afterIndex + 1, s.pages.length)
        return {
          ...withHistory(s),
          sources: next,
          pages: [...s.pages.slice(0, at), page, ...s.pages.slice(at)],
          currentPageId: page.id,
        }
      })
    })()
    void sources
  },

  selectAnnotation: (selectedAnnId) => set({ selectedAnnId }),

  addAnnotation(a) {
    set((s) => ({
      ...withHistory(s),
      annotations: { ...s.annotations, [a.pageId]: [...(s.annotations[a.pageId] ?? []), a] },
      selectedAnnId: a.id,
    }))
  },

  /**
   * `coalesce` merges into the previous history entry — used while dragging so
   * one gesture is one undo step.
   */
  updateAnnotation(id, patch, coalesce = false) {
    set((s) => {
      const found = findAnnotation(s.annotations, id)
      if (!found) return {}
      const list = s.annotations[found.pageId]
      const next = [...list]
      next[found.index] = { ...next[found.index], ...patch } as Annotation
      return {
        ...(coalesce ? { past: s.past, future: [] } : withHistory(s)),
        annotations: { ...s.annotations, [found.pageId]: next },
      }
    })
  },

  deleteAnnotation(id) {
    set((s) => {
      const found = findAnnotation(s.annotations, id)
      if (!found) return {}
      return {
        ...withHistory(s),
        annotations: {
          ...s.annotations,
          [found.pageId]: s.annotations[found.pageId].filter((a) => a.id !== id),
        },
        selectedAnnId: s.selectedAnnId === id ? null : s.selectedAnnId,
      }
    })
  },

  bringToFront(id) {
    set((s) => {
      const found = findAnnotation(s.annotations, id)
      if (!found) return {}
      const list = s.annotations[found.pageId]
      const item = list[found.index]
      return {
        ...withHistory(s),
        annotations: {
          ...s.annotations,
          [found.pageId]: [...list.filter((a) => a.id !== id), item],
        },
      }
    })
  },

  sendToBack(id) {
    set((s) => {
      const found = findAnnotation(s.annotations, id)
      if (!found) return {}
      const list = s.annotations[found.pageId]
      const item = list[found.index]
      return {
        ...withHistory(s),
        annotations: {
          ...s.annotations,
          [found.pageId]: [item, ...list.filter((a) => a.id !== id)],
        },
      }
    })
  },

  undo() {
    set((s) => {
      const prev = s.past.at(-1)
      if (!prev) return {}
      return {
        past: s.past.slice(0, -1),
        future: [snapshot(s), ...s.future].slice(0, HISTORY_LIMIT),
        pages: prev.pages,
        annotations: prev.annotations,
        selectedAnnId: null,
        currentPageId: prev.pages.some((p) => p.id === s.currentPageId)
          ? s.currentPageId
          : (prev.pages[0]?.id ?? null),
      }
    })
  },

  redo() {
    set((s) => {
      const next = s.future[0]
      if (!next) return {}
      return {
        past: [...s.past, snapshot(s)].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        pages: next.pages,
        annotations: next.annotations,
        selectedAnnId: null,
        currentPageId: next.pages.some((p) => p.id === s.currentPageId)
          ? s.currentPageId
          : (next.pages[0]?.id ?? null),
      }
    })
  },

  resetAll() {
    const { sources, images } = get()
    for (const s of sources.values()) void s.proxy.destroy()
    for (const i of images.values()) URL.revokeObjectURL(i.url)
    set({
      pages: [],
      annotations: {},
      sources: new Map(),
      images: new Map(),
      currentPageId: null,
      selectedPageIds: [],
      selectedAnnId: null,
      past: [],
      future: [],
      error: null,
      notice: null,
      busy: null,
    })
  },
}))
