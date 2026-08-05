import { formatCommentsForEditor } from "../lib/format-comments.ts";
import { reviewManager } from "../lib/review-manager.ts";

async function main() {
	const sessionId = "smoke-ts-session";
	const markdown = [
		"# Plan",
		"",
		"Preserve immutable source revisions for rollback.",
		"",
		"Also ship the browser comment flow.",
		"",
		"```mermaid",
		"flowchart TD",
		"  A[Pi] --> B[Browser comment]",
		"```",
	].join("\n");

	const { url, result } = await reviewManager.openReview({ sessionId, markdown });
	console.log("opened", url);

	const dataRes = await fetch(`${url}/data`);
	console.log("data", dataRes.status, await dataRes.json());

	const pageRes = await fetch(url);
	console.log("page", pageRes.status, (await pageRes.text()).includes("Pi Comment"));

	const assetBase = `http://127.0.0.1:${new URL(url).port}/assets`;
	const appRes = await fetch(`${assetBase}/app.js`);
	const appText = await appRes.text();
	console.log("app.js", appRes.status, appText.includes("renderMermaidDiagrams"));

	const mermaidRes = await fetch(`${assetBase}/vendor/mermaid.min.js`);
	console.log("mermaid", mermaidRes.status, mermaidRes.headers.get("content-type"));

	const submitRes = await fetch(`${url}/submit`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			comments: [
				{
					id: "c1",
					selectedText: "Preserve immutable source revisions for rollback.",
					comment: "Should this apply to drafts too?",
				},
				{
					id: "c2",
					selectedText: "browser comment flow",
					comment: "Keep v0 simple.",
				},
			],
			overallNote: "Ship this week; polish can follow.",
		}),
	});
	console.log("submit http", submitRes.status, await submitRes.json());

	const outcome = await result;
	console.log("outcome", outcome);
	if (outcome.status === "submitted") {
		console.log("--- editor text ---");
		console.log(formatCommentsForEditor(outcome.comments, outcome.overallNote));
	}

	// Second session isolation
	const other = await reviewManager.openReview({
		sessionId: "other-session",
		markdown: "Other session text",
	});
	console.log("other opened", other.url);
	const otherData = await (await fetch(`${other.url}/data`)).json();
	console.log("other data", otherData);
	await fetch(`${other.url}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	console.log("other outcome", await other.result);

	await reviewManager.shutdownAll();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
