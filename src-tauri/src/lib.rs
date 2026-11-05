use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn show_window(app: AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Повертає першу не-loopback IPv4 LAN-адресу клієнтського ПК.
/// Потрібно агенту щоб вибрати ноду в ТІЙ самій підмережі (priority over
/// швидших нод доступних через IPsec — щоб не йти через тунель коли є локальна).
#[tauri::command]
fn get_local_ip() -> Option<String> {
    use local_ip_address::local_ip;
    local_ip().ok().map(|ip| ip.to_string())
}

/// Повертає список файлів у Windows clipboard (HDROP формат). Виникає
/// коли користувач "копіює файл" у Провіднику (Ctrl+C на файлі).
/// tauri-plugin-clipboard дає тільки text/image; HDROP — спеціальний
/// формат який треба читати окремо через WinAPI.
///
/// Non-Windows: завжди порожній.
#[tauri::command]
fn get_clipboard_files() -> Vec<String> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats, get_clipboard};
        match get_clipboard(formats::FileList) {
            Ok(list) => list,
            Err(_) => Vec::new(),
        }
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Архівує папку `src` у .zip і повертає шлях до створеного архіву (у
/// системному temp). Використовується КТ-режимом: коли користувач кидає
/// папку зі знімками замість готового архіву — пакуємо її автоматично
/// перед завантаженням. Імена всередині архіву — відносно кореня папки.
#[tauri::command]
fn zip_folder(src: String) -> Result<String, String> {
    use std::fs::File;
    use std::path::Path;
    use zip::write::SimpleFileOptions;

    let base = Path::new(&src);
    if !base.is_dir() {
        return Err(format!("не папка: {src}"));
    }
    let folder_name = base
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("ct");

    // Унікальний суфікс щоб повторні/паралельні запаковки не перезаписали одна одну.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut out = std::env::temp_dir();
    out.push(format!("{folder_name}-{stamp}.zip"));

    let file = File::create(&out).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);

    let mut stack = vec![base.to_path_buf()];
    let mut entries = 0u64;
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))? {
            let entry = entry.map_err(|e| format!("entry: {e}"))?;
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("strip_prefix: {e}"))?;
            let name = rel.to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                zip.add_directory(format!("{name}/"), options)
                    .map_err(|e| format!("add_directory: {e}"))?;
                stack.push(path);
            } else {
                zip.start_file(&name, options)
                    .map_err(|e| format!("start_file: {e}"))?;
                let mut f = File::open(&path).map_err(|e| format!("open {name}: {e}"))?;
                std::io::copy(&mut f, &mut zip).map_err(|e| format!("copy {name}: {e}"))?;
                entries += 1;
            }
        }
    }
    if entries == 0 {
        return Err("папка порожня — нічого архівувати".into());
    }
    zip.finish().map_err(|e| format!("finish zip: {e}"))?;
    Ok(out.to_string_lossy().to_string())
}

fn looks_dicom(head: &[u8]) -> bool {
    head.len() >= 132 && &head[128..132] == b"DICM"
}

fn is_dicom_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.ends_with(".dcm") || lower.rsplit(['/', '\\']).next() == Some("dicomdir")
}

/// Чи це джерело КТ: "ct" | "not_ct" | "unknown". Папка й .zip — шукаємо
/// DICOM (ім'я .dcm/DICOMDIR або магія `DICM` на offset 128, як на сервері);
/// .isz — CBCT-образ за визначенням; .rar/.7z тут не відкрити → "unknown",
/// остаточно перевіряє сервер. Решта — "not_ct".
#[tauri::command]
fn probe_ct(path: String) -> String {
    use std::io::Read;
    use std::path::Path;

    const MAX_PROBE: usize = 200;
    let p = Path::new(&path);
    if p.is_dir() {
        let mut stack = vec![p.to_path_buf()];
        let mut probed = 0usize;
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let ep = entry.path();
                if ep.is_dir() {
                    stack.push(ep);
                    continue;
                }
                if is_dicom_name(&ep.to_string_lossy()) {
                    return "ct".into();
                }
                if probed >= MAX_PROBE {
                    continue;
                }
                probed += 1;
                let mut head = [0u8; 132];
                if let Ok(mut f) = std::fs::File::open(&ep) {
                    if f.read_exact(&mut head).is_ok() && looks_dicom(&head) {
                        return "ct".into();
                    }
                }
            }
        }
        return "not_ct".into();
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "isz" => "ct".into(),
        "rar" | "7z" => "unknown".into(),
        "zip" => {
            let Ok(file) = std::fs::File::open(p) else { return "not_ct".into() };
            let Ok(mut zip) = zip::ZipArchive::new(file) else { return "not_ct".into() };
            if zip.file_names().any(is_dicom_name) {
                return "ct".into();
            }
            let mut probed = 0usize;
            for i in 0..zip.len() {
                if probed >= MAX_PROBE {
                    break;
                }
                let Ok(mut member) = zip.by_index(i) else { continue };
                if member.is_dir() {
                    continue;
                }
                probed += 1;
                let mut head = [0u8; 132];
                if member.read_exact(&mut head).is_ok() && looks_dicom(&head) {
                    return "ct".into();
                }
            }
            "not_ct".into()
        }
        _ => "not_ct".into(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_log::Builder::new().build())
        .setup(|app| {
            // Tray icon + menu
            let open_i = MenuItem::with_id(app, "open", "Відкрити", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Вийти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Якщо програма НЕ запущена з --hidden — показуємо вікно одразу.
            // При autostart Windows запускає з --hidden → сидимо в tray.
            let args: Vec<String> = std::env::args().collect();
            if !args.contains(&"--hidden".to_string()) {
                show_main_window(&app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide замість quit — лишаємось у tray
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![show_window, hide_window, get_local_ip, get_clipboard_files, zip_folder, probe_ct])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::probe_ct;
    use std::io::Write;

    fn dicom() -> Vec<u8> {
        let mut v = vec![0u8; 128];
        v.extend_from_slice(b"DICM");
        v.extend_from_slice(&[0u8; 16]);
        v
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("probe-ct-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn folder_with_dicom_without_extension_is_ct() {
        let d = tmp("dir-ct");
        std::fs::create_dir_all(d.join("series")).unwrap();
        std::fs::write(d.join("series").join("0001"), dicom()).unwrap();
        assert_eq!(probe_ct(d.to_string_lossy().into()), "ct");
    }

    #[test]
    fn folder_with_photos_is_not_ct() {
        let d = tmp("dir-photo");
        std::fs::write(d.join("a.jpg"), b"\xff\xd8\xff not dicom").unwrap();
        assert_eq!(probe_ct(d.to_string_lossy().into()), "not_ct");
    }

    #[test]
    fn zip_probe() {
        let d = tmp("zip");
        for (name, member, data) in [("ct.zip", "0001", dicom()), ("docs.zip", "a.txt", b"hi".to_vec())] {
            let f = std::fs::File::create(d.join(name)).unwrap();
            let mut z = zip::ZipWriter::new(f);
            z.start_file(member, zip::write::SimpleFileOptions::default()).unwrap();
            z.write_all(&data).unwrap();
            z.finish().unwrap();
        }
        assert_eq!(probe_ct(d.join("ct.zip").to_string_lossy().into()), "ct");
        assert_eq!(probe_ct(d.join("docs.zip").to_string_lossy().into()), "not_ct");
        assert_eq!(probe_ct(d.join("x.rar").to_string_lossy().into()), "unknown");
        assert_eq!(probe_ct(d.join("x.pdf").to_string_lossy().into()), "not_ct");
    }
}
