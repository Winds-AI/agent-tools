/**
 * pi-user-message-navigation — jump between user messages in the session tree.
 *
 * Cmd+Up   — move to the previous user message, without a branch summary
 *            or a model turn. The message is restored into the editor
 *            (pi's native /tree semantics); submitting it starts a branch.
 * Cmd+Down — move forward through user messages, then to the conversation
 *            endpoint with an empty editor, ready for a new prompt.
 *
 * "Latest branch": the session tree keeps every entry's parent, and entries
 * carry timestamps. The anchor list is built by walking the tree from the
 * root, always following the child with the newest timestamp at each fork —
 * so navigation always comes back down the most recent line of work, even in
 * heavily branched sessions. No new time tracking is added; pi's entry
 * timestamps are enough.
 *
 * Keys use pi's `registerShortcut` (editor-independent): `super+up` /
 * `super+down` (Cmd on macOS) and `ctrl+up` / `ctrl+down`. Both pairs move
 * along the session tree; transcript scrolling is done with the mouse.
 * Note ctrl+up/down overrides pi's fullscreen "jump between marked
 * messages" transcript keys — intentional, per this extension's purpose.
 *
 * Mechanics: pi's shortcut handlers receive a context without tree-control
 * methods, so shortcuts bridge to the `/user-message-nav` command (commands
 * run with full session-control context). Dispatching the command via
 * sendUserMessage with expandPromptTemplates runs it as a command — no user
 * message is created and no model turn is triggered.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type KeyId, type KeybindingsConfig } from "@earendil-works/pi-tui";

type Direction = "older" | "newer";

function userMessageText(entry: SessionEntry): string {
	const message = (entry as { message?: { role: string; content: unknown } }).message;
	if (!message || message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			typeof part === "object" && part !== null && (part as { type?: string }).type === "text")
		.map((part) => part.text)
		.join("\n");
}

function isUserMessageEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && (entry as { message?: { role?: string } }).message?.role === "user";
}

function keyList(binding: KeyId | KeyId[] | undefined): KeyId[] {
	if (binding === undefined) return [];
	return Array.isArray(binding) ? binding : [binding];
}

function withoutKey(binding: KeyId | KeyId[] | undefined, keyToRemove: KeyId): KeyId | KeyId[] {
	const next = keyList(binding).filter((key) => key.toLowerCase() !== keyToRemove.toLowerCase());
	if (next.length === 0) return [];
	return next.length === 1 ? next[0]! : next;
}

function releaseFullscreenConflicts() {
	const keybindings = getKeybindings();
	const getUserBindings = (keybindings as { getUserBindings?: () => KeybindingsConfig }).getUserBindings;
	const setUserBindings = (keybindings as { setUserBindings?: (bindings: KeybindingsConfig) => void }).setUserBindings;
	const getResolvedBindings = (keybindings as { getResolvedBindings?: () => KeybindingsConfig }).getResolvedBindings;
	if (!getUserBindings || !setUserBindings || !getResolvedBindings) return;

	// Pi fullscreen consumes ctrl+up/down as tui.altScreen.previousPrompt/nextPrompt
	// before editor/extension shortcuts see them. Remove only those two keys from
	// the in-memory keybinding manager; do not write keybindings.json and do not
	// disturb alternate bindings such as ctrl+shift+up/down.
	const user = getUserBindings.call(keybindings);
	const resolved = getResolvedBindings.call(keybindings);
	setUserBindings.call(keybindings, {
		...user,
		"tui.altScreen.previousPrompt": withoutKey(resolved["tui.altScreen.previousPrompt"], "ctrl+up"),
		"tui.altScreen.nextPrompt": withoutKey(resolved["tui.altScreen.nextPrompt"], "ctrl+down"),
	});
}

/**
 * Order user messages along the latest path, followed by its endpoint.
 * At each fork follow the child with the newest timestamp.
 */
