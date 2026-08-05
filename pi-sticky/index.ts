/**
 * pi-sticky: keeps the chat input and footer pinned to the bottom while scrolling.
 *
 * Works alongside pi-vim, pi-status, and any other extensions — it does not
 * replace the editor or footer, it just pins whatever is registered.
 *
 * IMPORTANT: pi-sticky must be listed BEFORE pi-vim (and any other editor/footer
 * extension) in your extensions config so its session_start handler runs first
 * and has a chance to wrap ctx.ui.setEditorComponent before pi-vim calls it.
 *
 * How it works:
 *   1. Intercepts ctx.ui.setEditorComponent to capture the tui ref and the
 *      editor renderable the moment pi-vim (or any other editor extension)
 *      registers its editor.
 *   2. Intercepts ctx.ui.setFooter to trigger a reinstall when the footer
 *      changes (e.g. pi-status registering after pi-vim).
 *   3. Registers a zero-height probe widget to capture the tui ref as a
 *      fallback in configurations without a custom editor extension.
 *   4. Defers compositor installation via setTimeout(0) so it runs after ALL
 *      extensions' session_start handlers have completed, ensuring the final
 *      footer (e.g. from pi-status) is already in tui.children.
 *   5. Uses TerminalSplitCompositor (vendored from pi-powerline-footer) to
 *      intercept terminal.write and maintain a fixed scroll region, keeping
 *      the editor and footer pinned at the bottom.
 *
 * The layout in tui.children is assumed to be (this matches pi-coding-agent's
 * interactive mode):
 *
 *   [editorIdx - 2]  statusContainer      (loading animation)
 *   [editorIdx - 1]  widgetContainerAbove (setWidget "aboveEditor")
 *   [editorIdx]      editorContainer      (the chat input)
 *   [editorIdx + 1]  widgetContainerBelow (setWidget "belowEditor")
 *   [editorIdx + 2]  footer               (setFooter, e.g. pi-status)
 */

import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.ts";
import { TerminalSplitCompositor } from "./fixed-editor/terminal-split.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

function hasRender(el: unknown): el is { render(width: number): string[] } {
  return el != null && typeof (el as any).render === "function";
}

/**
 * Search tui.children for the container that holds the given renderable as a
 * direct child.  Returns -1 if not found.
 */
function findContainerIndex(tui: any, renderable: unknown): number {
  const children: unknown[] = Array.isArray(tui?.children) ? tui.children : [];
  return children.findIndex(
    (c: any) => Array.isArray(c?.children) && c.children.includes(renderable),
  );
}

/**
 * Fallback: find the editor container by duck-typing when no setEditorComponent
 * interception captured an explicit reference.  Looks for a Container whose
 * child exposes handleInput + render (signature of an editor component).
 */
