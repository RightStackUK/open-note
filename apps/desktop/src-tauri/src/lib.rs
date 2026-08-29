use git_port::{GitPort, SystemGit};

/// Reports the system `git` version, or `None` when no usable binary is on PATH.
///
/// Phase 0 smoke test for the frontend/Rust bridge. Phase 1 replaces this with
/// real vault commands.
#[tauri::command]
fn git_probe() -> Option<String> {
    SystemGit::new().describe().ok()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![git_probe])
        .run(tauri::generate_context!())
        .expect("error while running Open Note");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_probe_reports_the_system_git() {
        // CI and dev machines always have git; a None here means PATH resolution
        // broke, which would silently disable every sync feature.
        let probed = git_probe().expect("system git should be discoverable");
        assert!(
            probed.starts_with("git version"),
            "unexpected output: {probed}"
        );
    }
}
