import { execFileSync } from "node:child_process";

/**
 * macOS only: remember frontmost app, restore later.
 * Best-effort, intentionally tiny — no-op elsewhere / on failure.
 */

export function captureFrontmostApp(): string | null {
	if (process.platform !== "darwin") return null;
	try {
		const name = execFileSync(
			"osascript",
			["-e", "tell application \"System Events\" to return name of first process whose frontmost is true"],
			{ encoding: "utf8", timeout: 2000 },
		).trim();
		return name || null;
	} catch {
		return null;
	}
}

function escapeAppleScriptString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function restoreFrontmostApp(name: string | null | undefined): void {
	if (process.platform !== "darwin" || !name) return;
	try {
		execFileSync(
			"osascript",
			[
				"-e",
				`tell application "System Events" to set frontmost of first process whose name is "${escapeAppleScriptString(name)}" to true`,
			],
			{ encoding: "utf8", timeout: 2000 },
		);
	} catch {
		// ignore — focus restore is best-effort
	}
}
