// Evaluated inside the T3 Code page (see KIT.md). Installs window.kit with three helpers.
(() => {
  const TITLES = ["Orbit solver", "Stipple shader", "Lensing pass", "Disk kinematics", "Photon ring", "Release notes", "Sidebar polish", "Changelog"];
  const FILLER =
    "The solver now steps the orbit in fixed increments and checks the energy drift after every pass. " +
    "Three cases still fail near periapsis, where the step is too coarse for the curvature. " +
    "Halving the step there fixes two of them and costs about four percent more time overall. " +
    "The last case needs a different integrator, which is a larger change than this branch should carry. ";
  const leaves = (root) => [...root.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent.trim());
  const sheet = () => document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];

  window.kit = {
    /** Swaps the page's theme stylesheet for `css`, applying the same fetch check the app applies. */
    apply(css) {
      const remote = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
      const fetches = /image-set\(|\bsrc\(/i;
      const target = sheet();
      target.replaceSync(css);
      const dropped = [];
      const walk = (parent) => {
        for (let i = parent.cssRules.length - 1; i >= 0; i--) {
          const rule = parent.cssRules[i];
          let hasStyle = false;
          if ("style" in rule && rule.style instanceof CSSStyleDeclaration) {
            hasStyle = true;
            for (let j = rule.style.length - 1; j >= 0; j--) {
              const property = rule.style.item(j);
              const value = rule.style.getPropertyValue(property);
              if (remote.test(value) || fetches.test(value)) {
                dropped.push(`${rule.selectorText || rule.constructor.name} :: ${property}`);
                rule.style.removeProperty(property);
              }
            }
          }
          if (rule instanceof CSSKeyframesRule) continue;
          if ("cssRules" in rule && "deleteRule" in rule) walk(rule);
          else if (!hasStyle && !(rule instanceof CSSPropertyRule)) {
            dropped.push(`rule ${rule.constructor.name}`);
            parent.deleteRule(i);
          }
        }
      };
      walk(target);
      return { rules: target.cssRules.length, dropped };
    },

    /** Replaces the user's own thread titles, project names, machine name and message text with neutral demo text. */
    mask() {
      document.querySelectorAll("[data-sidebar-row]").forEach((row, index) => {
        leaves(row).forEach((e) => {
          const text = e.textContent.trim();
          if (text.length > 12) e.textContent = TITLES[index % TITLES.length];
          else if (/^[a-z][\w-]{2,}$/.test(text) && text !== "now") e.textContent = "orbit";
        });
      });
      document.querySelectorAll('[data-slot="project-monogram"] text').forEach((e) => (e.textContent = "OR"));
      const header = document.querySelector("[data-chat-header]");
      if (header) {
        let first = true;
        leaves(header).forEach((e) => {
          const text = e.textContent.trim();
          if (["/", "No project", "New thread"].includes(text) || text.length < 3) return;
          e.textContent = first && text.length <= 14 ? "orbit" : "Lensing pass";
          first = false;
        });
      }
      const card = document.querySelector("[data-thread-details-card]");
      if (card) {
        leaves(card).forEach((e) => {
          const text = e.textContent.trim();
          if (/LAPTOP-|-MAC-|DESKTOP-/.test(text) && text.length < 24) e.textContent = "Workstation";
          else if (/LAPTOP-|-MAC-|DESKTOP-/.test(text) || text.length > 22) e.textContent = "Linked thread";
        });
      }
      const heading = document.querySelector("[data-chat-composer-stack] h1");
      if (heading) heading.textContent = "What should we work on?";
      const scroller = document.querySelector(".messages-timeline-scroll");
      if (scroller) {
        let at = 0;
        const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach((node) => {
          const raw = node.nodeValue;
          const core = raw.trim();
          if (core.length < 3) return;
          let out = "";
          while (out.length < core.length) out += FILLER.slice(at % FILLER.length) + " ", (at += 97);
          node.nodeValue = raw.replace(core, out.slice(0, core.length));
        });
      }
      return true;
    },

    /** Fakes a composer state, since the preview connection is read-only: "idle", "ready" (send enabled) or "working" (stop shown). */
    state(name) {
      const buttons = [...document.querySelectorAll("[data-chat-composer-form] button")];
      const send = buttons[buttons.length - 1];
      if (!send) return false;
      const classes = send.className.replace("bg-destructive/90", "bg-message-action");
      send.className = name === "working" ? classes.replace("bg-message-action", "bg-destructive/90") : classes;
      send.disabled = name === "idle";
      return true;
    },
  };
  return "kit ready";
})();
