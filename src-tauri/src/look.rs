// What the window follows of Settings › Appearance: the UI scale and light or dark (its title bar).
// The page has no IPC, so this reads what the server saved (settings.json in the data folder) and
// looks again whenever the file changes.
//
// UI scale: in a browser the page scales itself with CSS zoom. WebKit (macOS, Linux) measures and
// places things wrongly under CSS zoom (popups run off the window, the page stops short of its
// edges), so there the window zooms the page instead, the way ⌘+ does, and INIT_SCRIPT tells the
// page not to (web/look.ts). WebView2 on Windows is Chromium, where the page's own zoom works.

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager, Theme};

use crate::MAIN;

/// True where the window zooms the page itself.
pub const PAGE_ZOOM: bool = cfg!(not(windows));
/// Run in the page before its own scripts, on every load.
pub const INIT_SCRIPT: &str = "window.__athenaPageZoom = true;";

#[derive(Clone, Copy, PartialEq, Debug)]
struct Look {
    zoom: f64,
    theme: Option<Theme>,
}

/// Watches the settings file for good; applies the look now and after every change.
pub fn watch(app: AppHandle, settings: PathBuf) {
    thread::spawn(move || {
        let mut seen: Option<Option<SystemTime>> = None;
        let mut applied: Option<Look> = None;
        loop {
            let modified = fs::metadata(&settings).and_then(|m| m.modified()).ok();
            if seen != Some(modified) {
                // a file read while the server is still writing it doesn't parse: try again next time
                if let Some(look) = read(&settings) {
                    if applied == Some(look) || apply(&app, look) {
                        applied = Some(look);
                        seen = Some(modified);
                    }
                }
            }
            thread::sleep(Duration::from_millis(300));
        }
    });
}

fn apply(app: &AppHandle, look: Look) -> bool {
    let Some(window) = app.get_webview_window(MAIN) else {
        return false;
    };
    if PAGE_ZOOM {
        let _ = window.set_zoom(look.zoom);
    }
    let _ = window.set_theme(look.theme);
    true
}

/// The look saved in the file; the defaults when there is none yet. None when it can't be read.
fn read(file: &Path) -> Option<Look> {
    let text = match fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::from("{}"),
        Err(_) => return None,
    };
    let settings: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(parse(&settings))
}

fn parse(settings: &serde_json::Value) -> Look {
    let look = &settings["look"];
    // the same limits as web/look.ts
    let scale = look["scale"]
        .as_f64()
        .filter(|s| *s > 0.0)
        .unwrap_or(100.0)
        .clamp(70.0, 160.0);
    let theme = match look["theme"].as_str() {
        Some("light") => Some(Theme::Light),
        Some("dark") => Some(Theme::Dark),
        _ => None,
    };
    Look {
        zoom: scale / 100.0,
        theme,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_scale_and_theme() {
        assert_eq!(
            parse(&json!({ "look": { "scale": 110, "theme": "dark" } })),
            Look {
                zoom: 1.1,
                theme: Some(Theme::Dark)
            }
        );
        assert_eq!(
            parse(&json!({ "look": { "scale": 500, "theme": "light" } })),
            Look {
                zoom: 1.6,
                theme: Some(Theme::Light)
            }
        );
        assert_eq!(parse(&json!({})), Look { zoom: 1.0, theme: None });
        assert_eq!(
            parse(&json!({ "look": { "scale": "big", "theme": "system" } })),
            Look { zoom: 1.0, theme: None }
        );
    }
}
