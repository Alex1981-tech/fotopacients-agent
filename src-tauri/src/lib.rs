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
        .invoke_handler(tauri::generate_handler![show_window, hide_window, get_local_ip, get_clipboard_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
