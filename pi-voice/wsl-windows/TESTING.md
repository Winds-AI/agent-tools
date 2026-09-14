# Verification

Updated September 12, 2026. Tested in WSL Ubuntu 26.04 with Pi 0.85.1, Node 24.18.1, Python 3.14, ONNX Runtime 1.30.0, and PyAV 18.1.0.

## Automated checks

- `npm test`: **32 passed**. Includes Pi preview wrapping, the fixed system-prompt tail, optional launcher behavior, conversational handoffs, late corrections, no duplicate submissions, auto-sleep, hard mute during startup, stale warmup callbacks, speech during close, silent output, buffered playback, failed submission, idempotent WebSocket close, shutdown persistence, native API-key auth, fresh credential resolution, missing credentials, and cancellation during auth lookup.
- `npm run test:audio`: **6 passed**. Covers original pre-roll retention, speech at a close boundary, backlog draining, uninterrupted 1.5×/1× filter switching, pitch preservation, scheduling-stall recovery, bounded failure, and real Silero inference on silence.
- `npm run check` and Bash syntax checks passed.
- The TypeScript entrypoint passed strict checking against the installed Pi/TUI declarations. The temporary compiler and its machine-specific configuration stay in ignored `work/`.

## Native Pi login follow-up

The actual Pi 0.85.1 TUI was tested with an isolated `PI_CODING_AGENT_DIR` and a dummy credential. Through `/login → Sign in with an API key → Voice Agent`, Pi displayed its native secret-input dialog and saved an `api_key` credential in its auth file. A completely new Pi process read that credential through `ctx.modelRegistry.getProviderAuth("voice-agent")` and supplied it to the voice connection. Voice Agent exposed zero coding models; the existing selected coding provider stayed unchanged.

Native `/logout` followed by selecting Voice Agent removed the test credential. The real user auth file, settings, and `.bashrc` retained their pre-test hashes. Test connections and microphone capture were simulated for this auth-only follow-up; no paid API calls were made. The test tmux sessions were closed. Evidence: `work/results/native-login-events.jsonl`.

## Native audio and real Live API

The production VoiceSession, Live transport, media adapter, and Python worker were exercised through isolated tmux runs. Synthetic English recordings were fed into a dedicated PulseAudio source; model output went to a separate silent test sink. These trials did not capture or upload the user's microphone.

The first trial retained the complete 27-word request but did not reach automatic sleep before the QA timeout. Its session was closed explicitly and finalized at 63 seconds. The initial run lacked enough buffer telemetry to identify its exact cause. An overly tight backlog guard was subsequently relaxed and regression-tested so normal small audio buffering cannot block sleep indefinitely.

An instrumented run completed two automatic cycles:

1. A request containing “fifteen, not fifty,” a correction to “twelve,” “two point five seconds,” and “Do not change the login page” retained all 27 reference words after case/punctuation normalization. Catch-up changed from 1.5× to 1×.
2. Automatic closure finalized at 30 seconds. The microphone stayed locally active, and three seconds of quiet plus a Pi-result update opened no new API connection.
3. The next spoken request woke a fresh session with saved text context and retained its opening words. That session closed automatically and finalized at 15 seconds.

A final production-code API run, after the buffer and worker-stream fixes, recognized “Set the retry limit to 15, not 50,” returned to 1×, slept automatically, stayed disconnected during quiet, and finalized at 15 seconds.

Total Live usage for this implementation's API tests was **123 finalized seconds**, approximately **$0.1025** at $0.05/minute. This includes the initial unsuccessful sleep trial. No paid coding-model calls were used.

Separate native audio runs with a deterministic local connection verified that local listening remains armed after idle and all child processes exit on shutdown.

Evidence: `work/results/auto-live-first.*`, `auto-live.*`, `auto-live-final.*`, and `native-idle-final.log`.

## Pi in tmux

The actual Pi TUI loaded the extension through an isolated QA adapter and a deterministic local coding provider. Tests confirmed:

- `/m` enabled local listening; simulated speech connected. `/m` again mutes.
- The preview used Pi's wrapped Text component.
- A delegation arrived as a native U/A user message.
- The coding provider received the exact voice-mode note at the end of its system prompt.
- Pi returned `VOICE_TEST_PASSED` in the console.
- The result was supplied only as quiet context; no commentary request was sent.
- Idle closure returned to local listening.
- `/reload` stopped the listener and returned to off.

This Pi test used simulated Live events; real API/audio testing is described separately above. Evidence: `work/results/auto-ui-*`.

Pi settings and `.bashrc` retained their pre-test checksums. No global extension installation or provider change was made. Dedicated QA tmux sessions and PulseAudio modules were removed.

## Scope of confidence

The tests cover synthetic English speech, transport, buffer continuity, pitch, lifecycle, Pi APIs, and error handling. They do not establish recognition quality for every accent or noisy room, or fix the previously reported model interruption behavior. Capture remains duplex; local VAD here controls wake/sleep, not assistant interruption.

The prior detector benchmark measured 73–123 ms to confirmed onset on 18 synthetic cases, excluding real microphone and OS capture delay. The persistent worker avoids reloading the detector for each automatic wake. Real connection latency still varies; catch-up preserves the start of speech but cannot eliminate connection delay.

Graceful close confirms usage when `session.closed` arrives. If the network disappears first, final billing remains explicitly unconfirmed. Reconnection restores bounded text history, not the original audio state. Model-selected delegation and transcription remain probabilistic.

Historical plans, fixtures, and investigations stay in ignored `work/`; they are not part of the runtime.
