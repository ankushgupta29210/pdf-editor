/** Pure settings data, kept free of pdf-lib so dialogs can import it cheaply. */
export type CompressMode = 'optimize' | 'rasterize'

export interface CompressSettings {
  mode: CompressMode
  /** rasterise target resolution */
  dpi: number
  /** JPEG quality 0..1 */
  quality: number
  grayscale: boolean
  stripMetadata: boolean
}

export interface CompressPreset {
  id: string
  label: string
  hint: string
  settings: CompressSettings
}

export const PRESETS: CompressPreset[] = [
  {
    id: 'lossless',
    label: 'Keep text sharp',
    hint: 'Rebuilds and repacks the file. Text stays selectable — modest savings.',
    settings: { mode: 'optimize', dpi: 150, quality: 0.8, grayscale: false, stripMetadata: true },
  },
  {
    id: 'light',
    label: 'Light',
    hint: '150 DPI images, high quality. Good for printing.',
    settings: { mode: 'rasterize', dpi: 150, quality: 0.82, grayscale: false, stripMetadata: true },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: '110 DPI. Best size-to-quality trade for sharing and email.',
    settings: { mode: 'rasterize', dpi: 110, quality: 0.68, grayscale: false, stripMetadata: true },
  },
  {
    id: 'strong',
    label: 'Strong',
    hint: '80 DPI. Smallest files — fine on screen, soft in print.',
    settings: { mode: 'rasterize', dpi: 80, quality: 0.5, grayscale: false, stripMetadata: true },
  },
]
