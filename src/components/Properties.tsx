import { useStore } from '../state/store'
import type { Annotation, FontKey } from '../lib/types'
import { Icon } from './Icon'

const SWATCHES = [
  '#d92d20',
  '#f79009',
  '#ffe25a',
  '#12b76a',
  '#1570ef',
  '#7a5af8',
  '#101828',
  '#ffffff',
]

function ColorField({
  label,
  value,
  onChange,
  allowNone = false,
}: {
  label: string
  value: string | null
  onChange: (v: string | null) => void
  allowNone?: boolean
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="color-row">
        <input
          type="color"
          value={value ?? '#ffffff'}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        <div className="swatches">
          {allowNone && (
            <button
              type="button"
              className={`swatch none${value === null ? ' on' : ''}`}
              title="No fill"
              onClick={() => onChange(null)}
            />
          )}
          {SWATCHES.map((c) => (
            <button
              type="button"
              key={c}
              className={`swatch${value?.toLowerCase() === c ? ' on' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => onChange(c)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="field">
      <label>
        {label}
        <span className="value">
          {Math.round(value * 100) / 100}
          {suffix}
        </span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}

export function Properties() {
  const tool = useStore((s) => s.tool)
  const defaults = useStore((s) => s.defaults)
  const setDefaults = useStore((s) => s.setDefaults)
  const selectedAnnId = useStore((s) => s.selectedAnnId)
  const annotations = useStore((s) => s.annotations)
  const updateAnnotation = useStore((s) => s.updateAnnotation)
  const deleteAnnotation = useStore((s) => s.deleteAnnotation)
  const bringToFront = useStore((s) => s.bringToFront)
  const sendToBack = useStore((s) => s.sendToBack)

  const selected: Annotation | null =
    (selectedAnnId
      ? Object.values(annotations)
          .flat()
          .find((a) => a.id === selectedAnnId)
      : null) ?? null

  if (!selected) return <ToolDefaults tool={tool} defaults={defaults} setDefaults={setDefaults} />

  const patch = (p: Partial<Annotation>) => updateAnnotation(selected.id, p)

  return (
    <div className="panel-body">
      <div className="panel-title">
        <span>{selected.kind === 'rect' && selected.redact ? 'Redaction box' : labelFor(selected.kind)}</span>
        <div className="row-actions">
          <button title="Bring to front" onClick={() => bringToFront(selected.id)}>
            <Icon name="front" />
          </button>
          <button title="Send to back" onClick={() => sendToBack(selected.id)}>
            <Icon name="back" />
          </button>
          <button
            title="Delete (Del)"
            className="danger"
            onClick={() => deleteAnnotation(selected.id)}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      {selected.kind === 'text' && (
        <>
          <div className="field">
            <label>Font</label>
            <select
              value={selected.font}
              onChange={(e) => patch({ font: e.target.value as FontKey })}
            >
              <option value="Helvetica">Helvetica / Arial</option>
              <option value="Times">Times</option>
              <option value="Courier">Courier</option>
            </select>
          </div>
          <div className="field inline">
            <div className="seg">
              <button
                className={selected.bold ? 'on' : ''}
                style={{ fontWeight: 700 }}
                onClick={() => patch({ bold: !selected.bold })}
              >
                B
              </button>
              <button
                className={selected.italic ? 'on' : ''}
                style={{ fontStyle: 'italic' }}
                onClick={() => patch({ italic: !selected.italic })}
              >
                I
              </button>
            </div>
            <div className="seg">
              {(['left', 'center', 'right'] as const).map((al) => (
                <button
                  key={al}
                  className={selected.align === al ? 'on' : ''}
                  onClick={() => patch({ align: al })}
                  title={`Align ${al}`}
                >
                  {al === 'left' ? '⯇' : al === 'center' ? '≡' : '⯈'}
                </button>
              ))}
            </div>
          </div>
          <SliderField
            label="Size"
            value={selected.fontSize}
            min={6}
            max={72}
            onChange={(v) => patch({ fontSize: v })}
            suffix=" pt"
          />
          <SliderField
            label="Line height"
            value={selected.lineHeight}
            min={0.9}
            max={2.5}
            step={0.05}
            onChange={(v) => patch({ lineHeight: v })}
          />
          <ColorField label="Colour" value={selected.color} onChange={(v) => patch({ color: v! })} />
        </>
      )}

      {selected.kind === 'rect' && selected.redact ? (
        <p className="hint">
          Whiteout box — the page underneath is flattened to a flat image on export, so
          whatever this covers is actually gone, not just hidden. Colour and opacity are
          locked so it can't be made see-through by accident.
        </p>
      ) : (
        (selected.kind === 'rect' || selected.kind === 'ellipse' || selected.kind === 'line') && (
          <>
            <ColorField
              label="Stroke"
              value={selected.stroke}
              onChange={(v) => patch({ stroke: v! })}
            />
            <SliderField
              label="Stroke width"
              value={selected.strokeWidth}
              min={0}
              max={20}
              step={0.5}
              onChange={(v) => patch({ strokeWidth: v })}
            />
            {selected.kind !== 'line' && (
              <ColorField
                label="Fill"
                value={selected.fill}
                allowNone
                onChange={(v) => patch({ fill: v })}
              />
            )}
            <SliderField
              label="Opacity"
              value={selected.opacity}
              min={0.05}
              max={1}
              step={0.05}
              onChange={(v) => patch({ opacity: v })}
            />
          </>
        )
      )}

      {selected.kind === 'highlight' && (
        <>
          <ColorField label="Colour" value={selected.color} onChange={(v) => patch({ color: v! })} />
          <SliderField
            label="Opacity"
            value={selected.opacity}
            min={0.1}
            max={1}
            step={0.05}
            onChange={(v) => patch({ opacity: v })}
          />
        </>
      )}

      {selected.kind === 'ink' && (
        <>
          <ColorField label="Ink" value={selected.stroke} onChange={(v) => patch({ stroke: v! })} />
          <SliderField
            label="Thickness"
            value={selected.strokeWidth}
            min={0.5}
            max={16}
            step={0.5}
            onChange={(v) => patch({ strokeWidth: v })}
          />
        </>
      )}

      {selected.kind === 'image' && (
        <SliderField
          label="Opacity"
          value={selected.opacity}
          min={0.05}
          max={1}
          step={0.05}
          onChange={(v) => patch({ opacity: v })}
        />
      )}

      <div className="field grid2">
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <label key={k} className="num">
            <span>{k.toUpperCase()}</span>
            <input
              type="number"
              value={Math.round(selected[k])}
              onChange={(e) => patch({ [k]: Number(e.target.value) } as Partial<Annotation>)}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function labelFor(kind: Annotation['kind']) {
  return {
    text: 'Text box',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    line: 'Line',
    highlight: 'Highlight',
    ink: 'Freehand',
    image: 'Image',
  }[kind]
}

function ToolDefaults({
  tool,
  defaults,
  setDefaults,
}: {
  tool: ReturnType<typeof useStore.getState>['tool']
  defaults: ReturnType<typeof useStore.getState>['defaults']
  setDefaults: ReturnType<typeof useStore.getState>['setDefaults']
}) {
  if (tool === 'select') {
    return (
      <div className="panel-body">
        <div className="panel-title">
          <span>Nothing selected</span>
        </div>
        <p className="hint">
          Pick a tool on the left to add text, shapes or a signature. Click any existing element to
          edit it — double-click a text box to retype it.
        </p>
      </div>
    )
  }

  return (
    <div className="panel-body">
      <div className="panel-title">
        <span>{labelFor(tool === 'whiteout' ? 'rect' : tool)} defaults</span>
      </div>
      <p className="hint">Drag on the page to place it.</p>

      {tool === 'text' && (
        <>
          <div className="field">
            <label>Font</label>
            <select
              value={defaults.font}
              onChange={(e) => setDefaults({ font: e.target.value as FontKey })}
            >
              <option value="Helvetica">Helvetica / Arial</option>
              <option value="Times">Times</option>
              <option value="Courier">Courier</option>
            </select>
          </div>
          <SliderField
            label="Size"
            value={defaults.fontSize}
            min={6}
            max={72}
            suffix=" pt"
            onChange={(v) => setDefaults({ fontSize: v })}
          />
        </>
      )}

      {tool === 'highlight' ? (
        <ColorField
          label="Colour"
          value={defaults.highlightColor}
          onChange={(v) => setDefaults({ highlightColor: v! })}
        />
      ) : tool !== 'whiteout' ? (
        <ColorField
          label="Colour"
          value={defaults.color}
          onChange={(v) => setDefaults({ color: v! })}
        />
      ) : (
        <p className="hint">
          Whiteout covers the area and flattens that page to a flat image on export, so
          what's underneath is actually removed — not just hidden under a box someone
          could delete or see through.
        </p>
      )}

      {(tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'ink') && (
        <SliderField
          label="Stroke width"
          value={defaults.strokeWidth}
          min={0.5}
          max={20}
          step={0.5}
          onChange={(v) => setDefaults({ strokeWidth: v })}
        />
      )}

      {(tool === 'rect' || tool === 'ellipse') && (
        <ColorField
          label="Fill"
          value={defaults.fill}
          allowNone
          onChange={(v) => setDefaults({ fill: v })}
        />
      )}
    </div>
  )
}
