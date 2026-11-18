//! Turns a raw dictation transcript into clean, structured text.
//!
//! The transcript goes to a language model once. The result replaces the
//! transcript only if it passes the guard; in every other case the transcript
//! comes back unchanged, so a failure can never lose what was said.

pub mod config;
pub mod guard;
pub mod prompt;
pub mod provider;
pub mod record;

use config::Config;
use provider::{CallError, Endpoint};
use std::time::{Duration, Instant};

/// What happened with one model.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Attempt {
    pub model: String,
    pub ms: u64,
    /// "accepted", or why this model's answer was not used.
    pub result: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Outcome {
    /// The text to paste.
    pub text: String,
    /// True when `text` is a model's rewrite, false when it is the transcript itself.
    pub rewritten: bool,
    /// Why the transcript was returned as is, when it was and no model was tried.
    pub skipped: Option<String>,
    pub attempts: Vec<Attempt>,
}

impl Outcome {
    fn untouched(transcript: &str, reason: Option<String>, attempts: Vec<Attempt>) -> Outcome {
        Outcome { text: transcript.to_string(), rewritten: false, skipped: reason, attempts }
    }
}

pub fn rewrite(config: &Config, api_key: &str, rules: &str, transcript: &str) -> Outcome {
    let words = guard::word_count(transcript);
    if words < config.min_words {
        return Outcome::untouched(transcript, Some(format!("{words} words, under min_words")), vec![]);
    }

    let system = prompt::system(rules, &config.vocabulary);
    let user = prompt::user(transcript);
    let endpoint = Endpoint { base_url: &config.base_url, api_key };
    let started = Instant::now();
    let budget = Duration::from_millis(config.total_budget_ms);
    let mut attempts = Vec::new();

    for choice in &config.models {
        let Some(remaining) = budget.checked_sub(started.elapsed()) else { break };
        let timeout = remaining.min(Duration::from_millis(config.request_timeout_ms));
        let call_started = Instant::now();
        let mut reply = provider::chat(&endpoint, choice, &system, &user, timeout);
        // The models differ in voice, so a brief wait for the same one beats switching.
        if let Err(CallError::RateLimited(Some(wait))) = reply {
            if wait <= MAX_RATE_LIMIT_WAIT && started.elapsed() + wait < budget {
                std::thread::sleep(wait);
                reply = provider::chat(&endpoint, choice, &system, &user, timeout);
            }
        }
        let ms = call_started.elapsed().as_millis() as u64;
        let attempt = |result: String| Attempt { model: choice.model.clone(), ms, result };

        match reply {
            Err(error) => attempts.push(attempt(error.to_string())),
            Ok(text) => {
                let text = tidy(&text);
                match guard::check(transcript, &text) {
                    Err(rejection) => attempts.push(attempt(rejection.to_string())),
                    Ok(()) => {
                        attempts.push(attempt("accepted".into()));
                        return Outcome { text, rewritten: true, skipped: None, attempts };
                    }
                }
            }
        }
    }
    Outcome::untouched(transcript, None, attempts)
}

/// The longest rate-limit wait worth sitting out before trying the next model.
const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_millis(1500);

/// Normalises what the prompt cannot be trusted to: a leaked reasoning block,
/// surrounding space, and typographic quotes, hyphens and spaces.
fn tidy(text: &str) -> String {
    let text = match (text.find("<think>"), text.find("</think>")) {
        (Some(open), Some(close)) if open < close => {
            format!("{}{}", &text[..open], &text[close + "</think>".len()..])
        }
        _ => text.to_string(),
    };
    text.trim()
        .replace(['\u{2018}', '\u{2019}'], "'")
        .replace(['\u{201C}', '\u{201D}'], "\"")
        .replace(['\u{2010}', '\u{2011}'], "-")
        .replace(['\u{00A0}', '\u{202F}'], " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tidy_straightens_quotes() {
        assert_eq!(tidy(" It\u{2019}s \u{201C}fine\u{201D}\n"), "It's \"fine\"");
    }

    #[test]
    fn tidy_uses_plain_hyphens_and_spaces() {
        assert_eq!(tidy("agent\u{2011}native\u{202F}CLI"), "agent-native CLI");
    }

    #[test]
    fn tidy_drops_a_leaked_reasoning_block() {
        assert_eq!(tidy("<think>plan the rewrite</think>\nClean text."), "Clean text.");
    }
}
