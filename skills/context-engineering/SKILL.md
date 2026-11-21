---
name: context-engineering
description: How to think when designing and iterating prompts and runtime context for any AI system (agents in harnesses, single API calls, recurring tasks, multi-model pipelines, embedded AI). Use when authoring, auditing, or refining system prompts, tool surfaces, dynamic context, or prompt-iteration loops.
---

# Context Engineering

Prompt engineering is really **context engineering**: shaping everything the target model sees at runtime — instructions, tool names/descriptions/schemas/returns, API and inference parameters, message roles, and dynamic data flow — so it makes the right decisions reliably.

Treat this skill as an empirical engineering lens, not a fixed checklist. Every domain, harness, and model has variables this file cannot anticipate. Inspect the real system, form hypotheses, observe real outputs, and adapt.

## 1. System vs. Context Boundary

Before writing a single line of prompt, decide what belongs **outside** the LLM:

- **Solve deterministic problems deterministically.** Validation, parsing, routing rules, state tracking, permissions, and rigid formatting belong in code, schemas, or tool interfaces — not prose instructions.
- **Inspect the full runtime surface.** How the API or harness feeds data in, which parameters are exposed (reasoning effort, structured outputs, temperature, tool choice, stop controls), and how tools are named, described, typed, and returned often matter more than wording tweaks. A cleaner tool schema beats twenty lines of prompt rules.
- **Think beyond static prompt text.** Don't default to stuffing everything into one static system prompt. Consider non-standard, system-level moves when they fit: progressive disclosure (load reference context on demand), dynamically swapping or pruning context slices across turns, splitting one overloaded call into two focused calls, or removing harness friction.
- **Protect prompt caching.** In agentic loops and repeated calls, caching directly drives latency and cost. Keep static content in the prefix (stable instructions, tool definitions, fixed examples) and place dynamic content (timestamps, per-turn state, retrieved data) later so nothing volatile busts the cache.

## 2. Author Knowledge ≠ Target Context

You must understand the whole system, codebase, and edge cases deeply. **The target model should not receive all of what you know.**

- Dumping author-level architecture, upstream/downstream details, or defensive explanations into the prompt bloats context, dilutes focus, and invites the target model to second-guess outside its role.
- Every piece of context must earn its place by improving the target model's runtime decisions. Include a brief *why* only when it sharpens judgment on edge cases.
- Keep context lean so critical instructions are not buried in noise — without burning effort trying to reverse-engineer opaque model attention mechanics.

## 3. Anchor on the Target & Hunt Unknowns First

Do not write prompts as if the target model were you. Anchor every decision on the target's actual axes:

- **Exact model & family** (and its post-training quirks: literalness, verbosity, tool-use habits, instruction-following strength)
- **Reasoning level** (non-reasoning, low, medium, high)
- **Modalities** (text, voice/realtime, vision, audio, mixed)
- **Knowledge cutoff** (what it can be assumed to know vs. what must be supplied)
- **Runtime budget** (latency, token cost, and reliability requirements)

Before drafting, close unknowns on **both** sides:

1. **Author-side unknowns:** Read the real codebase, SDK/API behavior, and real input/output logs. Check official model documentation *and* credible community or open-source findings so you don't reinvent what practitioners have already mapped — use those findings as priors to focus your work, not blind dogma. Surface unstated goals, edge cases, and human taste directly with the user; capable models confidently fill ambiguity with guesses.
2. **Target-side unknowns (selective baseline probing):** Don't guess what the target model knows or how it reads critical terms. When API access and budget allow, run small, isolated one-off calls against the target model on **high-leverage unknowns** only — e.g., whether it accurately knows a post-cutoff library/API, or how it interprets key domain words you plan to use. Use that baseline to supply *only* what is missing or misread.
3. **Adapt when probing isn't available:** If there is no API access, a tight budget cap, or offline constraints, rely on docs, real code/logs, and community priors, keep the first draft lean, and explicitly mark which assumptions remain unverified.

## 4. Drafting: Principles Over Spoon-Feeding

- **Default to teaching *how to think*.** Strong and reasoning models generalize far better from clear mental models than from brittle lists of edge-case rules. Aim for:
  - Clear intent and real-world impact
  - Underlying principles and **tie-breakers** for competing goals (most prompt failures happen where two rules collide with no priority)
  - Hard boundaries (non-negotiables)
  - Explicit **escape hatches** — what to do when information is missing, uncertain, or out of scope (permission to abstain, ask, or stop early prevents hallucinated helpfulness)
  - A concrete definition of "done"
- **Prefer positive defaults over "DON'T" lists.** Saying what *to* do under ambiguity beats stacking prohibitions that leave the model guessing the intended behavior.
- **Calibrate guardrails to the target.** Principles alone shine on frontier reasoning models, where rigid step-by-step scripts can actively hurt. Smaller, faster, or non-reasoning models — or high-variance formatting/judgment tasks — may need concrete examples, rubrics, structured thinking, or strict output schemas where principles won't hold. Use them where they earn their keep, not by reflex.
- **Enforce trust boundaries.** Clearly separate trusted instructions from untrusted external data (user input, web pages, emails, tool outputs) so data is never mistaken for instructions.

## 5. Verification & Feedback Loops

- **Isolated probes ≠ real-world behavior.** A model that passes a clean one-off knowledge probe can still fail or fall back to old habits once tools, history, and messy real inputs enter context. Always validate under realistic full-context conditions.
- **Test across a representative spread.** Cover normal inputs, tricky edge cases, and messy/adversarial/empty inputs. Because outputs vary, run critical cases more than once before declaring a win.
- **Build verification into the loop.** Match the verifier to the task:
  - Deterministic checks (tests, schema validation, diff/type checks, log metrics) wherever possible.
  - Explicit rubrics or independent / multi-model critics ("hill climbing") for subjective judgment work where there is no binary pass/fail.
- **Think beyond a single static prompt.** For ongoing, judgment-heavy tasks, products and taste evolve and static prompts decay. Where appropriate, design a feedback loop so real corrections compound back into context, examples, or skills over time.

## 6. Iterating Without Patch Pile-Up

Never respond to a single bad output by appending `IMPORTANT: NEVER DO X`. Patching symptoms creates bloated, contradictory prompts and whack-a-mole regressions.

When something fails, **diagnose where the fault lives first**, checking in order:

1. **System / harness / tool / data shape** — did bad tool output, missing schema constraints, or harness friction cause it? Fix the system, not the prompt.
2. **Missing or noisy context** — did the target lack a critical fact, or drown in irrelevant ones?
3. **Conflicting or ambiguous framing** — did two instructions collide without a tie-breaker, or did the target read a key term differently than you intended?
4. **Target model / reasoning / modality mismatch** — are you asking this model tier or reasoning level for judgment it needs tighter scaffolding (or a different model) to execute?

Then iterate with discipline:

- **Generalize the fix.** Target the *class* of failure (missing mental model, missing context, unclear priority) rather than overfitting to one incident.
- **Prune as you go.** Remove instructions that aren't visibly moving behavior. Shorter, cleaner context almost always beats accumulated patches.
- **Guard against regressions.** Re-test earlier passing cases alongside the newly fixed failure before calling an iteration better.
