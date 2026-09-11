const PATHS: Record<string, string> = {
  select: 'M4 3l7.5 17 2.2-7.3L21 10.5z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  rect: 'M4 6h16v12H4z',
  ellipse: 'M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z',
  line: 'M5 19L19 5',
  highlight: 'M4 20h7M14.5 3.5l6 6L11 19H5v-6z',
  ink: 'M3 21c3-1 4-3 6-7s4-8 7-9 5 2 3 6-6 6-9 7-5 2-7 3z',
  image: 'M4 5h16v14H4zM4 15l4.5-4.5L14 16M15 9.5h.01',
  whiteout: 'M4 18h16M6.5 15.5l-2-2 8-8 4.5 4.5-5.5 5.5z',
  rotateRight: 'M20 5v5h-5M20 10a8 8 0 10-2.3 6',
  rotateLeft: 'M4 5v5h5M4 10a8 8 0 112.3 6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  plus: 'M12 5v14M5 12h14',
  undo: 'M4 9h11a5 5 0 010 10h-6M4 9l4-4M4 9l4 4',
  redo: 'M20 9H9a5 5 0 000 10h6M20 9l-4-4M20 9l-4 4',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  compress: 'M12 3v6M9 6l3-3 3 3M12 21v-6M9 18l3 3 3-3M3 12h18',
  zoomIn: 'M11 4a7 7 0 107 7 7 7 0 00-7-7zM16 16l5 5M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 107 7 7 7 0 00-7-7zM16 16l5 5M8 11h6',
  file: 'M14 3H6v18h12V7zM14 3v4h4',
  files: 'M13 2H7v16h11V7zM13 2v5h5M4 6v16h11',
  close: 'M6 6l12 12M18 6L6 18',
  front: 'M4 8l8-4 8 4-8 4zM4 14l8 4 8-4',
  back: 'M4 16l8 4 8-4M4 10l8 4 8-4',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  check: 'M5 13l4 4L19 7',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  info: 'M12 8h.01M11 12h1v5h1',
  page: 'M6 3h12v18H6zM9 8h6M9 12h6M9 16h3',
  ocr: 'M4 7h9M4 11h6M15.5 18.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM18 21l-2-2',
}

export function Icon({
  name,
  size = 16,
  fill = 'none',
}: {
  name: keyof typeof PATHS | string
  size?: number
  fill?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name] ?? ''} />
    </svg>
  )
}
