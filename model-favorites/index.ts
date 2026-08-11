// pi-model-favorites — faithful clone of Pi's built-in /model picker
// (ModelSelectorComponent), with favorites pinned to the top of the list.
//
// Replicates the default UI/UX exactly:
//   ─ top/bottom border, provider hint / Scope line, "> " search input with
//     reverse-video cursor, fuzzy search, "→" selection, "[provider]" badges,
//     "✓" active-model checkmark, centered 10-row window, "(n/m)" scroll
//     indicator, "Model Name: ..." footer, background catalog refresh with
//     status/error messages, wrap-around ↑/↓, Tab scope toggle, Enter/Esc.
//
// Added (the feature): "★" on favorites, favorites pinned above a divider,
// "f" toggles favorite when the search box is empty.
// Favorites persist to ~/.pi/agent/model-favorites.json.

import { modelsAreEqual, type Api, type Model } from "@earendil-works/pi-ai";
import { fuzzyFilter, Key, matchesKey, type KeybindingsManager } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ---------- favorites persistence ----------

type Item = { provider: string; id: string; model: Model<Api> };

const itemKey = (i: Item): string => `${i.provider}/${i.id}`;
const configPath = (): string => join(getAgentDir(), "model-favorites.json");

function loadFavorites(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), "utf-8")) as { favorites?: unknown };
		return Array.isArray(parsed.favorites)
			? parsed.favorites.filter((f): f is string => typeof f === "string")
			: [];
	} catch {
		return [];
	}
}

function saveFavorites(favorites: string[]): void {
	try {
		writeFileSync(configPath(), JSON.stringify({ favorites }, null, 2), "utf-8");
	} catch {
		// Best-effort persistence; a write failure must not crash the picker.
	}
}

// ---------- faithful copies of built-in helpers ----------

// Same search text as dist/modes/interactive/model-search.js
const selectorSearchText = (i: Item): string => {
	const name = i.model.name ? ` ${i.model.name}` : "";
	return `${i.provider} ${i.provider}/${i.id} ${i.provider} ${i.id}${name}`;
};

// Same sorting as the built-in selector: current model first, then provider.
const makeSort =
	(current: Model<Api> | undefined) =>
	(a: Item, b: Item): number => {
		const aIsCurrent = current !== undefined && modelsAreEqual(current, a.model);
		const bIsCurrent = current !== undefined && modelsAreEqual(current, b.model);
		if (aIsCurrent && !bIsCurrent) return -1;
		if (!aIsCurrent && bIsCurrent) return 1;
		return a.provider.localeCompare(b.provider);
	};

// Same key-hint formatting as components/keybinding-hints.js
const formatKeyText = (key: string): string =>
	key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => (process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part))
				.join("+"),
		)
		.join("/");

const MAX_VISIBLE = 10;
const REVERSE_VIDEO_CURSOR = "\x1b[7m \x1b[27m"; // same cursor as pi-tui Input

