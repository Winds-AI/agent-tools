import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class NavigationEditor extends CustomEditor {
	onNavigate?: (direction: "older" | "newer") => void;

	override handleInput(data: string): void {
		if (matchesKey(data, "super+up")) {
			this.onNavigate?.("older");
			return;
		}
		if (matchesKey(data, "super+down")) {
			this.onNavigate?.("newer");
			return;
		}
		super.handleInput(data);
	}

	submitNavigationCommand(direction: "older" | "newer"): void {
		this.setText(`/user-message-nav ${direction}`);
		super.handleInput("\r");
	}
}

function userMessageText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	if (typeof entry.message.content === "string") return entry.message.content;
	return entry.message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let editor: NavigationEditor | undefined;
	let anchors: Array<{ id: string; text: string }> | undefined;
	let selectedIndex: number | undefined;
	let selectedText: string | undefined;
	let commandQueued = false;
	let navigationInFlight = false;

	const resetNavigation = () => {
		anchors = undefined;
		selectedIndex = undefined;
		selectedText = undefined;
		commandQueued = false;
	};

	pi.on("session_start", (_event, ctx) => {
		resetNavigation();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new NavigationEditor(tui, theme, keybindings);
			editor.onNavigate = (direction) => queueNavigation(direction, ctx);
			return editor;
		});
	});

	pi.on("session_shutdown", () => {
		editor = undefined;
		resetNavigation();
	});

	pi.on("session_tree", () => {
		if (!navigationInFlight) resetNavigation();
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "user") resetNavigation();
	});

	const queueNavigation = (direction: "older" | "newer", ctx: ExtensionContext) => {
		if (!ctx.isIdle() || commandQueued || navigationInFlight || !editor) return;

		const currentText = ctx.ui.getEditorText();
		if (currentText.trim() && currentText.trim() !== selectedText?.trim()) {
			ctx.ui.notify("Clear the edited draft before navigating user messages", "warning");
			return;
		}

		commandQueued = true;
		editor.submitNavigationCommand(direction);
	};


	pi.registerCommand("user-message-nav", {
		description: "Navigate user messages without a branch summary",
		handler: async (args, ctx) => {
			commandQueued = false;
			const direction = args.trim();
			if (direction !== "older" && direction !== "newer") return;
			if (!ctx.isIdle() || navigationInFlight) return;

			if (!anchors) {
				anchors = ctx.sessionManager
					.getBranch()
					.map((entry) => ({ id: entry.id, text: userMessageText(entry) }))
					.filter((entry): entry is { id: string; text: string } => entry.text !== undefined);
				selectedIndex = anchors.length;
			}

			const nextIndex = direction === "older" ? selectedIndex! - 1 : selectedIndex! + 1;
			const target = anchors[nextIndex];
			if (!target) return;

			navigationInFlight = true;
			try {
				ctx.ui.setEditorText("");
				const result = await ctx.navigateTree(target.id, { summarize: false });
				if (!result.cancelled) {
					selectedIndex = nextIndex;
					selectedText = target.text;
				}
			} finally {
				navigationInFlight = false;
			}
		},
	});
}
