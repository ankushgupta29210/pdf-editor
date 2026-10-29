import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { getThumbnail } from '../lib/render'
import type { PageItem } from '../lib/types'
import { Icon } from './Icon'

function Thumb({ page }: { page: PageItem }) {
  const proxy = useStore((s) => s.sources.get(page.srcId)?.proxy)
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!proxy) return
    let alive = true
    getThumbnail(proxy, page.srcId, page.srcIndex)
      .then((u) => alive && setUrl(u))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [proxy, page.srcId, page.srcIndex])

  const swapped = page.rotate % 180 === 90
  const ratio = page.baseWidth / page.baseHeight
  return (
    <div className="thumb-frame" style={{ aspectRatio: String(swapped ? 1 / ratio : ratio) }}>
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{
            transform: `rotate(${page.rotate}deg)`,
            width: swapped ? `${100 / ratio}%` : '100%',
            aspectRatio: String(ratio),
          }}
        />
      ) : (
        <div className="thumb-skeleton" />
      )}
    </div>
  )
}

export function PageList() {
  const pages = useStore((s) => s.pages)
  const annotations = useStore((s) => s.annotations)
  const currentPageId = useStore((s) => s.currentPageId)
  const selectedPageIds = useStore((s) => s.selectedPageIds)
  const selectPage = useStore((s) => s.selectPage)
  const movePages = useStore((s) => s.movePages)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const dragging = useRef<string[]>([])

  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-page-id="${currentPageId}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [currentPageId])

  return (
    <div className="page-list" ref={listRef} onDragLeave={() => setDropIndex(null)}>
      {pages.map((page, i) => {
        const selected = selectedPageIds.includes(page.id)
        const count = annotations[page.id]?.length ?? 0
        return (
          <div
            key={page.id}
            data-page-id={page.id}
            className={`thumb${selected ? ' selected' : ''}${
              page.id === currentPageId ? ' current' : ''
            }`}
            draggable
            onDragStart={(e) => {
              const ids = selected && selectedPageIds.length ? selectedPageIds : [page.id]
              dragging.current = ids
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', 'pages')
            }}
            onDragOver={(e) => {
              if (!dragging.current.length) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const box = e.currentTarget.getBoundingClientRect()
              setDropIndex(e.clientY > box.top + box.height / 2 ? i + 1 : i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              // Work the slot out from the drop event itself: a quick drag can
              // drop before the last dragover's state update has rendered, and
              // then `dropIndex` would still be null and the drop ignored.
              const box = e.currentTarget.getBoundingClientRect()
              const slot = e.clientY > box.top + box.height / 2 ? i + 1 : i
              if (dragging.current.length) movePages(dragging.current, slot)
              dragging.current = []
              setDropIndex(null)
            }}
            onDragEnd={() => {
              dragging.current = []
              setDropIndex(null)
            }}
            onClick={(e) =>
              selectPage(page.id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey })
            }
          >
            {dropIndex === i && <div className="drop-line top" />}
            {dropIndex === i + 1 && <div className="drop-line bottom" />}
            <Thumb page={page} />
            {page.id === currentPageId && pages.length > 1 && (
              // Drag-and-drop is unreliable on phones and fiddly for keyboard
              // users, so the current page also gets explicit move buttons.
              <div className="thumb-move" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  title="Move page up (Alt+↑)"
                  aria-label="Move page up"
                  disabled={i === 0}
                  onClick={() => movePages([page.id], i - 1)}
                >
                  <Icon name="up" size={14} />
                </button>
                <button
                  type="button"
                  title="Move page down (Alt+↓)"
                  aria-label="Move page down"
                  disabled={i === pages.length - 1}
                  onClick={() => movePages([page.id], i + 2)}
                >
                  <Icon name="down" size={14} />
                </button>
              </div>
            )}
            <div className="thumb-meta">
              <span>{i + 1}</span>
              {count > 0 && (
                <span className="badge" title={`${count} edit${count > 1 ? 's' : ''}`}>
                  <Icon name="edit" size={11} /> {count}
                </span>
              )}
            </div>
          </div>
        )
      })}
      <div
        className="drop-tail"
        onDragOver={(e) => {
          if (!dragging.current.length) return
          e.preventDefault()
          setDropIndex(pages.length)
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (dragging.current.length) movePages(dragging.current, pages.length)
          dragging.current = []
          setDropIndex(null)
        }}
      >
        {dropIndex === pages.length && <div className="drop-line top" />}
      </div>
    </div>
  )
}
