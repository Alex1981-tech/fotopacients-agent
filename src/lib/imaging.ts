import { readFile, stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

/**
 * Агент приймає лише КТ і рентгени:
 *   • КТ — папка або архів з DICOM усередині (перевіряє Rust `probe_ct`;
 *     .rar/.7z тут не відкрити — їх остаточно перевіряє сервер);
 *   • рентген — зображення (панораму чи прицільний обирає людина).
 * Усе інше (PDF, документи, відео, архіви без DICOM) — відхиляється.
 */

export const IMAGE_EXT = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp'];
export const ARCHIVE_EXT = ['zip', 'rar', '7z', 'isz'];

const ext = (path: string) => (path.split('.').pop() || '').toLowerCase();
export const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export interface Classified {
  ct: string[];        // папки та архіви з DICOM (або .rar/.7z — перевірить сервер)
  images: string[];    // кандидати в рентген
  rejected: string[];  // не КТ і не зображення
}

export async function classifyPaths(paths: string[]): Promise<Classified> {
  const out: Classified = { ct: [], images: [], rejected: [] };
  for (const path of paths) {
    let isDir = false;
    try {
      isDir = (await stat(path)).isDirectory;
    } catch {
      out.rejected.push(path);
      continue;
    }
    if (!isDir && IMAGE_EXT.includes(ext(path))) {
      out.images.push(path);
    } else if (isDir || ARCHIVE_EXT.includes(ext(path))) {
      const verdict = await invoke<string>('probe_ct', { path });
      (verdict === 'not_ct' ? out.rejected : out.ct).push(path);
    } else {
      out.rejected.push(path);
    }
  }
  return out;
}

/** Папки КТ → .zip (нативний Rust), архіви — як є. */
export async function zipCtFolders(
  paths: string[],
  onZipStart?: (folderName: string) => void,
): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    if ((await stat(path)).isDirectory) {
      onZipStart?.(fileName(path));
      result.push(await invoke<string>('zip_folder', { src: path }));
    } else {
      result.push(path);
    }
  }
  return result;
}

const MAX_XRAY_PROBE_BYTES = 80 * 1024 * 1024;

/**
 * Чи схоже зображення на рентген: рентгенівські знімки — у відтінках сірого.
 * Потрібно, щоб агент не вискакивав з трею на кожне скопійоване фото.
 * Формати, які webview не декодує (TIFF, HEIC), вважаємо «можливо рентген».
 */
export async function looksLikeXray(path: string): Promise<boolean> {
  try {
    if ((await stat(path)).size > MAX_XRAY_PROBE_BYTES) return true;
    const bytes = await readFile(path);
    const bitmap = await createImageBitmap(new Blob([bytes]), { resizeWidth: 64, resizeHeight: 64 });
    const canvas = new OffscreenCanvas(64, 64);
    const ctx = canvas.getContext('2d');
    if (!ctx) return true;
    ctx.drawImage(bitmap, 0, 0);
    const px = ctx.getImageData(0, 0, 64, 64).data;
    let colored = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 16) colored++;
    }
    return colored / (64 * 64) < 0.03;
  } catch {
    return ['tif', 'tiff', 'heic', 'heif'].includes(ext(path));
  }
}
