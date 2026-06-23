import { stat } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';

/**
 * Готує перелік шляхів для КТ-завантаження. Якщо шлях — папка, архівує її
 * у .zip (нативний Rust-бекенд) і підставляє шлях до архіву. Готові файли
 * (zip/rar/7z тощо) повертаються без змін.
 *
 * `onZipStart(name)` викликається перед запаковкою кожної папки — щоб UI
 * показав статус «Архівуємо…», бо для великих КТ це може зайняти час.
 */
export async function prepareCtPaths(
  paths: string[],
  onZipStart?: (folderName: string) => void,
): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    const st = await stat(path);
    if (st.isDirectory) {
      const folderName = path.split(/[\\/]/).filter(Boolean).pop() || 'КТ';
      onZipStart?.(folderName);
      const zipPath = await invoke<string>('zip_folder', { src: path });
      result.push(zipPath);
    } else {
      result.push(path);
    }
  }
  return result;
}
