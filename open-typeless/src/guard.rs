//! Decides in plain code whether a rewrite may replace the transcript.
//!
//! A model that answers the dictation instead of rewriting it returns far less
//! (or far more) text than was spoken, so length is the cheapest reliable signal.

/// Why a rewrite was refused.
#[derive(Debug, Clone, PartialEq)]
pub enum Rejection {
    Empty,
    /// Much shorter than the transcript: the model summarised or carried out a request.
    TooShort { words_in: usize, words_out: usize },
    /// Much longer than the transcript: the model answered or invented content.
    TooLong { words_in: usize, words_out: usize },
    /// One stretch of the dictation left almost no trace in the rewrite.
    PartMissing { part: usize, of: usize },
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Rejection::Empty => write!(f, "empty rewrite"),
            Rejection::TooShort { words_in, words_out } => {
                write!(f, "rewrite too short ({words_out} words from {words_in})")
            }
            Rejection::TooLong { words_in, words_out } => {
                write!(f, "rewrite too long ({words_out} words from {words_in})")
            }
            Rejection::PartMissing { part, of } => {
                write!(f, "part {part} of {of} of the dictation is missing from the rewrite")
            }
        }
    }
}

pub fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Transcripts of at least this many words get the stricter lower bound.
const LONG_TRANSCRIPT_WORDS: usize = 40;
/// Faithful rewrites of long dictations kept 68% or more of the words; the ones
/// that carried out the request kept under 30%.
const MIN_SHARE_LONG: f64 = 0.5;
/// Short dictations can lose more to fillers and self-corrections.
const MIN_SHARE_SHORT: f64 = 0.4;
const MAX_SHARE: f64 = 1.4;
/// Allowance for a title line and list markers.
const MAX_EXTRA_WORDS: usize = 15;

pub fn check(transcript: &str, rewrite: &str) -> Result<(), Rejection> {
    let words_in = word_count(transcript);
    let words_out = word_count(rewrite);
    if words_out == 0 {
        return Err(Rejection::Empty);
    }
    let min_share = if words_in >= LONG_TRANSCRIPT_WORDS {
        MIN_SHARE_LONG
    } else {
        MIN_SHARE_SHORT
    };
    if (words_out as f64) < (words_in as f64) * min_share {
        return Err(Rejection::TooShort { words_in, words_out });
    }
    if (words_out as f64) > (words_in as f64) * MAX_SHARE + MAX_EXTRA_WORDS as f64 {
        return Err(Rejection::TooLong { words_in, words_out });
    }
    match missing_part(transcript, rewrite) {
        Some(part) => Err(Rejection::PartMissing { part, of: PARTS }),
        None => Ok(()),
    }
}

/// The dictation is checked in this many consecutive stretches.
const PARTS: usize = 4;
/// Below this length a stretch is too short to judge.
const MIN_WORDS_FOR_PARTS: usize = 80;
/// A stretch needs at least this many distinctive words to be judged.
const MIN_DISTINCTIVE: usize = 4;
/// Words are compared by their first letters, so "handling" matches "handles".
const KEY_LETTERS: usize = 5;
/// Measured on real dictations: faithful rewrites kept 50% or more of every
/// stretch's distinctive words; rewrites that dropped or cut off a stretch
/// kept 39% or less of it.
const MIN_PART_COVERAGE: f64 = 0.45;

/// The first stretch of the transcript (counted from 1) whose distinctive
/// words are mostly absent from the rewrite. Rewording keeps most longer
/// words, so a stretch that leaves no trace was dropped or cut off.
fn missing_part(transcript: &str, rewrite: &str) -> Option<usize> {
    let spoken = word_keys(transcript);
    if spoken.len() < MIN_WORDS_FOR_PARTS {
        return None;
    }
    let written: std::collections::HashSet<String> = word_keys(rewrite).into_iter().collect();
    let size = spoken.len() / PARTS;
    (0..PARTS).find_map(|index| {
        let end = if index + 1 == PARTS { spoken.len() } else { (index + 1) * size };
        // Short words are too common to tell one stretch from another.
        let distinctive: std::collections::HashSet<&String> = spoken[index * size..end]
            .iter()
            .filter(|key| key.chars().count() >= KEY_LETTERS)
            .collect();
        if distinctive.len() < MIN_DISTINCTIVE {
            return None;
        }
        let kept = distinctive.iter().filter(|key| written.contains(**key)).count();
        ((kept as f64) < distinctive.len() as f64 * MIN_PART_COVERAGE).then_some(index + 1)
    })
}

/// Each word, lowercased and cut to its first letters.
fn word_keys(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_lowercase().chars().take(KEY_LETTERS).collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(n: usize) -> String {
        vec!["word"; n].join(" ")
    }

    #[test]
    fn accepts_a_rewrite_of_similar_length() {
        assert_eq!(check(&words(159), &words(170)), Ok(()));
        assert_eq!(check(&words(168), &words(114)), Ok(()));
    }

    #[test]
    fn rejects_a_rewrite_that_carried_out_the_request() {
        // Real case: 159 spoken words came back as a 37-word tool description.
        assert_eq!(
            check(&words(159), &words(37)),
            Err(Rejection::TooShort { words_in: 159, words_out: 37 })
        );
    }

    #[test]
    fn rejects_an_empty_rewrite() {
        assert_eq!(check(&words(20), "  \n"), Err(Rejection::Empty));
    }

    #[test]
    fn rejects_a_rewrite_that_answered_at_length() {
        assert!(matches!(check(&words(30), &words(120)), Err(Rejection::TooLong { .. })));
    }

    #[test]
    fn lets_a_short_dictation_shrink_through_fillers_and_corrections() {
        // 23 spoken words, 16 after cleanup.
        assert_eq!(check(&words(23), &words(16)), Ok(()));
        assert!(check(&words(23), &words(8)).is_err());
    }

    #[test]
    fn allows_list_markers_and_some_added_words() {
        assert_eq!(check(&words(50), &words(80)), Ok(()));
    }

    /// 100 words, each distinct in its first letters, to be read as four stretches of 25.
    fn dictation() -> Vec<String> {
        (0..100).map(|i| format!("w{i:03}xyz")).collect()
    }

    #[test]
    fn accepts_a_rewrite_that_rewords_but_covers_every_part() {
        let spoken = dictation();
        // Every third word reworded away.
        let written: Vec<&str> = spoken.iter().enumerate().filter(|(i, _)| i % 3 != 0).map(|(_, w)| w.as_str()).collect();
        assert_eq!(check(&spoken.join(" "), &written.join(" ")), Ok(()));
    }

    #[test]
    fn rejects_a_rewrite_that_dropped_the_opening() {
        let spoken = dictation();
        let written = format!("{} {}", spoken[25..].join(" "), words(20));
        assert_eq!(check(&spoken.join(" "), &written), Err(Rejection::PartMissing { part: 1, of: 4 }));
    }

    #[test]
    fn rejects_a_rewrite_that_stops_before_the_end() {
        let spoken = dictation();
        let written = format!("{} {}", spoken[..75].join(" "), words(20));
        assert_eq!(check(&spoken.join(" "), &written), Err(Rejection::PartMissing { part: 4, of: 4 }));
    }

    #[test]
    fn word_endings_do_not_count_as_missing() {
        assert_eq!(word_keys("Handling the features"), word_keys("handles the feature"));
    }
}
