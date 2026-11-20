use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
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

#[derive(Clone, serde::Serialize)]
struct ZipProgress {
    src: String,
    done: u64,
    total: u64,
}

/// Папка КТ → .zip у системному temp (20.11.2026: у фоні, без стиснення).
/// Раніше пакувалось у головному потоці з Deflate — на папці 1–2 ГБ вікно «зависало».
/// DICOM майже не стискається, тож Stored у рази швидший. Прогрес — подія `zip-progress`.
#[tauri::command]
async fn zip_folder(app: AppHandle, src: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || zip_folder_blocking(&app, &src))
        .await
        .map_err(|e| format!("zip task: {e}"))?
}

fn collect_files(base: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut out = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("read_dir: {e}"))? {
            let path = entry.map_err(|e| format!("entry: {e}"))?.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

fn zip_folder_blocking(app: &AppHandle, src: &str) -> Result<String, String> {
    use std::fs::File;
    use std::path::Path;
    use zip::write::SimpleFileOptions;

    let base = Path::new(src);
    if !base.is_dir() {
        return Err(format!("не папка: {src}"));
    }
    let files = collect_files(base)?;
    if files.is_empty() {
        return Err("папка порожня — нічого архівувати".into());
    }
    let folder_name = base.file_name().and_then(|n| n.to_str()).unwrap_or("ct");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut out = std::env::temp_dir();
    out.push(format!("fpagent-{stamp}-{folder_name}.zip"));

    let file = File::create(&out).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let options = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let total = files.len() as u64;
    for (i, path) in files.iter().enumerate() {
        let name = path
            .strip_prefix(base)
            .map_err(|e| format!("strip_prefix: {e}"))?
            .to_string_lossy()
            .replace('\\', "/");
        zip.start_file(&name, options).map_err(|e| format!("start_file: {e}"))?;
        let mut f = File::open(path).map_err(|e| format!("open {name}: {e}"))?;
        std::io::copy(&mut f, &mut zip).map_err(|e| format!("copy {name}: {e}"))?;
        let done = i as u64 + 1;
        if done % 25 == 0 || done == total {
            let _ = app.emit("zip-progress", ZipProgress { src: src.to_string(), done, total });
        }
    }
    zip.finish().map_err(|e| format!("finish zip: {e}"))?;
    Ok(out.to_string_lossy().to_string())
}

/// SHA-256 файлу потоком (для дублів і звірки на сервері) — у фоні, без читання в пам'ять.
#[tauri::command]
async fn file_sha256(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut f = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        loop {
            let n = f.read(&mut buf).map_err(|e| format!("read: {e}"))?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
        }
        Ok(format!("{:x}", h.finalize()))
    })
    .await
    .map_err(|e| format!("sha task: {e}"))?
}

/// Частина файлу для завантаження (сирі байти в JS як ArrayBuffer, без base64).
#[tauri::command]
async fn read_chunk(path: String, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
        f.seek(SeekFrom::Start(offset)).map_err(|e| format!("seek: {e}"))?;
        let mut buf = Vec::with_capacity(len as usize);
        f.take(len).read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
        Ok(tauri::ipc::Response::new(buf))
    })
    .await
    .map_err(|e| format!("read task: {e}"))?
}

/// Прибрати тимчасовий архів агента (лише наші `fpagent-*.zip` у temp — нічого чужого).
#[tauri::command]
fn remove_temp_zip(path: String) -> bool {
    let p = std::path::Path::new(&path);
    let ours = p.parent() == Some(std::env::temp_dir().as_path())
        && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("fpagent-") && n.ends_with(".zip"));
    ours && std::fs::remove_file(p).is_ok()
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

/// Агент перейменовано FotoPacients Agent → UNIQO Agent (0.4.1). Ідентифікатор той самий, тож вхід і
/// історія лишаються, але NSIS ставить нову назву в нову теку, а старий запис автозапуску продовжив би
/// запускати стару копію. Прибираємо: значення автозапуску й тихо видаляємо стару інсталяцію (дані не чіпає).
#[cfg(windows)]
fn remove_legacy_install() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const LEGACY: &str = "FotoPacients Agent";
    let _ = std::process::Command::new("reg")
        .args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", LEGACY, "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let uninstaller = std::path::Path::new(&local).join(LEGACY).join("uninstall.exe");
        let current = std::env::current_exe().ok();
        let is_self = current.as_deref().map_or(false, |c| c.starts_with(std::path::Path::new(&local).join(LEGACY)));
        if uninstaller.exists() && !is_self {
            let _ = std::process::Command::new(uninstaller).arg("/S").creation_flags(CREATE_NO_WINDOW).spawn();
        }
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
                .tooltip("UNIQO Agent")
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

            #[cfg(windows)]
            std::thread::spawn(remove_legacy_install);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide замість quit — лишаємось у tray
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![show_window, hide_window, get_local_ip, get_clipboard_files, zip_folder, probe_ct, file_sha256, read_chunk, remove_temp_zip])
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
