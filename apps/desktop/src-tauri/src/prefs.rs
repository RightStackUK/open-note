//! Machine-local preferences.
//!
//! Deliberately *not* stored in the vault: which folders this particular machine
//! has open is not something anyone wants committed and synced to a shared repo.
//! Per-vault settings live in `.opennote/` inside the repo instead.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Enough to cover "the repos I actually use" without becoming a history log.
const MAX_RECENT: usize = 8;

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    /// Most recently opened first.
    #[serde(default)]
    pub recent_vaults: Vec<String>,
}

fn prefs_file(config_dir: &Path) -> PathBuf {
    config_dir.join("prefs.json")
}

/// Read preferences, falling back to defaults.
///
/// A corrupt or unreadable file is treated as "no preferences yet" rather than
/// an error: losing the recent-vault list is a minor annoyance, but refusing to
/// start the app over it would not be.
pub fn load(config_dir: &Path) -> Prefs {
    fs::read_to_string(prefs_file(config_dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(config_dir: &Path, prefs: &Prefs) -> std::io::Result<()> {
    fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(prefs_file(config_dir), json)
}

/// Move `root` to the front of the recent list, de-duplicated and capped.
pub fn remember(prefs: &mut Prefs, root: &str) {
    prefs.recent_vaults.retain(|v| v != root);
    prefs.recent_vaults.insert(0, root.to_string());
    prefs.recent_vaults.truncate(MAX_RECENT);
}

pub fn forget(prefs: &mut Prefs, root: &str) {
    prefs.recent_vaults.retain(|v| v != root);
}

/// Drop entries whose folder no longer exists, so the welcome screen never
/// offers a vault that was moved or deleted.
pub fn prune_missing(prefs: &mut Prefs) {
    prefs.recent_vaults.retain(|v| Path::new(v).is_dir());
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn remembers_most_recent_first() {
        let mut p = Prefs::default();
        remember(&mut p, "/a");
        remember(&mut p, "/b");
        assert_eq!(p.recent_vaults, vec!["/b", "/a"]);
    }

    #[test]
    fn reopening_a_vault_promotes_it_rather_than_duplicating_it() {
        let mut p = Prefs::default();
        remember(&mut p, "/a");
        remember(&mut p, "/b");
        remember(&mut p, "/a");
        assert_eq!(p.recent_vaults, vec!["/a", "/b"]);
    }

    #[test]
    fn caps_the_recent_list() {
        let mut p = Prefs::default();
        for i in 0..20 {
            remember(&mut p, &format!("/vault-{i}"));
        }
        assert_eq!(p.recent_vaults.len(), MAX_RECENT);
        assert_eq!(p.recent_vaults[0], "/vault-19");
    }

    #[test]
    fn forget_removes_an_entry() {
        let mut p = Prefs::default();
        remember(&mut p, "/a");
        remember(&mut p, "/b");
        forget(&mut p, "/a");
        assert_eq!(p.recent_vaults, vec!["/b"]);
    }

    #[test]
    fn prunes_vaults_that_no_longer_exist() {
        let dir = TempDir::new().unwrap();
        let alive = dir.path().to_string_lossy().into_owned();
        let mut p = Prefs {
            recent_vaults: vec![alive.clone(), "/definitely/not/here".into()],
        };
        prune_missing(&mut p);
        assert_eq!(p.recent_vaults, vec![alive]);
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = TempDir::new().unwrap();
        let mut p = Prefs::default();
        remember(&mut p, "/a");
        save(dir.path(), &p).expect("save");
        assert_eq!(load(dir.path()).recent_vaults, vec!["/a"]);
    }

    #[test]
    fn a_corrupt_prefs_file_does_not_stop_the_app_starting() {
        let dir = TempDir::new().unwrap();
        fs::write(prefs_file(dir.path()), "{ not json").unwrap();
        assert!(load(dir.path()).recent_vaults.is_empty());
    }

    #[test]
    fn missing_prefs_file_yields_defaults() {
        let dir = TempDir::new().unwrap();
        assert!(load(dir.path()).recent_vaults.is_empty());
    }
}