function latestNavigationTargets(entries: SessionEntry[]): SessionEntry[] {
	const childrenOf = new Map<string | null, SessionEntry[]>();
	for (const entry of entries) {
		if (!entry.id) continue; // session header is not part of the tree
		const list = childrenOf.get(entry.parentId) ?? [];
		list.push(entry);
		childrenOf.set(entry.parentId, list);
	}

	const newest = (list: SessionEntry[]): SessionEntry | undefined =>
		list.length > 0 ? list.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b)) : undefined;

	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let node = newest(childrenOf.get(null) ?? []);
	while (node && !seen.has(node.id)) {
		seen.add(node.id);
		path.push(node);
		node = newest(childrenOf.get(node.id) ?? []);
	}
	const targets = path.filter(isUserMessageEntry);
	const endpoint = path.at(-1);
	// Native /tree navigation to a non-prompt entry restores the conversation
	// through that entry without recalling text. User/custom messages instead
	// rewind to their parent, so they cannot serve as an empty-editor endpoint.
	if (targets.length > 0 && endpoint && !isUserMessageEntry(endpoint) && endpoint.type !== "custom_message") {
		targets.push(endpoint);
	}
	return targets;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => releaseFullscreenConflicts());

	/** User messages plus the latest path's endpoint (rebuilt after changes). */
	let anchors: SessionEntry[] | undefined;
	/** Current target index; initially at the endpoint, or past a final prompt. */
	let index: number | undefined;
	/** Text of the message we last navigated to (not a user draft). */
	let selectedText: string | undefined;
	let navigating = false;

	function reset() {
		anchors = undefined;
		index = undefined;
		selectedText = undefined;
	}

	async function navigate(direction: Direction, ctx: ExtensionCommandContext) {
		if (!ctx.isIdle() || navigating) return;

		if (!anchors) {
			anchors = latestNavigationTargets(ctx.sessionManager.getEntries());
			const last = anchors.at(-1);
			index = last && !isUserMessageEntry(last) ? anchors.length - 1 : anchors.length;
		}
		if (anchors.length === 0 || index === undefined) return;

		const next = direction === "older" ? index - 1 : index + 1;
		if (next < 0 || next >= anchors.length) return;

		const target = anchors[next];
		const targetText = userMessageText(target);

		// Protect a real draft: allow navigating when the editor is empty or
		// still holds the message we navigated to, but not edited work.
		const current = ctx.ui.getEditorText().trim();
		if (current && current !== (selectedText ?? "").trim() && current !== targetText.trim()) {
			ctx.ui.notify("Editor holds an unsent draft — submit or clear it before navigating", "warning");
			return;
		}

		navigating = true;
		try {
			// Pi only restores navigateTree's target prompt into the editor when
			// the editor is empty. After the first navigation the editor contains
			// the previously selected prompt, so clear it before moving again.
			ctx.ui.setEditorText("");
			const result = await ctx.navigateTree(target.id, { summarize: false });
			if (!result.cancelled) {
				index = next;
				selectedText = targetText;
			}
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		} finally {
			navigating = false;
		}
	}

	pi.registerCommand("user-message-nav", {
		description: "Navigate to the previous/next user message (older|newer)",
		handler: async (args, ctx) => {
			const direction = args.trim();
			if (direction !== "older" && direction !== "newer") return;
			await navigate(direction, ctx);
		},
	});

	function viaCommand(direction: Direction, ctx: ExtensionContext) {
		if (!ctx.isIdle() || navigating) return;
		pi.sendUserMessage(`/user-message-nav ${direction}`, { expandPromptTemplates: true });
	}

	pi.registerShortcut("super+up", {
		description: "Go to the previous user message",
		handler: (ctx) => viaCommand("older", ctx),
	});
	pi.registerShortcut("super+down", {
		description: "Go to the next user message",
		handler: (ctx) => viaCommand("newer", ctx),
	});
	pi.registerShortcut("ctrl+up", {
		description: "Go to the previous user message",
		handler: (ctx) => viaCommand("older", ctx),
	});
	pi.registerShortcut("ctrl+down", {
		description: "Go to the next user message",
		handler: (ctx) => viaCommand("newer", ctx),
	});

	// Session changes invalidate the cached anchors. session_tree fires from
	// our own navigateTree calls too — keep state while one is in flight.
	pi.on("message_end", () => reset());
	pi.on("session_tree", () => {
		if (!navigating) reset();
	});
	pi.on("session_start", () => reset());
}
