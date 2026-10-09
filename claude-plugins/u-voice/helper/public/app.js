(() => {
  const tokenParams = new URLSearchParams(location.hash.slice(1));
  let token = tokenParams.get("token") || "";
  try {
    if (token) sessionStorage.setItem("uvoice-bridge-token", token);
    else token = sessionStorage.getItem("uvoice-bridge-token") || "";
  } catch {}
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);

  const connectButton = document.querySelector("#connect");
  const muteButton = document.querySelector("#mute");
  const disconnectButton = document.querySelector("#disconnect");
  const label = document.querySelector("#state-label");
  const dot = document.querySelector("#state-dot");
  const detail = document.querySelector("#detail");
  const captions = document.querySelector("#captions");
  const audio = document.querySelector("#remote-audio");

  let peer;
  let channel;
  let sessionId;
  let audioTransceiver;
  let microphone;
  let streamAbort;
  let connecting = false;
  let muted = false;
  let lastThinkingRevision = 0;
  let closing = false;
  let callId;
  let callAbort;
  let callGeneration = 0;
  let eventPostQueue = Promise.resolve();
  let lastConnectControlId;
  let lastMuteRevision = 0;
  let activeConnectControlId;
  let failedGeneration;
  const failureMessages = {
    microphone_denied: "Microphone permission denied. Allow microphone access for the voice host in your system settings.",
    microphone_unavailable: "Microphone unavailable. Check that an input device is connected and not in use by another application.",
    connection_failed: "Voice connection failed. Toggle /v off, then on to reconnect.",
    playback_failed: "Voice playback failed. Check your audio output device, then toggle /v off and on.",
  };

  function setState(value, message) {
    label.textContent = value;
    detail.textContent = message || "";
    dot.className = "dot";
    if (value === "Connecting") dot.classList.add("connecting");
    if (value === "Listening") dot.classList.add("listening");
    if (value === "Muted") dot.classList.add("muted");
    if (value === "Error") dot.classList.add("error");
  }

  function updateButtons() {
    connectButton.disabled = connecting || !!sessionId;
    muteButton.disabled = !sessionId || !microphone;
    disconnectButton.disabled = !sessionId && !connecting;
    muteButton.textContent = muted ? "Unmute" : "Mute";
  }

  function localUrl(path) {
    return new URL(path, location.origin).toString();
  }

  async function request(path, body, options = {}) {
    const response = await fetch(localUrl(path), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
      keepalive: options.keepalive,
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Local voice request failed.");
    return result;
  }

  function waitForIceGathering(pc, signal) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        pc.removeEventListener("icegatheringstatechange", changed);
        signal?.removeEventListener("abort", aborted);
      };
      const changed = () => {
        if (pc.iceGatheringState !== "complete") return;
        cleanup();
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(new Error("Voice connection cancelled."));
      };
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error("ICE setup timed out."));
      }, 12000);
      pc.addEventListener("icegatheringstatechange", changed);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function waitForChannelOpen(dc, signal) {
    if (dc.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        dc.removeEventListener("open", open);
        dc.removeEventListener("error", error);
        dc.removeEventListener("close", close);
        signal?.removeEventListener("abort", aborted);
      };
      const open = () => {
        cleanup();
        resolve();
      };
      const error = () => {
        cleanup();
        reject(new Error("Voice channel failed to open."));
      };
      const close = () => {
        cleanup();
        reject(new Error("Voice channel closed before opening."));
      };
      const aborted = () => {
        cleanup();
        reject(new Error("Voice connection cancelled."));
      };
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Voice channel did not open."));
      }, 20000);
      dc.addEventListener("open", open, { once: true });
      dc.addEventListener("error", error, { once: true });
      dc.addEventListener("close", close, { once: true });
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  function addCaption(role, text, preserveWhitespace = false) {
    if (typeof text !== "string" || (!preserveWhitespace && !text.trim())) return;
    let remaining = text;
    while (remaining.length) {
      let row = role === "You" || role === "Voice" ? captions.lastElementChild : undefined;
      let body = row?.querySelector("span");
      if (!row || row.dataset.role !== role || !body || body.textContent.length >= 4000) {
        row = document.createElement("div");
        row.className = "caption";
        row.dataset.role = role;
        const who = document.createElement("strong");
        who.textContent = role + ": ";
        body = document.createElement("span");
        row.append(who, body);
        captions.append(row);
        while (captions.childElementCount > 10) captions.firstElementChild.remove();
      }
      const room = 4000 - body.textContent.length;
      body.textContent += remaining.slice(0, room);
      remaining = remaining.slice(room);
    }
    captions.scrollTop = captions.scrollHeight;
  }

  function compactLiveEvent(event) {
    if (!event || typeof event.type !== "string") return undefined;
    if (event.type === "input_transcript.added" || event.type === "output_transcript.added") {
      const text = event.item?.text;
      if (typeof text !== "string") return undefined;
      const role = event.type === "input_transcript.added" ? "You" : "Voice";
      addCaption(role, text, true);
      return { type: event.type, event_id: typeof event.event_id === 'string' ? event.event_id : undefined, item: { text: text.slice(0, 20000) } };
    }
    if (event.type === 'turn.done') return { type: 'turn.done' };
    if (event.type === "delegation.created") {
      const source = event.item;
      if (!source || typeof source !== "object") return undefined;
      const item = { id: source.id, target: source.target };
      for (const key of ["task", "text", "content_text"]) {
        if (typeof source[key] === "string") item[key] = source[key].slice(0, 20000);
      }
      if (Array.isArray(source.content)) {
        item.content = source.content
          .filter((part) => part && typeof part.text === "string")
          .slice(0, 40)
          .map((part) => ({ type: typeof part.type === "string" ? part.type.slice(0, 40) : "input_text", text: part.text.slice(0, 20000) }));
      }
      return { type: event.type, item };
    }
    if (event.type === "error") return { type: "error" };
    if (event.type === "session.closed") {
      setState("Disconnected", "The voice session ended.");
      void disconnect();
      return undefined;
    }
    if (event.type === "session.started") return { type: "session.started" };
    return undefined;
  }

  function postModelEvent(event) {
    if (!sessionId) return;
    const compact = compactLiveEvent(event);
    if (!compact) return;
    const currentSession = sessionId;
    eventPostQueue = eventPostQueue
      .then(() => request("/live/event", { sessionId: currentSession, event: compact }))
      .catch(() => {
        if (sessionId === currentSession && compact.type === "error") {
          setState("Error", "The voice service reported an error.");
        }
      });
    if (compact.type === "error") {
      eventPostQueue = eventPostQueue.then(() => {
        if (sessionId === currentSession) {
          void disconnect();
          setState("Error", "The voice service reported an error. Reconnect to continue.");
        }
      });
    }
  }

  function handleServerEvent(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "control") {
      if (typeof event.controlId !== "string" || !event.controlId || !Number.isInteger(event.revision) || event.revision < 1) return;
      if (event.action === "connect") {
        if (event.controlId === lastConnectControlId) return;
        lastConnectControlId = event.controlId;
        void connect(event.controlId);
      } else if (event.action === "set-thinking") {
        if (typeof event.thinking !== "boolean" || event.revision <= lastThinkingRevision) return;
        lastThinkingRevision = event.revision;
        // Thinking mode silences GPT-Live locally; the call and microphone stay live.
        audio.muted = event.thinking;
      } else if (event.action === "set-mute") {
        if (event.liveSessionId !== sessionId || !microphone || typeof event.muted !== "boolean" || event.revision <= lastMuteRevision) return;
        lastMuteRevision = event.revision;
        void setMute(event.muted, event.controlId, event.revision);
      }
      return;
    }
    if (event.type === "status") {
      if (event.liveSessionId && sessionId && event.liveSessionId !== sessionId) return;
      const value = {
        idle: "Disconnected",
        connecting: "Connecting",
        listening: "Listening",
        muted: "Muted",
        error: "Error",
        stopping: "Disconnected",
      }[event.phase] || "Disconnected";
      if (value === "Listening" && muted) return;
      setState(value, event.message || "");
      return;
    }
    if (event.type === "delegate") {
      addCaption("Claude Code", "Request sent to the terminal session.");
      return;
    }
    if (event.type === "delivery" && ["denied", "cancelled"].includes(event.state)) {
      addCaption("Claude Code", event.message || "Claude Code did not complete that request. Please repeat it to try again.");
      return;
    }
    if (event.type === "live.send") {
      if (event.liveSessionId !== sessionId || !channel || channel.readyState !== "open") return;
      try { channel.send(JSON.stringify(event.event)); } catch {}
      return;
    }
    if (event.type === "shutdown") void disconnect();
  }

  async function runStream(signal) {
    let failures = 0;
    try {
      while (!signal.aborted && token) {
        try {
          const response = await fetch(localUrl("/stream"), {
            headers: { Authorization: "Bearer " + token, Accept: "text/event-stream" },
            signal,
          });
          if (!response.ok || !response.body) throw new Error("Local event stream unavailable.");
          failures = 0;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const payload = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
              if (payload) {
                try { handleServerEvent(JSON.parse(payload)); } catch {}
              }
            }
          }
        } catch (error) {
          if (signal.aborted) return;
        }
        failures++;
        if (sessionId && failures >= 4) {
          setState("Error", "The local voice helper disconnected.");
          await disconnect();
          return;
        }
        if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 700));
      }
    } finally {
      if (streamAbort?.signal === signal) streamAbort = undefined;
    }
  }

  async function startStream() {
    if (streamAbort || !token) return;
    streamAbort = new AbortController();
    void runStream(streamAbort.signal);
  }

  async function reportFailure(code, generation = callGeneration) {
    if (generation !== callGeneration || failedGeneration === generation || closing || !callId) return;
    failedGeneration = generation;
    for (const track of microphone?.getAudioTracks() || []) track.enabled = false;
    setState("Error", failureMessages[code] || failureMessages.connection_failed);
    try {
      await request("/live/failure", {
        callId, sessionId, controlId: activeConnectControlId, code,
      }, { keepalive: true });
    } catch {}
    if (generation === callGeneration) await disconnect();
  }

  async function connect(controlId) {
    if (!token) {
      setState("Error", "Open the private voice link supplied by the terminal session.");
      return;
    }
    if (connecting || sessionId) return;
    const generation = ++callGeneration;
    const thisCallId = crypto.randomUUID();
    const abortController = new AbortController();
    callId = thisCallId;
    activeConnectControlId = controlId;
    callAbort = abortController;
    connecting = true;
    closing = false;
    muted = false;
    lastMuteRevision = 0;
    setState("Connecting", "Opening the voice channel. The microphone is still off.");
    updateButtons();

    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        throw new Error("This browser does not support WebRTC microphone access.");
      }

      const pc = new RTCPeerConnection({ iceServers: [] });
      peer = pc;
      const dc = pc.createDataChannel("codex-live", { ordered: true });
      channel = dc;
      audioTransceiver = pc.addTransceiver("audio", { direction: "sendrecv" });
      dc.onmessage = (message) => {
        if (generation !== callGeneration) return;
        if (typeof message.data !== "string") return;
        try { postModelEvent(JSON.parse(message.data)); } catch {}
      };
      dc.onclose = () => {
        if (generation !== callGeneration) return;
        if (sessionId && !closing) {
          void reportFailure("connection_failed", generation);
        }
      };
      dc.onerror = () => {
        if (generation !== callGeneration) return;
        if (sessionId && !closing) {
          void reportFailure("connection_failed", generation);
        }
      };
      pc.ontrack = (event) => {
        if (generation !== callGeneration) return;
        if (event.streams?.[0]) audio.srcObject = event.streams[0];
        else {
          const remote = audio.srcObject instanceof MediaStream ? audio.srcObject : new MediaStream();
          if (!remote.getTracks().some((track) => track.id === event.track.id)) remote.addTrack(event.track);
          audio.srcObject = remote;
        }
        void audio.play().catch(() => reportFailure("playback_failed", generation));
      };
      pc.onconnectionstatechange = () => {
        if (generation !== callGeneration) return;
        if (["failed", "closed"].includes(pc.connectionState) && !closing) {
          void reportFailure("connection_failed", generation);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc, abortController.signal);
      if (generation !== callGeneration || failedGeneration === generation) return;
      const answer = await request("/live/call", {
        callId: thisCallId,
        sdp: pc.localDescription.sdp,
        voice: "cove",
        ...(controlId ? { controlId } : {}),
      }, { signal: abortController.signal });
      if (generation !== callGeneration || failedGeneration === generation) return;
      sessionId = answer.sessionId;
      updateButtons();
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      if (generation !== callGeneration || failedGeneration === generation) return;
      await waitForChannelOpen(dc, abortController.signal);
      if (generation !== callGeneration || failedGeneration === generation) return;

      // The remote data channel is open before microphone permission or capture.
      await request("/live/event", { sessionId, event: { type: "bridge.datachannel.open" } });
      if (generation !== callGeneration || failedGeneration === generation) return;
      const acquiredMicrophone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (generation !== callGeneration || failedGeneration === generation) {
        for (const track of acquiredMicrophone.getTracks()) track.stop();
        return;
      }
      microphone = acquiredMicrophone;
      for (const track of microphone.getAudioTracks()) track.enabled = false;
      await audioTransceiver.sender.replaceTrack(microphone.getAudioTracks()[0]);
      if (generation !== callGeneration || failedGeneration === generation) return;
      await request("/live/event", { sessionId, event: { type: "bridge.mic.ready" } });
      if (generation !== callGeneration || failedGeneration === generation) return;
      for (const track of microphone.getAudioTracks()) track.enabled = !muted;
      setState(muted ? "Muted" : "Listening", muted ? "Microphone muted. Replies remain audible." : "Listening. Mute pauses your microphone; voice replies stay on.");
      connecting = false;
      if (callAbort === abortController) callAbort = undefined;
      updateButtons();
      await startStream();
    } catch (error) {
      if (generation !== callGeneration) return;
      const code = error?.name === "NotAllowedError"
        ? "microphone_denied"
        : ["NotFoundError", "NotReadableError", "OverconstrainedError"].includes(error?.name) || !navigator.mediaDevices?.getUserMedia
          ? "microphone_unavailable"
          : "connection_failed";
      connecting = false;
      updateButtons();
      await reportFailure(code, generation);
    }
  }

  async function toggleMute() {
    if (!microphone || !sessionId) return;
    try {
      await request("/control", { action: "toggle-mute", sessionId });
    } catch {
      setState("Error", "Could not change the microphone state.");
    }
  }

  async function setMute(value, controlId, revision) {
    if (!microphone || !sessionId) return;
    const generation = callGeneration;
    const currentSession = sessionId;
    muted = value;
    for (const track of microphone.getAudioTracks()) track.enabled = !muted;
    try {
      await request("/live/event", {
        sessionId: currentSession,
        event: { type: value ? "bridge.mic.muted" : "bridge.mic.unmuted", controlId },
      });
    } catch {
      if (generation === callGeneration && revision === lastMuteRevision) setState("Error", "Could not confirm the microphone state.");
      return;
    }
    if (generation !== callGeneration || revision !== lastMuteRevision) return;
    setState(muted ? "Muted" : "Listening", muted ? "Microphone muted. Replies remain audible." : "Listening.");
    updateButtons();
  }

  async function disconnect() {
    if (closing) return;
    closing = true;
    const oldSession = sessionId;
    const oldCallId = callId;
    ++callGeneration;
    callAbort?.abort("cancelled");
    callAbort = undefined;
    sessionId = undefined;
    callId = undefined;
    activeConnectControlId = undefined;
    connecting = false;
    muted = false;
    if (microphone) {
      for (const track of microphone.getTracks()) track.stop();
      microphone = undefined;
    }
    try { channel?.close(); } catch {}
    try { peer?.close(); } catch {}
    channel = undefined;
    peer = undefined;
    audioTransceiver = undefined;
    audio.srcObject = null;
    updateButtons();
    if (token && (oldSession || oldCallId)) {
      void request("/live/cancel", { sessionId: oldSession, callId: oldCallId }, { keepalive: true }).catch(() => {});
    }
    closing = false;
    if (label.textContent !== "Error") setState("Disconnected", "Connect when you are ready to speak.");
  }

  connectButton.addEventListener("click", () => void connect());
  muteButton.addEventListener("click", () => void toggleMute());
  disconnectButton.addEventListener("click", () => void disconnect());
  audio.addEventListener("error", () => {
    if (sessionId && !closing) void reportFailure("playback_failed");
  });
  window.addEventListener("beforeunload", () => {
    if ((!sessionId && !callId) || !token) return;
    void fetch(localUrl("/live/cancel"), {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, callId }),
      keepalive: true,
    });
  });

  if (!token) setState("Error", "This page needs the private voice link supplied by the terminal session.");
  else void startStream();
  updateButtons();
})();