export default function modelFavorites(pi: ExtensionAPI): void {
	// Note: "m" is not used because other extensions (e.g. Codex Voice) already
	// register it, which would demote this command to an ambiguous "/m:1".
	pi.registerCommand("models", {
		description: "Select a model — favorites pinned to the top",
		handler: async (args, ctx) => {
			const current = ctx.model;
			const favSet = new Set(loadFavorites());
			const sort = makeSort(current);
			let scope: "all" | "scoped" = ctx.scopedModels.length > 0 ? "scoped" : "all";

			const allModels: Item[] = ctx.modelRegistry.getAvailable().map((model) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
			const scopedItems: Item[] = ctx.scopedModels.map((s) => ({
				provider: s.model.provider,
				id: s.model.id,
				model: s.model,
			}));
			const reloadAllModels = (): void => {
				allModels.length = 0;
				allModels.push(
					...ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, model })),
				);
			};

			const chosen = await ctx.ui.custom<Model<Api> | null>(
				(tui, theme, keybindings: KeybindingsManager, done) => {
					let closed = false;
					let query = args?.trim() ?? "";
					let selectedIndex = 0;
					let errorMessage: string | undefined;
					let refreshStatusMessage = "Refreshing model catalogs…";
					let refreshStatusSuccess = false;
					let version = 0;
					let cached: { version: number; width: number; lines: string[] } | undefined;

					const isFav = (i: Item): boolean => favSet.has(itemKey(i));

					const activeItems = (): Item[] => (scope === "scoped" ? scopedItems : allModels).sort(sort);

					// Filtered rows with a marker for the favorites divider.
					const filtered = (): { items: Item[]; divider: number } => {
						const source = activeItems();
						const items = query ? fuzzyFilter(source, query, selectorSearchText) : source;
						const favs = items.filter(isFav);
						const rest = items.filter((i) => !isFav(i));
						const divider = favs.length > 0 && rest.length > 0 ? favs.length : -1;
						return { items: [...favs, ...rest], divider };
					};

					const refilter = (resetIndex: boolean): void => {
						const { items } = filtered();
						selectedIndex = resetIndex ? 0 : Math.min(selectedIndex, Math.max(0, items.length - 1));
					};

					// Background catalog refresh — same behavior as the built-in.
					const abortController = new AbortController();
					const refreshTimeout = setTimeout(() => abortController.abort(), 15_000);
					void ctx.modelRegistry
						.refresh({ signal: abortController.signal })
						.then((result) => {
							if (closed) return;
							refreshStatusMessage = "";
							if (result.aborted) {
								errorMessage = "Model refresh timed out; showing cached models.";
							} else if (result.errors.size === 1) {
								const name = result.errors.keys().next().value;
								errorMessage = `Could not refresh ${name}; showing cached models.`;
							} else if (result.errors.size > 1) {
								errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
							} else {
								errorMessage = ctx.modelRegistry.getError();
								if (!errorMessage) {
									refreshStatusMessage = "Model catalogs refreshed.";
									refreshStatusSuccess = true;
								}
							}
							reloadAllModels();
							refilter(false);
							version++;
							tui.requestRender();
						})
						.catch((err: unknown) => {
							if (closed) return;
							refreshStatusMessage = "";
							errorMessage = `Could not refresh model catalogs: ${err instanceof Error ? err.message : String(err)}`;
							version++;
							tui.requestRender();
						})
						.finally(() => clearTimeout(refreshTimeout));

					// Initial selection: current model if present, else top row.
					refilter(false);
					const initial = filtered().items.findIndex(
						(i) => current !== undefined && modelsAreEqual(current, i.model),
					);
					if (initial >= 0) selectedIndex = initial;
					if (query) refilter(true);

					const render = (width: number): string[] => {
						if (cached && cached.version === version && cached.width === width) return cached.lines;
						const { items, divider } = filtered();
						const lines: string[] = [];
						const border = theme.fg("border", "─".repeat(Math.max(1, width)));

						// Top border
						lines.push(border);
						// Hint or Scope line (same as built-in)
						if (scopedItems.length > 0) {
							const allText = scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
							const scopedText = scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
							lines.push(`${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`);
							const tabKeys = formatKeyText(keybindings.getKeys("tui.input.tab").join("/"));
							lines.push(theme.fg("dim", tabKeys) + theme.fg("muted", " scope (all/scoped)"));
						} else {
							lines.push(
								theme.fg("warning", "Only showing models from configured providers. Use /login to add providers."),
							);
						}
						// Search input (same as pi-tui Input: "> " prompt + cursor)
						const prompt = "> ";
						const visible = query.slice(0, Math.max(0, width - prompt.length - 1));
						lines.push(
							prompt + visible + REVERSE_VIDEO_CURSOR + " ".repeat(Math.max(0, width - prompt.length - visible.length - 1)),
						);
						// List (centered 10-row window, same as built-in)
						const startIndex = Math.max(
							0,
							Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE),
						);
						const endIndex = Math.min(startIndex + MAX_VISIBLE, items.length);
						for (let i = startIndex; i < endIndex; i++) {
							if (i === divider) lines.push(border);
							const item = items[i];
							if (!item) continue;
							const isSelected = i === selectedIndex;
							const isCurrent = current !== undefined && modelsAreEqual(current, item.model);
							const favMark = favSet.has(itemKey(item)) ? "★ " : "";
							const modelText = `${favMark}${item.id}`;
							const providerBadge = theme.fg("muted", `[${item.provider}]`);
							const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
							if (isSelected) {
								lines.push(`${theme.fg("accent", "→ ")}${theme.fg("accent", modelText)} ${providerBadge}${checkmark}`);
							} else {
								lines.push(`  ${modelText} ${providerBadge}${checkmark}`);
							}
						}
						// Scroll indicator
						if (startIndex > 0 || endIndex < items.length) {
							lines.push(theme.fg("muted", `  (${selectedIndex + 1}/${items.length})`));
						}
						// Error / empty / footer
						if (errorMessage) {
							for (const line of errorMessage.split("\n")) lines.push(theme.fg("error", line));
						} else if (items.length === 0) {
							lines.push(theme.fg("muted", "  No matching models"));
						} else {
							const selected = items[selectedIndex];
							lines.push("");
							lines.push(theme.fg("muted", `  Model Name: ${selected.model.name}`));
							if (query === "") lines.push(theme.fg("muted", "  [f] toggle favorite ★"));
						}
						if (refreshStatusMessage) {
							lines.push("");
							lines.push(theme.fg(refreshStatusSuccess ? "success" : "muted", `  ${refreshStatusMessage}`));
						}
						// Bottom border
						lines.push(border);

						cached = { version, width, lines };
						return lines;
					};

					const handleInput = (data: string): void => {
						if (keybindings.matches(data, "tui.input.tab")) {
							if (scopedItems.length > 0) {
								scope = scope === "all" ? "scoped" : "all";
								refilter(false);
							}
						} else if (keybindings.matches(data, "tui.select.up")) {
							const { items } = filtered();
							if (items.length === 0) return;
							selectedIndex = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
						} else if (keybindings.matches(data, "tui.select.down")) {
							const { items } = filtered();
							if (items.length === 0) return;
							selectedIndex = selectedIndex === items.length - 1 ? 0 : selectedIndex + 1;
						} else if (keybindings.matches(data, "tui.select.confirm")) {
							const { items } = filtered();
							const selected = items[selectedIndex];
							if (selected) done(selected.model);
							return;
						} else if (keybindings.matches(data, "tui.select.cancel")) {
							closed = true;
							clearTimeout(refreshTimeout);
							abortController.abort();
							done(null);
							return;
						} else if (query === "" && data.toLowerCase() === "f") {
							const { items } = filtered();
							const item = items[selectedIndex];
							if (!item) return;
							if (favSet.has(itemKey(item))) favSet.delete(itemKey(item));
							else favSet.add(itemKey(item));
							saveFavorites([...favSet]);
							// Keep selection on the same model after the list reorders.
							const target = itemKey(item);
							const { items: next } = filtered();
							const idx = next.findIndex((x) => itemKey(x) === target);
							selectedIndex = idx >= 0 ? idx : Math.min(selectedIndex, Math.max(0, next.length - 1));
						} else if (matchesKey(data, Key.backspace)) {
							query = query.slice(0, -1);
							refilter(false);
						} else if (data.length === 1 && data >= " ") {
							query += data;
							refilter(true); // typing filters → jump to best match on top
						} else {
							return;
						}
						version++;
						tui.requestRender();
					};

					return { render, invalidate: () => { cached = undefined; }, handleInput };
				},
			);

			if (chosen && !(await pi.setModel(chosen))) {
				ctx.ui.notify(`Could not set ${chosen.name} (provider not configured)`, "warning");
			}
		},
	});
}
