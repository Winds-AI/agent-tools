//! A local, append-only record of every dictation: what was said, what was pasted, and how it went.
//! It is the raw material for checking and improving the rewrite.

use crate::Outcome;
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_NAME: &str = "history.jsonl";

/// Creates the data folder readable by its owner only.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)
}

pub fn append(dir: &Path, transcript: &str, outcome: &Outcome, total_ms: u64) -> std::io::Result<()> {
    create_private_dir(dir)?;
    let line = json!({
        "time": SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "version": env!("CARGO_PKG_VERSION"),
        "transcript": transcript,
        "pasted": outcome.text,
        "rewritten": outcome.rewritten,
        "skipped": outcome.skipped,
        "attempts": outcome.attempts,
        "total_ms": total_ms,
    });
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(dir.join(FILE_NAME))?;
    writeln!(file, "{line}")
}
