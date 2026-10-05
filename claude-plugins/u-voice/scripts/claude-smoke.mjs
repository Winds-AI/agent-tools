#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(ROOT, ".scratch", "claude-smoke");
const EVIDENCE_PATH = join(SCRATCH, "evidence.json");
const TOTAL_TIMEOUT_MS = 120_000;
const STARTUP_TIMEOUT_MS = 20_000;
const TOOL_START_TIMEOUT_MS = 45_000;
const DELEGATION_TIMEOUT_MS = 20_000;
const RESULT_TIMEOUT_MS = 110_000;
const MAX_BUDGET_USD = 0.20;
const INITIAL_PROMPT =
  "Initial color RED. Run precisely sleep 10 using Bash, then tell me chosen color. Do not run extra commands.";
const STEER_TEXT = "U: Change chosen color to BLUE. Continue after existing sleep finishes and reply COLOR_BLUE.";

class SmokeFailure extends Error {
  constructor(code, stage) {
    super(code);
    this.code = code;
    this.stage = stage;
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : undefined;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  if (!Number.isInteger(port) || port < 1) throw new SmokeFailure("port_unavailable", "prepare");
  return port;
}

function buildArgs() {
  return [
    "-p",
    "--plugin-dir",
    ROOT,
    "--model",
    "haiku",
    "--effort",
    "low",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--input-format",
    "stream-json",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--no-session-persistence",
    "--tools",
    "Bash,Read",
    "--allowedTools",
    "Bash(sleep *)",
    "--max-budget-usd",
    String(MAX_BUDGET_USD),
  ];
}

function createCapture() {
  return {
    outputBytes: 0,
    stderrBytes: 0,
    outputEvents: Object.create(null),
    model: undefined,
    result: undefined,
    visibleText: "",
    bashCalls: [],
    otherToolNames: [],
    toolUseIds: new Set(),
    malformedLines: 0,
  };
}

function addText(capture, value) {
  if (typeof value !== "string") return;
  if (capture.visibleText.length < 20_000) {
    capture.visibleText += value.slice(0, 20_000 - capture.visibleText.length);
  }
}

function recordToolUses(capture, content) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    if (typeof block.id === "string") {
      if (capture.toolUseIds.has(block.id)) continue;
      capture.toolUseIds.add(block.id);
    }
    const name = typeof block.name === "string" ? block.name : "unknown";
    if (name === "Bash") {
      capture.bashCalls.push({
        command: typeof block.input?.command === "string" ? block.input.command : undefined,
      });
    } else {
      capture.otherToolNames.push(name);
    }
  }
}

function recordOutputLine(capture, line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    capture.malformedLines++;
    return;
  }
  const type = typeof event?.type === "string" ? event.type : "unknown";
  capture.outputEvents[type] = (capture.outputEvents[type] ?? 0) + 1;

  if (type === "system" && event.subtype === "init" && typeof event.model === "string") {
    capture.model ??= event.model;
  }
  if (type === "assistant") {
    recordToolUses(capture, event.message?.content);
    for (const block of event.message?.content ?? []) {
      if (block?.type === "text") addText(capture, block.text);
    }
  }
  if (type === "stream_event") {
    const streamEvent = event.event;
    const block = streamEvent?.content_block;
    if (streamEvent?.type === "content_block_delta" && streamEvent.delta?.type === "text_delta") {
      addText(capture, streamEvent.delta.text);
    }
    if (streamEvent?.type === "content_block_start" && block?.type === "text") {
      addText(capture, block.text);
    }
  }
  if (type === "result") capture.result = event;
}

function parseSummary(capture) {
  const result = capture.result;
  const usage = result?.usage && typeof result.usage === "object" ? result.usage : {};
  const modelUsage = result?.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : {};
  const modelFromUsage = Object.keys(modelUsage).find((key) => key.length > 0);
  const finalText = typeof result?.result === "string" ? result.result : capture.visibleText;
  const isSuccess = Boolean(
    result && result.type === "result" && result.is_error !== true &&
      (result.subtype === "success" || result.subtype === undefined),
  );

  return {
    model: modelFromUsage ?? result?.model ?? capture.model ?? null,
    resultSubtype: typeof result?.subtype === "string" ? result.subtype : null,
    resultSuccess: isSuccess,
    totalCostUsd: finiteNumber(result?.total_cost_usd) ?? null,
    durationMs: safeTokenCount(result?.duration_ms) ?? null,
    usage: {
      inputTokens: safeTokenCount(usage.input_tokens) ?? null,
      outputTokens: safeTokenCount(usage.output_tokens) ?? null,
      cacheReadInputTokens: safeTokenCount(usage.cache_read_input_tokens) ?? null,
      cacheCreationInputTokens: safeTokenCount(usage.cache_creation_input_tokens) ?? null,
    },
    finalContainsColorBlue: /\bCOLOR_BLUE\b/.test(finalText),
  };
}

