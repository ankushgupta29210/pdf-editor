import type { ReactElement } from 'react'
import { Icon } from './Icon'

type Props = {
  onChooseFiles: () => void
  onImagesToPdf: () => void
}

const base = import.meta.env.BASE_URL

function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

const FEATURES: Array<{ icon: ReactElement; title: string; body: string }> = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="6" y="4" width="12" height="15" rx="1.5" />
        <path d="M3 8v11a1.5 1.5 0 0 0 1.5 1.5H15" opacity=".55" />
      </svg>
    ),
    title: 'Merge & organize',
    body: 'Combine any number of PDFs, drag to reorder, rotate, duplicate, delete or extract pages.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16.5 3.5 20.5 7.5 8 20l-4.5 1 1-4.5Z" />
      </svg>
    ),
    title: 'Edit & sign',
    body: 'Text boxes, highlights, shapes, freehand signatures, images — and a real whiteout tool.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3.5" y="4.5" width="17" height="14" rx="1.5" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="m4 16 4.5-4.5L12 15l3-3 5 5" />
      </svg>
    ),
    title: 'Images to PDF',
    body: 'PNG, JPEG, WebP, AVIF, GIF, BMP or SVG — turned into pages at the size you pick.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    ),
    title: 'Compress',
    body: 'Presets from “keep text sharp” down to aggressive, so the file fits where it needs to.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="m15 15 5 5" strokeLinecap="round" />
      </svg>
    ),
    title: 'Make it searchable',
    body: 'OCR reads scanned pages and adds a real, selectable text layer on top — quietly, in place.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12Z" opacity=".4" />
        <path d="M4 4l16 16" />
      </svg>
    ),
    title: 'Redact for real',
    body: 'A whiteout box flattens the page underneath, so what it covers is actually gone.',
  },
]

const TICKET: Array<[string, string]> = [
  ['Merge two PDFs', '$4.99'],
  ['Export without a watermark', '$9.99'],
  ['No file-size limit', '$12.99/mo'],
  ['Make a scan searchable (OCR)', '$19.99/mo'],
]

const PRIVACY: Array<[string, string]> = [
  ['Nothing is uploaded', 'Every file is read and rebuilt in your browser’s own memory. It never touches a server.'],
  ['Self-hosted, not CDN-hosted', 'The tools it runs on ship with the site itself — no third party gets pinged while you edit.'],
  ['No account, ever', 'Close the tab and it’s like you were never there. Nothing to sign up for, nothing to delete later.'],
]

/** The page shown before any file is opened: hero, pricing ticket, features, privacy. */
export function Landing({ onChooseFiles, onImagesToPdf }: Props) {
  return (
    <main className="landing">
      <header className="landing-top">
        <div className="landing-brand">
          <div className="landing-mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="#06121c" strokeWidth="2" strokeLinecap="round">
              <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
              <path d="M9 13h6M9 17h6M9 9h2" />
            </svg>
          </div>
          <div className="landing-brand-name">
            PDF Editor <span>· Ankush Gupta Tech</span>
          </div>
        </div>
        <nav className="landing-links">
          <a href="#features">What it does</a>
          <a href="#privacy">Privacy</a>
        </nav>
      </header>

      <section className="hero">
        <div>
          <div className="eyebrow">Free · in your browser · nothing uploaded</div>
          <h1>PDFs shouldn’t cost&nbsp;a&nbsp;subscription.</h1>
          <p className="lead">
            Merge, edit, convert and compress PDFs entirely on your device. No account, no upload,
            no card on file — built after one too many “free” editors asked for one.
          </p>
          <div className="cta-row">
            <button className="btn btn-primary" onClick={onChooseFiles}>
              <Icon name="plus" /> Choose files
            </button>
            <button className="btn btn-ghost" onClick={onImagesToPdf}>
              <Icon name="image" /> Images to PDF
            </button>
          </div>
          <div className="trust-line">
            <span><Check />Processed on this device</span>
            <span><Check />No sign-up</span>
            <span><Check />Free, forever</span>
          </div>
          <p className="drop-hint">…or drop PDFs and images anywhere on this page.</p>
        </div>

        <div className="panel-stage" aria-hidden="true">
          <div className="paper-shadow" />
          <div className="mock">
            <div className="mock-bar">
              <div className="mock-dots"><i /><i /><i /></div>
              <div className="mock-title">document.pdf</div>
              <div className="mock-actions">
                <span className="mock-chip">Merge</span>
                <span className="mock-chip active">Searchable</span>
              </div>
            </div>
            <div className="mock-body">
              <div className="doc-sheet">
                <div className="fold" />
                <div className="bar w40" />
                <div className="bar w90" />
                <div className="bar w70" />
                <div className="bar accent w90" />
                <div className="bar w40" />
                <div className="scan-beam" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="price-heading">
          <div className="eyebrow center">what pdf tools usually charge for</div>
          <h2>Every one of these used to have a price tag.</h2>
        </div>
        <div className="ticket-wrap">
          <div className="ticket mono">
            {TICKET.map(([label, price]) => (
              <div className="ticket-row" key={label}>
                <span>{label}</span>
                <span className="price">{price}</span>
              </div>
            ))}
            <div className="ticket-total">
              <span className="label">Here, it’s</span>
              <span className="amount">$0.00</span>
            </div>
            <div className="ticket-fine">No card, no watermark, no catch — it just runs in your browser.</div>
          </div>
        </div>
      </section>

      <section id="features">
        <div className="features-head">
          <div className="eyebrow">inside the editor</div>
          <h2>Everything you’d normally pay for.</h2>
        </div>
        <div className="grid-features">
          {FEATURES.map((f) => (
            <div className="feature" key={f.title}>
              <div className="icon">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="privacy">
        <div className="privacy">
          {PRIVACY.map(([title, body], i) => (
            <div className="privacy-item" key={title}>
              <div className="num mono">{String(i + 1).padStart(2, '0')}</div>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="landing-foot">
        <div className="landing-foot-brand">
          <a href="https://ankushguptatech.com/" target="_blank" rel="noopener" title="Ankush Gupta Tech">
            <img src={`${base}agt-logo.png`} alt="Ankush Gupta Tech" width={44} height={34} />
          </a>
          <div>
            A free tool by{' '}
            <a href="https://ankushguptatech.com/" target="_blank" rel="noopener">
              Ankush Gupta Tech
            </a>{' '}
            · <a href={`${base}privacy.html`}>Privacy</a>
          </div>
        </div>
        <div className="mono">pdfeditor.ankushguptatech.com</div>
      </footer>
    </main>
  )
}