function findEditorContainerIndex(tui: any): number {
  const children: unknown[] = Array.isArray(tui?.children) ? tui.children : [];
  return children.findIndex(
    (c: any) =>
      Array.isArray(c?.children) &&
      c.children.some(
        (child: any) =>
          typeof child?.handleInput === "function" &&
          typeof child?.render === "function",
      ),
  );
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function piSticky(pi: ExtensionAPI) {
  // Compositor lives outside session_start so session_shutdown can reach it.
  let compositor: TerminalSplitCompositor | null = null;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Clean up any compositor from a previous session.
    compositor?.dispose({ resetExtendedKeyboardModes: false });
    compositor = null;

    let capturedTui: any = null;
    let capturedEditor: any = null;
    let installTimer: ReturnType<typeof setTimeout> | null = null;

    // ── install ────────────────────────────────────────────────────────────

    function install(): void {
      if (!capturedTui) return;

      // Tear down any previously installed compositor before rebuilding.
      compositor?.dispose({ resetExtendedKeyboardModes: false });
      compositor = null;

      const tui = capturedTui;
      const children: any[] = Array.isArray(tui?.children) ? tui.children : [];

      // Locate the editor container.
      const editorIdx = capturedEditor !== null
        ? findContainerIndex(tui, capturedEditor)
        : findEditorContainerIndex(tui);

      if (editorIdx === -1) {
        // Editor not yet placed in tui.children — this can happen if the
        // compositor was requested before setCustomEditorComponent finished.
        // Retry once more on the next tick.
        installTimer = setTimeout(install, 0);
        return;
      }

      const editorContainer = children[editorIdx];

      // Collect the surrounding containers that should also be pinned.
      // Positions are relative to the editor container and match the layout
      // documented at the top of this file.
      const statusEl = editorIdx >= 2 ? children[editorIdx - 2] : null;
      const widgetAboveEl = editorIdx >= 1 ? children[editorIdx - 1] : null;
      const widgetBelowEl = children[editorIdx + 1] ?? null;
      const footerEl = children[editorIdx + 2] ?? null;

      // Build the compositor.  renderCluster is called on every render pass to
      // produce the lines that stay pinned at the bottom of the terminal.
      const newCompositor = new TerminalSplitCompositor({
        tui,
        terminal: tui.terminal,
        mouseScroll: true,
        onCopySelection: (text) => copyToClipboard(text),
        getShowHardwareCursor: () =>
          typeof tui.getShowHardwareCursor === "function" &&
          tui.getShowHardwareCursor(),
        renderCluster: (width, terminalRows) => {
          return renderFixedEditorCluster({
            width,
            terminalRows,
            // Loading animation / status indicator sits above everything else.
            statusLines: hasRender(statusEl)
              ? newCompositor.renderHidden(statusEl, width)
              : [],
            // Widgets registered with placement:"aboveEditor" live here.
            topLines: hasRender(widgetAboveEl)
              ? newCompositor.renderHidden(widgetAboveEl, width)
              : [],
            // The chat input itself.
            editorLines: newCompositor.renderHidden(editorContainer, width),
            // Widgets registered with placement:"belowEditor" live here.
            secondaryLines: hasRender(widgetBelowEl)
              ? newCompositor.renderHidden(widgetBelowEl, width)
              : [],
            // The footer (e.g. pi-status) sits at the very bottom.
            transcriptLines: hasRender(footerEl)
              ? newCompositor.renderHidden(footerEl, width)
              : [],
          });
        },
      });

      // Hide each element from the scrollable TUI render so the compositor
      // can re-render them exclusively in the pinned cluster.
      if (hasRender(statusEl)) newCompositor.hideRenderable(statusEl);
      if (hasRender(widgetAboveEl)) newCompositor.hideRenderable(widgetAboveEl);
      newCompositor.hideRenderable(editorContainer);
      if (hasRender(widgetBelowEl)) newCompositor.hideRenderable(widgetBelowEl);
      if (hasRender(footerEl)) newCompositor.hideRenderable(footerEl);

      newCompositor.install();
      compositor = newCompositor;
      tui.requestRender?.();
    }

    // Debounce: coalesce multiple rapid install requests (e.g. setEditorComponent
    // + setFooter firing in the same session_start tick) into a single install.
    function scheduleInstall(): void {
      if (installTimer !== null) return;
      installTimer = setTimeout(() => {
        installTimer = null;
        install();
      }, 0);
    }

    // ── intercept setEditorComponent ───────────────────────────────────────
    //
    // The extension runner calls all session_start handlers with the SAME ctx
    // object (runner.ts emit() creates ctx once and passes it to every handler).
    // By replacing ctx.ui.setEditorComponent here — before pi-vim's
    // session_start runs — pi-vim will call our wrapper instead of the original.
    //
    // The factory is called SYNCHRONOUSLY inside setCustomEditorComponent, so
    // capturedEditor and capturedTui are set by the time pi-vim's handler
    // returns.  scheduleInstall() defers actual installation via setTimeout so
    // it happens after ALL session_start handlers complete (including pi-status
    // registering its footer).

    const uiAny = ctx.ui as any;

    const origSetEditor = uiAny.setEditorComponent;
    if (typeof origSetEditor === "function") {
      uiAny.setEditorComponent = (factory: any) => {
        const wrapped =
          typeof factory === "function"
            ? (tui: any, theme: any, keybindings: any) => {
                capturedTui = tui;
                // Tear down any existing compositor — the editor is changing.
                compositor?.dispose({ resetExtendedKeyboardModes: false });
                compositor = null;
                const renderable = factory(tui, theme, keybindings);
                capturedEditor = renderable;
                scheduleInstall();
                return renderable;
              }
            : factory; // undefined → clearing the editor; pass through
        return origSetEditor.call(ctx.ui, wrapped);
      };
    }

    // ── intercept setFooter ────────────────────────────────────────────────
    //
    // When pi-status (or any other extension) registers a footer after
    // pi-vim has already registered an editor, we need to reinstall the
    // compositor so it picks up the new footer element.
    //
    // We also use the footer factory's tui argument as a secondary path to
    // capture the tui ref (useful when there is no custom editor extension).

    const origSetFooter = uiAny.setFooter;
    if (typeof origSetFooter === "function") {
      uiAny.setFooter = (factory: any) => {
        const wrapped =
          typeof factory === "function"
            ? (tui: any, theme: any, footerData: any) => {
                capturedTui = capturedTui ?? tui;
                const renderable = factory(tui, theme, footerData);
                // Reinstall so the new footer gets included in the cluster.
                compositor?.dispose({ resetExtendedKeyboardModes: false });
                compositor = null;
                scheduleInstall();
                return renderable;
              }
            : factory;
        return origSetFooter.call(ctx.ui, wrapped);
      };
    }

    // ── probe widget ───────────────────────────────────────────────────────
    //
    // Registers a zero-height widget purely to capture the tui ref
    // synchronously during this handler, before any setTimeout fires.
    // This covers configurations without a custom editor or footer extension
    // (the widget factory is called synchronously by setExtensionWidget).
    // The widget renders nothing so it has no visual impact.

    ctx.ui.setWidget(
      "pi-sticky:probe",
      (tui: any) => {
        capturedTui = tui;
        return {
          render: (_width: number): string[] => [],
          invalidate(): void {},
        };
      },
      { placement: "aboveEditor" },
    );

    // Schedule the first install attempt.  By the time the setTimeout fires,
    // all other extensions' session_start handlers will have completed.
    scheduleInstall();
  });

  pi.on("session_shutdown", async () => {
    compositor?.dispose({ resetExtendedKeyboardModes: true });
    compositor = null;
  });
}
