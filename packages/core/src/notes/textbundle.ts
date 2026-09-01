import { strToU8, zipSync } from 'fflate';

/**
 * Textbundle export, zipped (`.textpack`).
 *
 * Textbundle is the lossless round-trip format: a documented open container of
 * the Markdown exactly as written plus its attachments, not a rendering. It is
 * a zip and a manifest — nothing to invent, nothing that another app cannot
 * read back. <https://textbundle.org>
 */

export interface TextbundleAsset {
  /** File name inside `assets/`, no directories. */
  name: string;
  data: Uint8Array;
}

/**
 * Build a `.textpack` (a zipped textbundle) for one note.
 *
 * The note text goes in verbatim, with asset references rewritten onto the
 * container's `assets/` folder by the caller beforehand if it wants them
 * portable — this function does not rewrite content, because lossless is the
 * entire point of the format.
 */
export function buildTextpack(source: string, assets: TextbundleAsset[] = []): Uint8Array {
  const info = {
    version: 2,
    type: 'net.daringfireball.markdown',
    transient: false,
    creatorIdentifier: 'com.rightstack.opennote',
  };

  const files: Record<string, Uint8Array> = {
    'info.json': strToU8(`${JSON.stringify(info, null, 2)}\n`),
    'text.md': strToU8(source),
  };
  for (const asset of assets) {
    // Flat names only: a crafted `../` — or `..\` for the extractors that
    // honour backslashes — would otherwise write outside the bundle when some
    // other tool unpacks it.
    const name = asset.name.split(/[/\\]/).pop() ?? '';
    if (name && name !== '..' && name !== '.') files[`assets/${name}`] = asset.data;
  }

  return zipSync(files);
}

/**
 * The asset references a note makes: local (non-URL, non-data) image or embed
 * targets, deduplicated, exactly as written.
 */
export function localAssetReferences(source: string): string[] {
  const references = new Set<string>();
  for (const match of source.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
    const target = match[1] ?? '';
    if (target && !/^(https?:|data:)/i.test(target)) references.add(decodeURIComponent(target));
  }
  for (const match of source.matchAll(/!\[\[([^\]|#\n]+)/g)) {
    const target = (match[1] ?? '').trim();
    if (target) references.add(target);
  }
  return [...references];
}

/** Base64 → bytes, for data-URL attachments crossing from the app. */
export function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) return null;
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Bytes → base64, to hand a built container across the IPC as a string. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
