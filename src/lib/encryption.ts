/**
 * Password handling. The regular pdf-lib cannot read or write encrypted PDFs,
 * so the maintained @cantoo/pdf-lib fork is loaded on demand for just these two
 * jobs: decrypting a protected file when it is opened, and encrypting a copy
 * when the user asks for one. It is a separate chunk, so nobody pays for it
 * unless they use it.
 */

/** Asks the user for a password; resolves to null if they cancel. */
export type PasswordAsker = (fileName: string, error?: string) => Promise<string | null>

export interface UnlockResult {
  bytes: Uint8Array
  /** true if the file was encrypted (with or without an open password) */
  wasEncrypted: boolean
}

async function fork() {
  return import('@cantoo/pdf-lib')
}

/** Cheap check of the trailer for an /Encrypt entry, without parsing the file. */
function looksEncrypted(bytes: Uint8Array): boolean {
  // The trailer (or cross-reference stream dictionary) sits near the end, but
  // incremental updates can push it back; 64 KB covers real-world files.
  const tail = bytes.subarray(Math.max(0, bytes.length - 65536))
  const text = new TextDecoder('latin1').decode(tail)
  if (/\/Encrypt\s/.test(text) || /\/Encrypt\s*\d+\s+\d+\s+R/.test(text)) return true
  // Some writers put the trailer at the front (linearised files).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)))
  return /\/Encrypt\s*\d+\s+\d+\s+R/.test(head)
}

/**
 * Returns plain, unencrypted bytes for `bytes`, asking for a password only if
 * the file needs one to open. Files that are merely permission-restricted
 * (owner password only) open with an empty password and need no prompt.
 * Resolves to null if the user cancels.
 */
export async function ensureUnlocked(
  bytes: Uint8Array,
  fileName: string,
  ask: PasswordAsker,
): Promise<UnlockResult | null> {
  if (!looksEncrypted(bytes)) return { bytes, wasEncrypted: false }
  const { PDFDocument } = await fork()

  // The byte scan can be fooled (e.g. "/Encrypt" inside some content), so
  // confirm with a real parse before rewriting anything.
  try {
    const probe = await PDFDocument.load(bytes.slice(), {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    })
    if (!probe.isEncrypted) return { bytes, wasEncrypted: false }
  } catch {
    return { bytes, wasEncrypted: false } // let the normal open path report it
  }

  const tryOpen = async (password: string) => {
    const doc = await PDFDocument.load(bytes.slice(), { password, throwOnInvalidObject: false })
    return new Uint8Array(await doc.save({ useObjectStreams: true }))
  }

  try {
    return { bytes: await tryOpen(''), wasEncrypted: true }
  } catch {
    // Needs a real open password.
  }

  let error: string | undefined
  for (;;) {
    const pw = await ask(fileName, error)
    if (pw === null) return null
    try {
      return { bytes: await tryOpen(pw), wasEncrypted: true }
    } catch {
      error = 'That password did not work. Check it and try again.'
    }
  }
}

export interface ProtectOptions {
  password: string
  allowPrinting: boolean
  allowCopying: boolean
  allowEditing: boolean
}

function randomPassword(): string {
  const a = new Uint8Array(18)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Encrypts a finished PDF with AES-256. */
export async function protectPdf(bytes: Uint8Array, opts: ProtectOptions): Promise<Uint8Array> {
  const { PDFDocument } = await fork()
  const doc = await PDFDocument.load(bytes.slice(), { throwOnInvalidObject: false })
  const restricted = !opts.allowPrinting || !opts.allowCopying || !opts.allowEditing
  doc.encrypt({
    userPassword: opts.password,
    // With identical passwords every viewer treats the reader as the owner and
    // ignores the restrictions, so restrictions get their own secret password.
    ownerPassword: restricted ? randomPassword() : opts.password,
    permissions: {
      printing: opts.allowPrinting ? 'highResolution' : false,
      copying: opts.allowCopying,
      modifying: opts.allowEditing,
      annotating: opts.allowEditing,
      fillingForms: true,
      contentAccessibility: true,
      documentAssembly: opts.allowEditing,
    },
  })
  return new Uint8Array(await doc.save({ useObjectStreams: true }))
}