function summarizedAgentEvents(snapshot) {
  const events = Array.isArray(snapshot?.agentEvents) ? snapshot.agentEvents : [];
  const count = (kind, status) => events.filter(
    (event) => event.kind === kind && (status === undefined || event.status === status),
  ).length;
  return {
    total: events.length,
    toolStarted: count("tool", "started"),
    toolCompleted: count("tool", "completed"),
    toolErrors: count("tool", "error"),
    text: count("text"),
    final: count("final"),
    delivery: count("delivery"),
  };
}

function firstEvent(snapshot, kind, status) {
  return (snapshot?.agentEvents ?? []).find(
    (event) => event.kind === kind && (status === undefined || event.status === status),
  );
}

function findReceipt(snapshot, requestId) {
  return (snapshot?.receipts ?? []).findLast((receipt) => receipt.requestId === requestId);
}

function findReceipts(snapshot, requestId) {
  return (snapshot?.receipts ?? []).filter((receipt) => receipt.requestId === requestId);
}

async function fetchJson(url, token, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    throw new SmokeFailure("bridge_unreachable", options.stage ?? "bridge");
  }
  if (!response.ok) throw new SmokeFailure(`bridge_http_${response.status}`, options.stage ?? "bridge");
  try {
    return await response.json();
  } catch {
    throw new SmokeFailure("bridge_invalid_json", options.stage ?? "bridge");
  }
}

