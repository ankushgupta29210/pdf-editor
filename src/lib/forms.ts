import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
} from 'pdf-lib'
import type { PDFDocumentProxy } from './pdfjs'

/** One fillable widget on a page, positioned in the page's base (unrotated-by-user) space. */
export interface FormField {
  /** fully qualified field name — the key values are stored under */
  name: string
  kind: 'text' | 'checkbox' | 'radio' | 'select'
  x: number
  y: number
  w: number
  h: number
  multiline: boolean
  readOnly: boolean
  maxLen: number | null
  /** value the file already holds */
  initial: string | boolean
  /** checkbox / radio: the value this particular widget stands for */
  exportValue: string
  /** dropdown / list choices */
  options: Array<{ value: string; label: string }>
}

const cache = new Map<string, Promise<FormField[]>>()

interface WidgetAnnotation {
  subtype: string
  fieldType?: string
  fieldName?: string
  fieldValue?: string | string[] | null
  rect: number[]
  checkBox?: boolean
  radioButton?: boolean
  pushButton?: boolean
  exportValue?: string
  buttonValue?: string
  options?: Array<{ exportValue: string; displayValue: string }>
  multiLine?: boolean
  readOnly?: boolean
  maxLen?: number
  hidden?: boolean
}

/** Reads the fillable fields of one page. Cached per source page. */
export function readFormFields(
  proxy: PDFDocumentProxy,
  srcId: string,
  pageIndex: number,
): Promise<FormField[]> {
  const key = `${srcId}:${pageIndex}`
  let hit = cache.get(key)
  if (!hit) {
    hit = (async () => {
      const page = await proxy.getPage(pageIndex + 1)
      const viewport = page.getViewport({ scale: 1 })
      const annots = (await page.getAnnotations({ intent: 'display' })) as WidgetAnnotation[]
      const out: FormField[] = []
      for (const a of annots) {
        if (a.subtype !== 'Widget' || !a.fieldName || a.hidden || a.pushButton) continue
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(a.rect)
        const box = {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
        }
        if (box.w < 2 || box.h < 2) continue
        const value = Array.isArray(a.fieldValue) ? (a.fieldValue[0] ?? '') : (a.fieldValue ?? '')
        const common = {
          name: a.fieldName,
          ...box,
          multiline: !!a.multiLine,
          readOnly: !!a.readOnly,
          maxLen: a.maxLen && a.maxLen > 0 ? a.maxLen : null,
          options: [] as FormField['options'],
          exportValue: '',
        }
        if (a.fieldType === 'Tx') {
          out.push({ ...common, kind: 'text', initial: String(value) })
        } else if (a.fieldType === 'Btn' && a.checkBox) {
          const on = a.exportValue ?? 'Yes'
          out.push({ ...common, kind: 'checkbox', exportValue: on, initial: value !== '' && value !== 'Off' && value === on })
        } else if (a.fieldType === 'Btn' && a.radioButton) {
          const on = a.buttonValue ?? ''
          out.push({ ...common, kind: 'radio', exportValue: on, initial: String(value) })
        } else if (a.fieldType === 'Ch') {
          out.push({
            ...common,
            kind: 'select',
            initial: String(value),
            options: (a.options ?? []).map((o) => ({ value: o.exportValue, label: o.displayValue })),
          })
        }
      }
      page.cleanup()
      return out
    })().catch(() => [])
    cache.set(key, hit)
  }
  return hit
}

/** True if the document has any AcroForm fields at all. */
export async function hasForm(proxy: PDFDocumentProxy): Promise<boolean> {
  try {
    const objs = await proxy.getFieldObjects()
    return !!objs && Object.keys(objs).length > 0
  } catch {
    return false
  }
}

/**
 * Writes the user's values into the file's own form fields and flattens the
 * form, so the answers become ordinary page content. Flattening matters: the
 * exporter re-embeds pages as content, which would otherwise drop the
 * interactive widgets (and with them every typed answer).
 *
 * Returns null if the form could not be processed, so the caller can fall back.
 */
export async function fillAndFlatten(
  bytes: Uint8Array,
  values: Record<string, string | boolean>,
): Promise<Uint8Array | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false })
    const form = doc.getForm()
    if (!form.getFields().length) return null
    const font = await doc.embedFont(StandardFonts.Helvetica)

    for (const [name, value] of Object.entries(values)) {
      let field
      try {
        field = form.getField(name)
      } catch {
        continue
      }
      try {
        if (field instanceof PDFTextField) {
          if (field.isMultiline()) {
            // "Auto" size on a multiline box makes pdf-lib pick a size that
            // fills its height, so a short answer prints enormous. Use a normal
            // body size instead unless the form asked for something sensible.
            const da = field.acroField.getDefaultAppearance() ?? ''
            const size = Number(/(\d+(?:\.\d+)?)\s+Tf/.exec(da)?.[1] ?? 0)
            if (!size || size > 16) field.setFontSize(11)
          }
          field.setText(String(value).replace(/[^\x00-\xFF€‘’“”–—•…\n]/g, '?'))
        } else if (field instanceof PDFCheckBox) {
          if (value) field.check()
          else field.uncheck()
        } else if (field instanceof PDFRadioGroup) {
          if (typeof value === 'string' && value) {
            // pdf.js reports a radio by its widget's appearance-state name;
            // pdf-lib selects by option label. They differ when the form has
            // an /Opt list (states "0", "1" vs options "basic", "pro").
            const options = field.getOptions()
            if (options.includes(value)) field.select(value)
            else {
              const states = field.acroField.getOnValues().map((n) => n.decodeText())
              const i = states.indexOf(value)
              if (i >= 0 && options[i] !== undefined) field.select(options[i])
            }
          }
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
          if (typeof value === 'string' && value) field.select(value)
        }
      } catch {
        // One awkward field (odd export value, comb field overflow…) shouldn't
        // lose every other answer.
      }
    }

    try {
      form.updateFieldAppearances(font)
    } catch {
      // Appearances for some fields can't be regenerated; flatten what exists.
    }
    form.flatten({ updateFieldAppearances: false })
    return await doc.save({ useObjectStreams: true, updateFieldAppearances: false })
  } catch {
    return null
  }
}
