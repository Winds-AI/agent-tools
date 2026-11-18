//! One chat-completion call to an OpenAI-compatible endpoint.

use crate::config::ModelChoice;
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// With the wait the endpoint asked for, when it said.
    RateLimited(Option<Duration>),
    /// The model stopped before finishing, so the end of the text is missing.
    Truncated(String),
    /// The endpoint answered with an error status.
    Status(u16, String),
    /// No usable answer arrived: connection, timeout, or a body that is not a completion.
    Transport(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::RateLimited(_) => write!(f, "rate limited"),
            CallError::Truncated(reason) => write!(f, "reply cut off ({reason})"),
            CallError::Status(code, body) => write!(f, "HTTP {code}: {body}"),
            CallError::Transport(reason) => write!(f, "{reason}"),
        }
    }
}

pub struct Endpoint<'a> {
    pub base_url: &'a str,
    pub api_key: &'a str,
}

pub fn chat(
    endpoint: &Endpoint,
    choice: &ModelChoice,
    system: &str,
    user: &str,
    timeout: Duration,
) -> Result<String, CallError> {
    let mut body = json!({
        "model": choice.model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    });
    for (key, value) in &choice.extra {
        body[key.as_str()] = value.clone();
    }

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into();
    let url = format!("{}/chat/completions", endpoint.base_url.trim_end_matches('/'));
    let mut response = agent
        .post(&url)
        .header("Authorization", &format!("Bearer {}", endpoint.api_key))
        .send_json(&body)
        .map_err(|e| CallError::Transport(e.to_string()))?;

    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(Duration::from_secs_f64);
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|e| CallError::Transport(e.to_string()))?;
    if status == 429 {
        return Err(CallError::RateLimited(retry_after));
    }
    if !(200..300).contains(&status) {
        return Err(CallError::Status(status, text.chars().take(300).collect()));
    }
    let reply: Value =
        serde_json::from_str(&text).map_err(|e| CallError::Transport(format!("bad JSON: {e}")))?;
    let choice = &reply["choices"][0];
    // Anything but a normal stop means the text is incomplete.
    if let Some(reason) = choice["finish_reason"].as_str() {
        if reason != "stop" {
            return Err(CallError::Truncated(reason.to_string()));
        }
    }
    choice["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| CallError::Transport("reply has no message content".into()))
}