async function closeChild(child, closedPromise, bridgeUrl, token) {
  if (bridgeUrl) {
    try {
      await fetchJson(`${bridgeUrl}/shutdown`, token, { method: "POST", body: "{}", stage: "cleanup" });
    } catch {
      // It may have stopped as part of Claude's session teardown.
    }
  }
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin.end();
  } catch {}
  let timer;
  const exited = await Promise.race([
    closedPromise.then(() => true),
    new Promise((resolveTimer) => {
      timer = setTimeout(() => resolveTimer(false), 2500);
    }),
  ]);
  clearTimeout(timer);
  if (exited || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let termTimer;
  const termExited = await Promise.race([
    closedPromise.then(() => true),
    new Promise((resolveTimer) => {
      termTimer = setTimeout(() => resolveTimer(false), 2000);
    }),
  ]);
  clearTimeout(termTimer);
  if (!termExited && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function run() {
  const startedAt = new Date();
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  const startedClock = Date.now();
  const token = randomBytes(32).toString("hex");
  let port;
  let bridgeUrl;
  let child;
  let childError;
  let exitInfo = null;
  let snapshot = null;
  let lastStage = "prepare";
  let statePolls = 0;
  let healthChecks = 0;
  let stdoutBuffer = "";
  const capture = createCapture();
  let closedResolve;
  const closedPromise = new Promise((resolveClosed) => { closedResolve = resolveClosed; });
  let healthSeen = false;
  let stateSeen = false;
  let sentInitialUserMessage = false;
  let delegationPosted = false;
  let delegationResponseAccepted = false;
  let delegationReceiptAccepted = false;
  let sameTurn = false;
  let outputFailure = null;

  const safeFailure = (error) => ({
    stage: error instanceof SmokeFailure ? error.stage : lastStage,
    code: error instanceof SmokeFailure ? error.code : "runner_error",
    exitCode: exitInfo?.code ?? null,
    signal: exitInfo?.signal ?? null,
    stderrBytes: capture.stderrBytes,
    helperHealthy: healthSeen,
    authenticatedStateSeen: stateSeen,
    delegationPosted,
    delegationAccepted: delegationResponseAccepted,
  });

  const readState = async () => {
    statePolls++;
    snapshot = await fetchJson(`${bridgeUrl}/state`, token, { stage: lastStage });
    stateSeen = true;
    return snapshot;
  };

  const ensureRunning = () => {
    if (childError) throw new SmokeFailure("claude_spawn_failed", lastStage);
    if (exitInfo && !capture.result) throw new SmokeFailure("claude_exited_early", lastStage);
    if (Date.now() >= deadline) throw new SmokeFailure("total_timeout", lastStage);
    if (outputFailure) throw outputFailure;
  };

  const waitFor = async (stage, timeoutMs, predicate) => {
    lastStage = stage;
    const stageDeadline = Math.min(deadline, Date.now() + timeoutMs);
    while (Date.now() < stageDeadline) {
      ensureRunning();
      try {
        await readState();
      } catch (error) {
        if (error instanceof SmokeFailure && error.code !== "bridge_unreachable") throw error;
      }
      if (predicate(snapshot)) return snapshot;
      await delay(250);
    }
    throw new SmokeFailure(`${stage}_timeout`, stage);
  };

  let failure;
  let checks = {};
  let observed = {};
  let claudeSummary;
  try {
    await mkdir(SCRATCH, { recursive: true });
    port = await reservePort();
    bridgeUrl = `http://127.0.0.1:${port}`;
    lastStage = "launch";

    child = spawn("claude", buildArgs(), {
      cwd: SCRATCH,
      env: {
        ...process.env,
        UVOICE_AUTOSTART: "1",
        UVOICE_BRIDGE_TOKEN: token,
        UVOICE_PORT: String(port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.once("error", (error) => { childError = error; });
    child.once("close", (code, signal) => {
      exitInfo = { code, signal };
      closedResolve(exitInfo);
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      capture.outputBytes += Buffer.byteLength(chunk);
      if (capture.outputBytes > 8_000_000) {
        outputFailure = new SmokeFailure("claude_output_limit", lastStage);
        child.kill("SIGTERM");
        return;
      }
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > 8_000_000) {
        outputFailure = new SmokeFailure("claude_output_limit", lastStage);
        child.kill("SIGTERM");
        stdoutBuffer = "";
        return;
      }
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        recordOutputLine(capture, line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      capture.stderrBytes += Buffer.byteLength(chunk);
    });

    const initialMessage = {
      type: "user",
      message: { role: "user", content: INITIAL_PROMPT },
    };
    child.stdin.write(`${JSON.stringify(initialMessage)}\n`);
    sentInitialUserMessage = true;

    lastStage = "helper_startup";
    const startupDeadline = Math.min(deadline, Date.now() + STARTUP_TIMEOUT_MS);
    while (Date.now() < startupDeadline) {
      ensureRunning();
      healthChecks++;
      try {
        const health = await fetchJson(`${bridgeUrl}/health`, undefined, { stage: "helper_startup" });
        if (health.status === "ok") {
          healthSeen = true;
          break;
        }
      } catch (error) {
        if (error instanceof SmokeFailure && error.code !== "bridge_unreachable") throw error;
      }
      await delay(250);
    }
    if (!healthSeen) throw new SmokeFailure("helper_startup_timeout", "helper_startup");
    await readState();

    const currentTurnToolStart = () => {
      const bashTurn = firstEvent(snapshot, "tool", "started");
      const exactBash = capture.bashCalls.some((call) => call.command?.trim() === "sleep 10");
      const onlyExpectedTool = capture.bashCalls.length === 1 && capture.otherToolNames.length === 0;
      return bashTurn && bashTurn.turnId && exactBash && onlyExpectedTool ? bashTurn : undefined;
    };

    await waitFor("bash_start", TOOL_START_TIMEOUT_MS, () => currentTurnToolStart());
    const toolStarted = currentTurnToolStart();
    if (!toolStarted) throw new SmokeFailure("bash_start_not_observed", "bash_start");
    observed.toolTurnId = toolStarted.turnId;
    observed.bashToolCallSeen = capture.bashCalls.length === 1 && capture.bashCalls[0].command?.trim() === "sleep 10";
    observed.noExtraToolCalls = capture.bashCalls.length === 1 && capture.otherToolNames.length === 0;

    lastStage = "delegate";
    const delegateResponse = await fetchJson(`${bridgeUrl}/delegate`, token, {
      method: "POST",
      body: JSON.stringify({ id: "smoke-steer", text: STEER_TEXT }),
      stage: "delegate",
    });
    delegationPosted = true;
    delegationResponseAccepted = delegateResponse.id === "smoke-steer" && delegateResponse.ok === true;
    await waitFor("steer_receipt", DELEGATION_TIMEOUT_MS, (state) => {
      const receipts = findReceipts(state, "smoke-steer");
      return receipts.some((receipt) => ["accepted", "observed", "complete", "denied"].includes(receipt.state));
    });

    const acceptedReceipt = findReceipt(snapshot, "smoke-steer");
    if (!acceptedReceipt || !["accepted", "observed", "complete"].includes(acceptedReceipt.state)) {
      throw new SmokeFailure("steer_not_accepted", "steer_receipt");
    }
    delegationReceiptAccepted = true;
    observed.receiptMode = acceptedReceipt.mode ?? null;
    observed.receiptTurnId = acceptedReceipt.turnId ?? null;
    observed.receiptMatchesToolTurn =
      acceptedReceipt.mode === "steer" && acceptedReceipt.turnId === observed.toolTurnId;
    if (!observed.receiptMatchesToolTurn) throw new SmokeFailure("steer_not_same_turn", "steer_receipt");

    await waitFor("final_result", RESULT_TIMEOUT_MS, (state) => {
      const events = state?.agentEvents ?? [];
      const hasToolComplete = events.some(
        (event) => event.kind === "tool" && event.status === "completed" && event.turnId === observed.toolTurnId,
      );
      const hasFinal = events.some((event) => event.kind === "final" && event.turnId === observed.toolTurnId);
      const hasText = events.some((event) => event.kind === "text" && event.turnId === observed.toolTurnId);
      const hasDelivery = events.some((event) => event.kind === "delivery");
      const receipts = findReceipts(state, "smoke-steer");
      const hasObservedReceipt = receipts.some((receipt) => receipt.state === "observed");
      const latestReceipt = receipts.at(-1);
      const latestReceiptFinished = ["observed", "complete"].includes(latestReceipt?.state);
      return hasToolComplete && hasFinal && hasText && hasDelivery && hasObservedReceipt && latestReceiptFinished && capture.result;
    });

    claudeSummary = parseSummary(capture);
    const events = snapshot?.agentEvents ?? [];
    const startEvent = firstEvent(snapshot, "tool", "started");
    const completeEvent = events.find(
      (event) => event.kind === "tool" && event.status === "completed" && event.turnId === observed.toolTurnId,
    );
    const errorEvent = events.find(
      (event) => event.kind === "tool" && event.status === "error" && event.turnId === observed.toolTurnId,
    );
    const textEvent = events.find((event) => event.kind === "text" && event.turnId === observed.toolTurnId);
    const finalEvent = events.find((event) => event.kind === "final" && event.turnId === observed.toolTurnId);
    const deliveryEvent = events.find((event) => event.kind === "delivery");
    const receipt = findReceipt(snapshot, "smoke-steer");
    const receipts = findReceipts(snapshot, "smoke-steer");
    const hasObservedReceipt = receipts.some((item) => item.state === "observed");
    sameTurn = Boolean(
      startEvent?.turnId && startEvent.turnId === completeEvent?.turnId &&
      startEvent.turnId === textEvent?.turnId && startEvent.turnId === finalEvent?.turnId &&
      startEvent.turnId === receipt?.turnId && receipt?.mode === "steer",
    );

    checks = {
      helperHealthy: healthSeen,
      authenticatedStateRead: stateSeen,
      oneInitialUserTurnSent: sentInitialUserMessage,
      exactlyOneBashSleep10: observed.bashToolCallSeen,
      noExtraToolCalls: observed.noExtraToolCalls,
      bridgeToolStarted: Boolean(startEvent),
      delegateEndpointAccepted: delegationResponseAccepted,
      steerReceiptAccepted: delegationReceiptAccepted,
      steerAccepted: hasObservedReceipt,
      steerMode: receipt?.mode === "steer",
      receiptSameTurn: observed.receiptMatchesToolTurn,
      bashCompleted: Boolean(completeEvent),
      bashDidNotError: !errorEvent,
      textFeedback: Boolean(textEvent),
      finalFeedback: Boolean(finalEvent),
      deliveryFeedback: Boolean(deliveryEvent),
      finalColorBlue: claudeSummary.finalContainsColorBlue,
      claudeResultSuccessful: claudeSummary.resultSuccess,
      sameTurn,
    };
    // Check result status and feedback after the helper has flushed the complete turn.
    if (!hasObservedReceipt) throw new SmokeFailure("steer_not_observed", "final_result");
    if (!claudeSummary.resultSuccess) throw new SmokeFailure("claude_result_not_success", "final_result");
    if (!claudeSummary.finalContainsColorBlue) throw new SmokeFailure("final_color_missing", "final_result");
    if (errorEvent) throw new SmokeFailure("bash_tool_failed", "final_result");
    if (!sameTurn) throw new SmokeFailure("turn_evidence_mismatch", "final_result");
    for (const [name, passed] of Object.entries(checks)) {
      if (!passed) throw new SmokeFailure(`check_failed_${name}`, "final_result");
    }
  } catch (error) {
    failure = safeFailure(error);
  } finally {
    if (child) await closeChild(child, closedPromise, bridgeUrl, token);
  }

  if (!failure && (exitInfo?.code !== 0 || exitInfo.signal)) {
    failure = {
      stage: "cleanup",
      code: "claude_process_exit_failed",
      exitCode: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
      stderrBytes: capture.stderrBytes,
      helperHealthy: healthSeen,
      authenticatedStateSeen: stateSeen,
      delegationPosted,
      delegationAccepted: delegationResponseAccepted,
    };
  }

  const events = summarizedAgentEvents(snapshot);
  claudeSummary ??= parseSummary(capture);
  const evidence = {
    schemaVersion: 1,
    outcome: failure ? "failed" : "passed",
    startedAt: startedAt.toISOString(),
    elapsedMs: Date.now() - startedClock,
    configuration: {
      requestedModel: "haiku",
      effort: "low",
      maxBudgetUsd: MAX_BUDGET_USD,
      allowedTools: ["Bash", "Read"],
      allowedBashPattern: "sleep *",
      sessionPersistence: false,
      inputTurns: sentInitialUserMessage ? 1 : 0,
    },
    bridge: {
      portAllocated: Number.isInteger(port),
      healthChecks,
      healthSeen,
      authenticatedStateSeen: stateSeen,
      statePolls,
    },
    agentEvents: events,
    checks,
    turnEvidence: {
      sameTurn,
      toolStartedTurnObserved: Boolean(observed.toolTurnId),
      receiptMode: observed.receiptMode ?? null,
      receiptStates: findReceipts(snapshot, "smoke-steer").map((receipt) => receipt.state),
      receiptInitiallyAccepted: delegationReceiptAccepted,
      receiptMatchesToolTurn: observed.receiptMatchesToolTurn ?? false,
      bashCommandExact: observed.bashToolCallSeen ?? false,
      noExtraToolCalls: observed.noExtraToolCalls ?? false,
    },
    claude: {
      model: claudeSummary.model,
      resultSubtype: claudeSummary.resultSubtype,
      resultSuccess: claudeSummary.resultSuccess,
      totalCostUsd: claudeSummary.totalCostUsd,
      maxBudgetUsd: MAX_BUDGET_USD,
      durationMs: claudeSummary.durationMs,
      usage: claudeSummary.usage,
      finalContainsColorBlue: claudeSummary.finalContainsColorBlue,
      outputEventCounts: capture.outputEvents,
      outputBytes: capture.outputBytes,
      stderrBytes: capture.stderrBytes,
      malformedJsonLines: capture.malformedLines,
    },
    process: {
      exitCode: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
    },
    ...(failure ? { failure } : {}),
  };

  await mkdir(SCRATCH, { recursive: true });
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });

  const summary = {
    ok: !failure,
    elapsedMs: evidence.elapsedMs,
    model: evidence.claude.model,
    costUsd: evidence.claude.totalCostUsd,
    maxBudgetUsd: MAX_BUDGET_USD,
    eventCounts: events,
    sameTurn,
    checks: Object.keys(checks).length,
    passedChecks: Object.values(checks).filter(Boolean).length,
    evidence: EVIDENCE_PATH,
    ...(failure ? { failure } : {}),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (failure) process.exitCode = 1;
}

run().catch((error) => {
  const summary = {
    ok: false,
    failure: {
      stage: "runner",
      code: error instanceof SmokeFailure ? error.code : "runner_error",
    },
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = 1;
});
