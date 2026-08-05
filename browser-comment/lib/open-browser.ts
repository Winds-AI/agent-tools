import { spawn } from "node:child_process";

/**
 * Open a URL in the platform browser.
 * Same safe pattern as pi's internal openBrowser (no shell, best-effort).
 */
export function openBrowser(target: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
