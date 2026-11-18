use open_typeless::config::{self, Config};
use open_typeless::{Outcome, prompt, record, rewrite};
use std::io::{Read, Write};
use std::path::Path;
use std::time::Instant;

const USAGE: &str = "\
open-typeless: turns a raw dictation transcript into clean, structured text.

  open-typeless            read a transcript on stdin, print the text to paste
  open-typeless check      show the settings in use and run one test rewrite
  open-typeless --version

With no arguments, a rewrite that fails or is refused prints the transcript
unchanged. A broken setup (unreadable settings, no API key) prints the
transcript, explains itself on stderr and exits 1, so the caller can report it.
Settings and history live in ~/Library/Application Support/open-typeless
(or $OPEN_TYPELESS_HOME).";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = config::data_dir();
    match args.first().map(String::as_str) {
        None => hook(&dir),
        Some("check") => std::process::exit(check(&dir)),
        Some("--version" | "-V") => println!("open-typeless {}", env!("CARGO_PKG_VERSION")),
        Some("--help" | "-h" | "help") => println!("{USAGE}"),
        Some(other) => {
            eprintln!("unknown argument: {other}\n\n{USAGE}");
            std::process::exit(2);
        }
    }
}

/// Everything needed for a rewrite, or the reason it cannot run.
fn prepare(dir: &Path) -> Result<(Config, String, String), String> {
    let config = Config::load(dir)?;
    let rules = match &config.prompt_file {
        Some(path) => std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?,
        None => prompt::BUILT_IN.to_string(),
    };
    let api_key = config.api_key(dir)?;
    Ok((config, api_key, rules))
}

fn hook(dir: &Path) {
    let started = Instant::now();
    let mut transcript = String::new();
    if std::io::stdin().read_to_string(&mut transcript).is_err() {
        // Not text we can work with; let the caller keep its original.
        std::process::exit(1);
    }

    let mut setup_error = None;
    let (outcome, keep_record) = match prepare(dir) {
        Ok((config, api_key, rules)) => {
            (rewrite(&config, &api_key, &rules, &transcript), config.log)
        }
        Err(reason) => {
            setup_error = Some(reason.clone());
            (
                Outcome { text: transcript.clone(), rewritten: false, skipped: Some(reason), attempts: vec![] },
                true,
            )
        }
    };

    // The caller drops one trailing newline; add none of our own.
    let mut stdout = std::io::stdout();
    let _ = stdout.write_all(outcome.text.as_bytes());
    let _ = stdout.flush();

    if keep_record {
        let _ = record::append(dir, &transcript, &outcome, started.elapsed().as_millis() as u64);
    }
    if let Some(reason) = setup_error {
        eprintln!("open-typeless is not set up, transcript left unchanged: {reason}");
        std::process::exit(1);
    }
}

fn check(dir: &Path) -> i32 {
    println!("data folder: {}", dir.display());
    let (config, api_key, rules) = match prepare(dir) {
        Ok(ready) => ready,
        Err(reason) => {
            println!("NOT READY: {reason}");
            return 1;
        }
    };
    println!("endpoint:    {}", config.base_url);
    println!("models:      {}", config.models.iter().map(|m| m.model.as_str()).collect::<Vec<_>>().join(", then "));
    println!("vocabulary:  {} terms", config.vocabulary.len());
    println!("API key:     found");

    let sample = "so um I think we should uh move the meeting to Thursday no wait Friday and also tell Sam to bring the the slides";
    let started = Instant::now();
    let outcome = rewrite(&Config { min_words: 0, ..config }, &api_key, &rules, sample);
    println!("\ntest transcript: {sample}");
    for attempt in &outcome.attempts {
        println!("  {} ({} ms): {}", attempt.model, attempt.ms, attempt.result);
    }
    println!("result ({} ms): {}", started.elapsed().as_millis(), outcome.text);
    if outcome.rewritten { 0 } else { 1 }
}
