(() => {
  /** @typedef {{ id: string, selectedText: string, comment: string }} Comment */

  const contentEl = document.getElementById("content");
  const btnSubmit = document.getElementById("btn-submit");
  const btnCancel = document.getElementById("btn-cancel");
  const popup = document.getElementById("popup");
  const popupInput = document.getElementById("popup-input");
  const popupAdd = document.getElementById("popup-add");
  const popupCancel = document.getElementById("popup-cancel");
  const note = document.getElementById("note");
  const noteBody = document.getElementById("note-body");
  const noteDelete = document.getElementById("note-delete");
  const overallNoteEl = document.getElementById("overall-note");
  const toastEl = document.getElementById("toast");

  /** @type {Comment[]} */
  let comments = [];
  /** @type {string | null} */
  let sessionId = null;
  /** @type {Range | null} */
  let pendingRange = null;
  /** @type {string} */
  let pendingText = "";
  /** @type {string | null} */
  let activeNoteId = null;
  /** @type {HTMLElement | null} */
  let trapRoot = null;
  let idSeq = 0;
  let done = false;

  function focusableWithin(root) {
    if (!root) return [];
    return [...root.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => {
      if (el.hasAttribute("hidden")) return false;
      if (el.closest("[hidden]")) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function enableTrap(root) {
    trapRoot = root;
  }

  function disableTrap() {
    trapRoot = null;
  }

  function tryCloseTab() {
    // Best-effort; browsers may ignore if tab wasn't script-opened.
    try {
      window.close();
    } catch {
      // ignore
    }
  }

  function sessionIdFromPath() {
    const m = location.pathname.match(/^\/s\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.classList.toggle("error", isError);
    toastEl.classList.remove("hidden");
    // reflow so transition replays
    void toastEl.offsetWidth;
    toastEl.classList.add("is-open");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      toastEl.classList.remove("is-open");
      setTimeout(() => toastEl.classList.add("hidden"), 180);
    }, 2400);
  }

  function isSafeUrl(href) {
    if (!href) return false;
    try {
      const url = new URL(href, location.origin);
      return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:";
    } catch {
      return false;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getMarked() {
    const root = globalThis.marked;
    if (!root) throw new Error("marked failed to load");
    if (typeof root.parse === "function") return root;
    if (root.marked && typeof root.marked.parse === "function") return root.marked;
    if (typeof root === "function") return root;
    throw new Error("Unrecognized marked export shape");
  }

  function configureMarked() {
    const md = getMarked();
    const Renderer = md.Renderer;
    if (!Renderer) throw new Error("marked.Renderer missing");

    const renderer = new Renderer();
    renderer.html = function html(token) {
      const source = typeof token === "object" && token !== null ? token.text : token;
      const escaped = escapeHtml(source ?? "");
      return token && typeof token === "object" && token.block
        ? `<pre class="raw-html"><code>${escaped}</code></pre>`
        : escaped;
    };

    const originalLink = renderer.link.bind(renderer);
    renderer.link = function link(token) {
      if (typeof token === "object" && token !== null) {
        const href = isSafeUrl(token.href) ? token.href : "#";
        return originalLink({ ...token, href });
      }
      const href = arguments[0];
      const title = arguments[1];
      const text = arguments[2];
      return originalLink(isSafeUrl(href) ? href : "#", title, text);
    };

    if (typeof md.setOptions === "function") {
      md.setOptions({ gfm: true, breaks: false, renderer });
    } else if (typeof md.use === "function") {
      md.use({ renderer });
    }

    getMarked._api = md;
  }

  function getMermaid() {
    const api = globalThis.mermaid;
    if (!api || typeof api.initialize !== "function" || typeof api.render !== "function") {
      throw new Error("mermaid failed to load");
    }
    return api;
  }

  function configureMermaid() {
    getMermaid().initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      themeVariables: {
        background: "#141418",
        primaryColor: "#24242c",
        primaryTextColor: "#e4e4e7",
        primaryBorderColor: "#555561",
        lineColor: "#8b8b96",
        secondaryColor: "#1c1c22",
        tertiaryColor: "#101014",
        fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
      },
    });
  }

  async function renderMermaidDiagrams() {
    const api = getMermaid();
    const blocks = [...contentEl.querySelectorAll("pre > code.language-mermaid")];

    for (const [index, code] of blocks.entries()) {
      const pre = code.parentElement;
      if (!pre) continue;

      try {
        const id = `pi-comment-mermaid-${index}`;
        const { svg, bindFunctions } = await api.render(id, code.textContent || "");
        const figure = document.createElement("figure");
        figure.className = "mermaid-diagram";
        figure.setAttribute("aria-label", `Mermaid diagram ${index + 1}`);
        figure.innerHTML = svg;
        pre.replaceWith(figure);
        bindFunctions?.(figure);
      } catch (err) {
        pre.classList.add("mermaid-fallback");
        const message = document.createElement("div");
        message.className = "mermaid-error";
        message.textContent = `Could not render Mermaid diagram: ${err instanceof Error ? err.message : String(err)}`;
        pre.insertAdjacentElement("afterend", message);
      }
    }
  }

  function htmlPreviewDocument(source) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'">
<style>
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
  * { box-sizing: border-box; }
  html, body { margin: 0; min-height: 100%; background: #141418; color: #e4e4e7; }
  body { padding: 20px; }
</style>
</head>
<body>${source}</body>
</html>`;
  }

  // Lucide Play and Code2 icons (ISC): https://lucide.dev/icons/
  const HTML_PREVIEW_ICON = '<svg class="lucide lucide-play" viewBox="0 0 24 24" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
  const HTML_SOURCE_ICON = '<svg class="lucide lucide-code-2" viewBox="0 0 24 24" aria-hidden="true"><path d="m18 16 4-4-4-4"></path><path d="m6 8-4 4 4 4"></path><path d="m14.5 4-5 16"></path></svg>';

  function renderHtmlPreviews() {
    const blocks = [...contentEl.querySelectorAll("pre > code.language-html")];

    for (const [index, code] of blocks.entries()) {
      const pre = code.parentElement;
      if (!pre) continue;

      const shell = document.createElement("div");
      shell.className = "html-preview-shell";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "html-preview-toggle";
      button.setAttribute("aria-label", `Preview HTML block ${index + 1}`);
      button.title = "Preview HTML";
      button.innerHTML = HTML_PREVIEW_ICON;

      pre.replaceWith(shell);
      shell.append(pre, button);

      button.addEventListener("click", () => {
        const current = shell.querySelector("iframe.html-preview-frame");
        if (current) {
          current.remove();
          pre.hidden = false;
          button.innerHTML = HTML_PREVIEW_ICON;
          button.title = "Preview HTML";
          button.setAttribute("aria-label", `Preview HTML block ${index + 1}`);
          return;
        }

        const frame = document.createElement("iframe");
        frame.className = "html-preview-frame";
        frame.title = `HTML preview ${index + 1}`;
        frame.setAttribute("sandbox", "");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.srcdoc = htmlPreviewDocument(code.textContent || "");
        pre.hidden = true;
        shell.prepend(frame);
        button.innerHTML = HTML_SOURCE_ICON;
        button.title = "Show HTML source";
        button.setAttribute("aria-label", `Show source for HTML block ${index + 1}`);
      });
    }
  }

  async function renderMarkdown(source) {
    const md = getMarked._api || getMarked();
    const html = typeof md.parse === "function" ? md.parse(source ?? "") : md(source ?? "");
    contentEl.innerHTML = html;
    await renderMermaidDiagrams();
    renderHtmlPreviews();
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function overallNote() {
    return (overallNoteEl.value || "").trim();
  }

  function canSubmit() {
    return comments.length > 0 || overallNote().length > 0;
  }

  function updateChrome() {
    const n = comments.length;
    const hasNote = overallNote().length > 0;
    btnSubmit.disabled = !canSubmit() || done;
    if (!canSubmit()) {
      btnSubmit.textContent = "Submit";
    } else if (n === 0) {
      btnSubmit.textContent = "Submit note";
    } else if (!hasNote) {
      btnSubmit.textContent = n === 1 ? "Submit 1 comment" : `Submit ${n} comments`;
    } else {
      btnSubmit.textContent = n === 1 ? "Submit 1 comment + note" : `Submit ${n} comments + note`;
    }
  }

  function renumber() {
    comments.forEach((c, i) => {
      const marks = contentEl.querySelectorAll(`mark.comment-mark[data-id="${cssEscape(c.id)}"]`);
      const num = String(i + 1);
      marks.forEach((mark) => {
        mark.setAttribute("data-num", num);
        mark.setAttribute("aria-label", `Comment ${num}`);
      });
    });
  }

  function setActive(id) {
    contentEl.querySelectorAll("mark.comment-mark").forEach((el) => {
      el.dataset.active = el.dataset.id === id ? "true" : "false";
    });
  }

  function unwrapElement(el) {
    if (!el || !el.parentNode) return;
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize?.();
  }

  const LIVE_HIGHLIGHT_NAME = "pi-comment-live-selection";

  function clearLiveSelection() {
    globalThis.CSS?.highlights?.delete(LIVE_HIGHLIGHT_NAME);
    pendingRange = null;
  }

  function applyLiveSelection(range) {
    clearLiveSelection();
    pendingRange = range.cloneRange();
    if (globalThis.Highlight && globalThis.CSS?.highlights) {
      globalThis.CSS.highlights.set(
        LIVE_HIGHLIGHT_NAME,
        new globalThis.Highlight(pendingRange),
      );
    }
  }

  const pendingFloatingCloses = new WeakMap();

  function openFloating(el) {
    // Reopening owns the element now; an older close must not hide it later.
    pendingFloatingCloses.get(el)?.();
    el.classList.remove("hidden");
    // reflow for enter transition
    void el.offsetWidth;
    el.classList.add("is-open");
  }

  function closeFloating(el, after) {
    pendingFloatingCloses.get(el)?.();
    el.classList.remove("is-open");

    let finished = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener("transitionend", onTransitionEnd);
      pendingFloatingCloses.delete(el);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      cleanup();
      el.classList.add("hidden");
      after?.();
    };
    const cancel = () => {
      if (finished) return;
      finished = true;
      cleanup();
    };
    const onTransitionEnd = (e) => {
      if (e.target === el && e.propertyName === "opacity") finish();
    };

    pendingFloatingCloses.set(el, cancel);
    el.addEventListener("transitionend", onTransitionEnd);
    // Match CSS 160ms; fallback if transitionend is not emitted.
    timer = setTimeout(finish, 180);
  }

  function hidePopup() {
    if (trapRoot === popup) disableTrap();
    if (popup.classList.contains("hidden") && !popup.classList.contains("is-open")) {
      pendingText = "";
      popupInput.value = "";
      clearLiveSelection();
      return;
    }
    closeFloating(popup, () => {
      pendingText = "";
      popupInput.value = "";
      clearLiveSelection();
    });
    clearLiveSelection();
    pendingText = "";
    popupInput.value = "";
  }

  function placeFloating(el, clientX, clientY) {
    const pad = 12;
    el.style.left = "0px";
    el.style.top = "0px";
    openFloating(el);
    const rect = el.getBoundingClientRect();
    let left = clientX + 10;
    let top = clientY + 10;
    if (left + rect.width > window.innerWidth - pad) left = window.innerWidth - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = clientY - rect.height - 10;
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function showPopup(clientX, clientY, text, range) {
    hideNote();
    pendingText = text;

    applyLiveSelection(range);

    window.getSelection()?.removeAllRanges();
    popupInput.value = "";
    placeFloating(popup, clientX, clientY);
    enableTrap(popup);
    popupInput.focus();
  }

  function hideNote() {
    if (trapRoot === note) disableTrap();
    if (note.classList.contains("hidden") && !note.classList.contains("is-open")) {
      activeNoteId = null;
      setActive("");
      return;
    }
    closeFloating(note, () => {
      activeNoteId = null;
      setActive("");
    });
    activeNoteId = null;
    setActive("");
  }

  function showNote(id, anchorEl) {
    const index = comments.findIndex((c) => c.id === id);
    if (index < 0) return;
    const c = comments[index];
    activeNoteId = id;
    setActive(id);
    noteBody.textContent = c.comment;

    const rect = anchorEl.getBoundingClientRect();
    placeFloating(note, rect.left, rect.bottom + 6);
    enableTrap(note);
    noteDelete.focus();
  }

  function bindMark(mark, id) {
    mark.tabIndex = 0;
    mark.setAttribute("role", "button");
    mark.setAttribute("aria-label", `Comment ${mark.dataset.num || ""}`.trim());

    const activate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (done) return;
      if (activeNoteId === id && note.classList.contains("is-open")) {
        hideNote();
        mark.focus();
        return;
      }
      showNote(id, mark);
    };

    mark.addEventListener("click", activate);
    mark.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") activate(e);
    });
  }

  function promoteLiveToMarks(id, num) {
    if (!pendingRange) return [];
    const range = pendingRange.cloneRange();
    clearLiveSelection();

    const segments = [];
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim() || node.parentElement?.closest("mark.comment-mark")) continue;
      if (!range.intersectsNode(node)) continue;

      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.textContent.length;
      if (start < end) segments.push({ node, start, end });
    }

    const marks = [];
    for (const segment of segments.reverse()) {
      const { node, start, end } = segment;
      if (end < node.textContent.length) node.splitText(end);
      const selected = start > 0 ? node.splitText(start) : node;
      const mark = document.createElement("mark");
      mark.className = "comment-mark";
      mark.dataset.id = id;
      mark.dataset.num = String(num);
      selected.parentNode?.insertBefore(mark, selected);
      mark.appendChild(selected);
      bindMark(mark, id);
      marks.push(mark);
    }

    const orderedMarks = marks.reverse();
    if (orderedMarks[0]) orderedMarks[0].dataset.primary = "true";
    return orderedMarks;
  }

  function removeComment(id) {
    comments = comments.filter((c) => c.id !== id);
    const marks = [...contentEl.querySelectorAll(`mark.comment-mark[data-id="${cssEscape(id)}"]`)];
    marks.forEach(unwrapElement);
    if (activeNoteId === id) hideNote();
    renumber();
    updateChrome();
  }

  function addComment() {
    const text = pendingText.trim();
    const comment = popupInput.value.trim();
    if (!text) {
      toast("Select some text first", true);
      return;
    }
    if (!comment) {
      toast("Write a comment", true);
      popupInput.focus();
      return;
    }

    const id = `c${++idSeq}`;
    comments.push({ id, selectedText: text, comment });

    try {
      promoteLiveToMarks(id, comments.length);
    } catch {
      clearLiveSelection();
    }

    if (trapRoot === popup) disableTrap();
    closeFloating(popup, () => {
      pendingText = "";
      popupInput.value = "";
    });
    pendingText = "";
    popupInput.value = "";
    renumber();
    updateChrome();
    setActive(id);
    // Return focus to the new mark for continued keyboard flow
    const mark = contentEl.querySelector(`mark.comment-mark[data-id="${cssEscape(id)}"]`);
    mark?.focus();
  }

  async function post(path, body) {
    const res = await fetch(`/s/${encodeURIComponent(sessionId)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }

  async function submit() {
    if (done) return;
    if (!canSubmit()) {
      toast("Add a selection comment or overall note", true);
      return;
    }
    try {
      btnSubmit.disabled = true;
      await post("/submit", {
        comments,
        overallNote: overallNote(),
      });
      done = true;
      hidePopup();
      hideNote();
      overallNoteEl.disabled = true;
      btnSubmit.disabled = true;
      btnCancel.disabled = true;
      tryCloseTab();
    } catch (err) {
      btnSubmit.disabled = false;
      toast(err instanceof Error ? err.message : String(err), true);
    }
  }

  async function cancel() {
    if (done) return;
    try {
      await post("/cancel", {});
      done = true;
      hidePopup();
      hideNote();
      overallNoteEl.disabled = true;
      btnSubmit.disabled = true;
      btnCancel.disabled = true;
      tryCloseTab();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), true);
    }
  }

  function onMouseUp(event) {
    if (done) return;
    if (popup.contains(event.target) || note.contains(event.target)) return;
    if (event.target.closest?.("mark.comment-mark")) return;
    if (event.target.closest?.(".composer-shell")) return;

    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      if (!contentEl.contains(range.commonAncestorContainer)) return;

      const text = sel.toString().trim();
      if (!text) return;

      const startEl =
        range.startContainer.nodeType === Node.ELEMENT_NODE
          ? range.startContainer
          : range.startContainer.parentElement;
      if (startEl?.closest?.("mark.comment-mark")) return;

      showPopup(event.clientX, event.clientY, text, range.cloneRange());
    }, 0);
  }

  function isModEnter(e) {
    return e.key === "Enter" && (e.metaKey || e.ctrlKey);
  }

  async function boot() {
    sessionId = sessionIdFromPath();
    if (!sessionId) {
      contentEl.textContent = "Missing session id in URL.";
      return;
    }

    configureMarked();
    configureMermaid();

    const res = await fetch(`/s/${encodeURIComponent(sessionId)}/data`);
    if (!res.ok) {
      contentEl.textContent = "Failed to load review data.";
      return;
    }
    const data = await res.json();
    await renderMarkdown(data.markdown || "");
    updateChrome();

    contentEl.addEventListener("mouseup", onMouseUp);
    popupAdd.addEventListener("click", addComment);
    popupCancel.addEventListener("click", hidePopup);
    btnSubmit.addEventListener("click", () => void submit());
    btnCancel.addEventListener("click", () => void cancel());
    noteDelete.addEventListener("click", () => {
      if (activeNoteId) removeComment(activeNoteId);
    });
    overallNoteEl.addEventListener("input", updateChrome);

    // Popup: Enter adds, Shift+Enter newline, Esc cancels
    popupInput.addEventListener("keydown", (e) => {
      if (isModEnter(e)) {
        e.preventDefault();
        void submit();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        addComment();
      } else if (e.key === "Escape") {
        e.preventDefault();
        hidePopup();
      }
    });

    // Overall note: Cmd/Ctrl+Enter submits all
    overallNoteEl.addEventListener("keydown", (e) => {
      if (isModEnter(e)) {
        e.preventDefault();
        void submit();
      }
    });

    document.addEventListener("keydown", (e) => {
      // Tab trap inside open popup / note
      if (e.key === "Tab" && trapRoot) {
        const items = focusableWithin(trapRoot);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !trapRoot.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !trapRoot.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }

      if (isModEnter(e) && !popup.classList.contains("is-open")) {
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        e.preventDefault();
        void submit();
        return;
      }
      if (e.key === "Escape") {
        if (popup.classList.contains("is-open")) {
          hidePopup();
        } else if (note.classList.contains("is-open")) {
          hideNote();
        }
      }
    });

    // Click outside closes popup / note
    document.addEventListener("mousedown", (e) => {
      const t = e.target;
      if (popup.classList.contains("is-open") && !popup.contains(t)) {
        hidePopup();
      }
      if (
        note.classList.contains("is-open") &&
        !note.contains(t) &&
        !t.closest?.("mark.comment-mark")
      ) {
        hideNote();
      }
    });
  }

  boot().catch((err) => {
    contentEl.textContent = err instanceof Error ? err.message : String(err);
  });
})();
