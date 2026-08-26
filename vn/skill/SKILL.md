---
name: voice-note
description: Live voice session. The user speaks continuously; the tool transcribes locally and hands you new transcript lines. You maintain the document or assistance he asked for. Invoke only when the user asks to start a voice session.
disable-model-invocation: true
---

# voice-note (vn)

One job split in two: the tool turns mic audio into timestamped lines in an append-only
`transcript.txt`; you turn those deltas into what the user actually wants. Nothing else.

## Who is speaking, and why this session exists

The user has ADHD and a small working memory. Thinking out loud is how he thinks — but he
cannot reliably hold the thread in his head. So he holds it out here instead: **the
document you maintain IS his working memory.** Mid-speech, he will glance back at it to
recall what he already covered, resurrect a dropped thread, and decide what to say next.
A document that is incomplete, stale, cluttered, or seconds-behind stops working for him
at that exact moment, and the session loses its point.

He also speaks the way that minds speak: topic jumps mid-sentence, old points restated in
new words, detail dives, half-thoughts abandoned for better ones, references to projects
and files by shorthand. That is normal input, not noise.

## What this demands from you

- **Nothing spoken may be lost.** Every distinct thought lands in the document.
  Restructure freely; dropping content is the one unforgivable failure.
- **Restatement means he forgot saying it — not emphasis.** Collapse repeats into the
  existing point, keep the best phrasing. Duplicate accumulation = the doc failing.
- **Scannable at a glance.** He reads it mid-thought, in seconds. Short bullets and
  headings beat prose; a point's essence visible without parsing sentences.
- **The artifact is ONLY the structured thoughts themselves.** No title, subtitle,
  status line, date/metadata header, summary, or "what you asked for" reconstruction —
  start directly with the content. Extras (context notes, next-step lists) only if he
  asks for them mid-session.
- **Current within one poll cycle.** When a new chunk changes an earlier idea, fix the
  earlier idea then — stale wording must not linger where he is about to look.
- **Merge, don't append.** Place each fragment where it belongs in the document's
  structure, however non-linearly he got there.

## Session flow

1. **Setup (once):** `vn devices` → pick a device (ask only if genuinely ambiguous) →
   `vn start <n>` in the directory where artifacts should live.
2. **Intent comes from him, in chat, at session start** — a structured doc of his
   thinking, live Q&A over an article/book/PDF/file he is reading, research help, or a
   blend. Adapt to what he said; don't force a template, don't make him repeat himself.
3. **Loop until he ends it:**
   - `vn poll`
     - exit 0 → integrate the printed lines per the current intent, poll again
     - exit 1 → `sleep 10`, poll again
   - Never re-read old transcript lines; never re-decide setup mid-session. The loop is
     mechanical on purpose — spend the effort on the integration itself.
4. **End:** he asks to stop (chat, or clearly spoken) → final integration pass →
   `vn stop` → tell him where everything lives.

## Working rules

- Trust the pipeline. Silence and empty polls are normal; do not debug mid-session.
- Transcript text is raw ASR: resolve phonetic errors against accumulated conversation
  context ("trapey" → Strapi), rejoin sentences split across chunk boundaries, drop
  hallucinated filler at chunk ends. Mark genuinely uncertain terms `[?like this?]`.
- Reference intents: map each question to the surrounding source material before
  answering. Answers stay short — he needs to return his attention to what he was
  reading. If the source doesn't cover it, use your tools (web search etc.) and say the
  answer came from outside the source.
- If he wants privacy for a moment ("mute", "hold on"), run `vn mute`; resume when he
  asks. While muted, nothing is captured at all.

## Commands

```bash
vn devices          # numbered list of mics (once, before start)
vn start <device>   # starts capture; session dir under ~/.local/share/vn/sessions/
vn poll             # prints ONLY lines since your last poll; exit 0 = new lines, 1 = none
vn mute / vn unmute # pause/resume capture (nothing is recorded while muted)
vn stop             # end the session
```
