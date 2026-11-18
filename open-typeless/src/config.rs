//! Settings, read from `config.json` in the data folder. Every field is optional.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One model to try, with any extra request fields it needs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ModelChoice {
    pub model: String,
    /// Merged into the request body, for example `{"reasoning_effort": "none"}`.
    #[serde(default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// OpenAI-compatible endpoint, without `/chat/completions`.
    pub base_url: String,
    /// Tried in order. The next one is used when a call fails, is rate-limited,
    /// or returns a rewrite the guard refuses.
    pub models: Vec<ModelChoice>,
    pub request_timeout_ms: u64,
    /// No new model call starts after this much time; the transcript is pasted as is.
    pub total_budget_ms: u64,
    /// Dictations shorter than this are pasted untouched, with no model call.
    pub min_words: usize,
    /// Names and terms the speech recognizer tends to mishear.
    pub vocabulary: Vec<String>,
    /// Replaces the built-in prompt.
    pub prompt_file: Option<PathBuf>,
    /// Defaults to `api-key` in the data folder.
    pub api_key_file: Option<PathBuf>,
    /// Keep a local record of every transcript and rewrite.
    pub log: bool,
}

impl Default for Config {
    fn default() -> Self {
        let extra = |key: &str, value: &str| {
            let mut map = serde_json::Map::new();
            map.insert(key.into(), value.into());
            map
        };
        Config {
            base_url: "https://api.groq.com/openai/v1".into(),
            models: vec![
                ModelChoice {
                    model: "qwen/qwen3.8-27b".into(),
                    extra: extra("reasoning_effort", "none"),
                },
                ModelChoice {
                    model: "openai/gpt-oss-120b".into(),
                    extra: extra("reasoning_effort", "low"),
                },
            ],
            request_timeout_ms: 6_000,
            total_budget_ms: 9_000,
            min_words: 10,
            vocabulary: Vec::new(),
            prompt_file: None,
            api_key_file: None,
            log: true,
        }
    }
}

/// `OPEN_TYPELESS_HOME`, or the platform-specific application data folder.
pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPEN_TYPELESS_HOME") {
        return PathBuf::from(dir);
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("open-typeless");
        }
    }
    let home = std::env::home_dir().unwrap_or_default();
    home.join("Library/Application Support/open-typeless")
}

impl Config {
    /// A missing file means defaults. A file that does not parse is an error,
    /// so a typo cannot silently change behaviour.
    pub fn load(dir: &Path) -> Result<Config, String> {
        let path = dir.join("config.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    /// `OPEN_TYPELESS_API_KEY`, or the key file.
    pub fn api_key(&self, dir: &Path) -> Result<String, String> {
        if let Ok(key) = std::env::var("OPEN_TYPELESS_API_KEY") {
            if !key.trim().is_empty() {
                return Ok(key.trim().to_string());
            }
        }
        let path = self.api_key_file.clone().unwrap_or_else(|| dir.join("api-key"));
        let key = std::fs::read_to_string(&path)
            .map_err(|e| format!("no API key: {}: {e}", path.display()))?;
        if key.trim().is_empty() {
            return Err(format!("no API key: {} is empty", path.display()));
        }
        Ok(key.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_partial_file_keeps_the_other_defaults() {
        let config: Config =
            serde_json::from_str(r#"{"min_words": 3, "vocabulary": ["Strapi"]}"#).unwrap();
        assert_eq!(config.min_words, 3);
        assert_eq!(config.vocabulary, vec!["Strapi"]);
        assert_eq!(config.models, Config::default().models);
    }

    #[test]
    fn an_unknown_field_is_an_error() {
        assert!(serde_json::from_str::<Config>(r#"{"min_word": 3}"#).is_err());
    }

    #[test]
    fn a_missing_file_means_defaults() {
        let dir = std::env::temp_dir().join("open-typeless-no-such-dir");
        assert_eq!(Config::load(&dir), Ok(Config::default()));
    }
}
