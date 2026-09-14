import { EventEmitter } from "node:events";
import WebSocket from "ws";

export class VoiceError extends Error {}
export function safeError(error) {
  if (error instanceof VoiceError) return error.message;
  return "Voice connection failed. Check connectivity and your API credentials.";
}
export class LiveConnection extends EventEmitter {
  constructor({ key, WebSocketClass = WebSocket, timeout = 15000 } = {}) {
    super();
    this.key = key;
    this.WebSocketClass = WebSocketClass;
    this.timeout = timeout;
    this.started = false;
    this.finalUsage = undefined;
    this.latestSeconds = 0;
    this.finalized = false;
    this.on("error", () => {}); // Errors may arrive while startup/close is awaited.
  }
  async start(session) {
    if (!this.key)
      throw new VoiceError(
        "Voice Agent needs an OpenAI API key. Add it with Pi's /login.",
      );
    this.socket = new this.WebSocketClass(
      "wss://api.openai.com/v1/live/sessions",
      {
        headers: { Authorization: "Bearer " + this.key },
        handshakeTimeout: this.timeout,
        maxPayload: 2 * 1024 * 1024,
      },
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        finish(new VoiceError("GPT-Live did not start in time."));
        this.socket.terminate();
      }, this.timeout);
      this.socket.on("open", () =>
        this.send({ type: "session.start", session }),
      );
      this.socket.on("message", (raw) => {
        let event;
        try {
          event = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (event.type === "session.started") {
          if (event.session?.model !== "gpt-live-1") {
            finish(
              new VoiceError(
                "Server did not confirm the requested gpt-live-1 model.",
              ),
            );
            this.socket.close();
            return;
          }
          this.started = true;
          this.sessionId = event.session.id;
          finish(undefined, event.session);
        } else if (event.type === "session.usage.updated") {
          this.latestSeconds = event.usage?.seconds ?? this.latestSeconds;
        } else if (event.type === "session.closed") {
          this.finalized = true;
          this.finalUsage = event.usage;
          this.latestSeconds = event.usage?.seconds ?? this.latestSeconds;
        } else if (event.type === "error") {
          const code = String(event.error?.code ?? "unknown")
            .replace(/[^a-zA-Z0-9_-]/g, "")
            .slice(0, 80);
          const error = new VoiceError(
            "GPT-Live rejected a request (" + code + ").",
          );
          finish(error);
          this.emit("error", error);
        }
        this.emit("event", event);
      });
      this.socket.on("unexpected-response", (_request, response) => {
        response.resume();
        const error = new VoiceError(
          "GPT-Live access failed (HTTP " +
            response.statusCode +
            "). Check the API key, credits, and model access.",
        );
        finish(error);
        this.emit("error", error);
        this.socket.terminate();
      });
      this.socket.on("error", () => {
        const error = new VoiceError(
          "GPT-Live connection failed. Check connectivity and API access.",
        );
        finish(error);
        this.emit("error", error);
      });
      this.socket.on("close", () => {
        finish(new VoiceError("GPT-Live disconnected before startup."));
        this.emit("disconnect", {
          finalized: this.finalized,
          seconds: this.latestSeconds,
        });
      });
    });
  }
  send(event) {
    if (this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }
  append(kind, content, delegationId = null) {
    return this.send({
      type: "session." + kind + ".append",
      delegation_id: delegationId,
      content,
    });
  }
  close() {
    this.closePromise ??= this.closeSession();
    return this.closePromise;
  }
  async closeSession() {
    if (!this.socket || this.socket.readyState > 1)
      return { finalized: this.finalized, seconds: this.latestSeconds };
    if (!this.started) {
      this.socket.terminate();
      return { finalized: false, seconds: 0 };
    }
    if (this.finalized) {
      this.socket.close();
      return { finalized: true, seconds: this.latestSeconds };
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off("event", listener);
        this.off("disconnect", finish);
        this.socket.close();
        // Release even if the server never completes the WebSocket close handshake.
        const cleanup = setTimeout(() => this.socket.terminate(), 1000);
        cleanup.unref();
        resolve({ finalized: this.finalized, seconds: this.latestSeconds });
      };
      const listener = (e) => {
        if (e.type === "session.closed") finish();
      };
      const timer = setTimeout(() => {
        this.socket.terminate();
        finish();
      }, this.timeout);
      this.on("event", listener);
      this.once("disconnect", finish);
      this.send({ type: "session.close" });
    });
  }
}
