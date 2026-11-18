//! The rewrite pipeline against a stand-in endpoint that plays back scripted replies.

use open_typeless::config::{Config, ModelChoice};
use open_typeless::rewrite;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;

/// A reply the stand-in endpoint gives to one request.
enum Reply {
    Text(&'static str),
    /// A reply the model stopped writing before it was finished.
    CutOff(&'static str),
    Status(u16),
    /// HTTP 429 with a `Retry-After` header of this many seconds.
    RateLimited(&'static str),
    /// Accept the request and never answer.
    Hang,
}

/// Serves `replies` in order, one per request. Returns the base URL and a
/// channel that yields each request body as it arrives.
fn endpoint(replies: Vec<Reply>) -> (String, mpsc::Receiver<serde_json::Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (seen, requests) = mpsc::channel();
    std::thread::spawn(move || {
        for reply in replies {
            let Ok((stream, _)) = listener.accept() else { return };
            let mut reader = BufReader::new(stream);
            let mut length = 0;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let _ = seen.send(serde_json::from_slice(&body).unwrap());

            let completion = |text: &str, finish: &str| {
                serde_json::json!({"choices": [{"message": {"content": text}, "finish_reason": finish}]}).to_string()
            };
            let mut extra_header = String::new();
            let (status, payload) = match reply {
                Reply::Text(text) => (200, completion(text, "stop")),
                Reply::CutOff(text) => (200, completion(text, "length")),
                Reply::Status(code) => (code, r#"{"error":"scripted"}"#.to_string()),
                Reply::RateLimited(seconds) => {
                    extra_header = format!("Retry-After: {seconds}\r\n");
                    (429, r#"{"error":"scripted"}"#.to_string())
                }
                Reply::Hang => {
                    // Hold the connection open elsewhere so the next request can still be served.
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(5));
                        drop(reader);
                    });
                    continue;
                }
            };
            let _ = write!(
                reader.get_mut(),
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra_header}Content-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.len()
            );
        }
    });
    (url, requests)
}

fn config(base_url: String) -> Config {
    let model = |name: &str| ModelChoice { model: name.into(), extra: Default::default() };
    Config { base_url, models: vec![model("first"), model("second")], ..Config::default() }
}

const TRANSCRIPT: &str = "so um I want you to look at the login page and uh tell me why the button is not working on mobile no wait on tablet";
const CLEAN: &str = "I want you to look at the login page and tell me why the button is not working on tablet.";

#[test]
fn a_good_rewrite_replaces_the_transcript() {
    let (url, requests) = endpoint(vec![Reply::Text(CLEAN)]);
    let outcome = rewrite(&config(url), "key", "RULES", TRANSCRIPT);

    assert!(outcome.rewritten);
    assert_eq!(outcome.text, CLEAN);
    let request = requests.recv().unwrap();
    assert_eq!(request["model"], "first");
    assert_eq!(request["messages"][0]["content"], "RULES");
    assert!(request["messages"][1]["content"].as_str().unwrap().contains(TRANSCRIPT));
}

#[test]
fn extra_request_fields_and_vocabulary_reach_the_model() {
    let (url, requests) = endpoint(vec![Reply::Text(CLEAN)]);
    let mut config = config(url);
    config.models[0].extra.insert("reasoning_effort".into(), "none".into());
    config.vocabulary = vec!["Strapi".into()];
    rewrite(&config, "key", "RULES", TRANSCRIPT);

    let request = requests.recv().unwrap();
    assert_eq!(request["reasoning_effort"], "none");
    assert!(request["messages"][0]["content"].as_str().unwrap().contains("- Strapi"));
}

#[test]
fn a_rate_limited_model_falls_through_to_the_next() {
    let (url, requests) = endpoint(vec![Reply::Status(429), Reply::Text(CLEAN)]);
    let outcome = rewrite(&config(url), "key", "RULES", TRANSCRIPT);

    assert_eq!(outcome.text, CLEAN);
    assert_eq!(outcome.attempts[0].result, "rate limited");
    assert_eq!(requests.iter().take(2).last().unwrap()["model"], "second");
}

#[test]
fn a_short_rate_limit_is_waited_out_on_the_same_model() {
    let (url, requests) = endpoint(vec![Reply::RateLimited("0.2"), Reply::Text(CLEAN)]);
    let outcome = rewrite(&config(url), "key", "RULES", TRANSCRIPT);

    assert_eq!(outcome.text, CLEAN);
    assert_eq!(outcome.attempts.len(), 1);
    assert_eq!(outcome.attempts[0].model, "first");
    assert_eq!(requests.iter().take(2).last().unwrap()["model"], "first");
}

#[test]
fn a_long_rate_limit_moves_on_to_the_next_model() {
    let (url, requests) = endpoint(vec![Reply::RateLimited("17"), Reply::Text(CLEAN)]);
    let started = std::time::Instant::now();
    let outcome = rewrite(&config(url), "key", "RULES", TRANSCRIPT);

    assert_eq!(outcome.text, CLEAN);
    assert_eq!(requests.iter().take(2).last().unwrap()["model"], "second");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn a_reply_that_was_cut_off_is_refused() {
    let (url, _requests) = endpoint(vec![Reply::CutOff("I want you to look at the login page and"), Reply::Text(CLEAN)]);
    let outcome = rewrite(&config(url), "key", "RULES", TRANSCRIPT);

    assert_eq!(outcome.text, CLEAN);
    assert!(outcome.attempts[0].result.contains("cut off"));
}

#[test]
fn a_rewrite_that_carried_out_the_request_is_refused() {
    let (url, _requests) = endpoint(vec![Reply::Text("Check tablet button."), Reply::Text(CLEAN)]);
    let outcome = rewrite(&config(url), "key", "RULES", TRANSCRIPT);

    assert_eq!(outcome.text, CLEAN);
    assert!(outcome.attempts[0].result.contains("too short"));
    assert_eq!(outcome.attempts[1].result, "accepted");
}

#[test]
fn when_every_model_fails_the_transcript_comes_back_unchanged() {
    let (url, _requests) = endpoint(vec![Reply::Status(500), Reply::Text("")]);
    let outcome = rewrite(&config(url), "key", "RULES", TRANSCRIPT);

    assert!(!outcome.rewritten);
    assert_eq!(outcome.text, TRANSCRIPT);
    assert_eq!(outcome.attempts.len(), 2);
}

#[test]
fn a_model_that_never_answers_costs_only_its_timeout() {
    let (url, _requests) = endpoint(vec![Reply::Hang, Reply::Text(CLEAN)]);
    let mut config = config(url);
    config.request_timeout_ms = 300;
    let started = std::time::Instant::now();
    let outcome = rewrite(&config, "key", "RULES", TRANSCRIPT);

    assert_eq!(outcome.text, CLEAN);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[test]
fn no_model_is_tried_once_the_time_budget_is_spent() {
    let (url, _requests) = endpoint(vec![Reply::Hang, Reply::Text(CLEAN)]);
    let mut config = config(url);
    config.request_timeout_ms = 300;
    config.total_budget_ms = 300;
    let outcome = rewrite(&config, "key", "RULES", TRANSCRIPT);

    assert!(!outcome.rewritten);
    assert_eq!(outcome.text, TRANSCRIPT);
    assert_eq!(outcome.attempts.len(), 1);
}

#[test]
fn a_very_short_dictation_is_pasted_without_a_model_call() {
    let (url, requests) = endpoint(vec![]);
    let outcome = rewrite(&config(url), "key", "RULES", "yes go ahead");

    assert_eq!(outcome.text, "yes go ahead");
    assert!(outcome.attempts.is_empty());
    assert!(requests.try_recv().is_err());
}
