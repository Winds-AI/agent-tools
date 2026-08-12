import { formatCommentsForEditor, openReview, shutdownAll } from "../index.ts";

async function main() {
	const sessionId = "smoke-ts-session";
	const markdown = [
		"# Plan",
		"",
		"Preserve immutable source revisions for rollback.",
		"",
		"Also ship the browser comment flow.",
	].join("\n");

	// 1. Open a review: ephemeral port, page inlines the markdown.
	const { url, result } = await openReview(sessionId, markdown);
	console.log("opened", url);

	const pageRes = await fetch(url);
	const pageText = await pageRes.text();
	console.log(
		"page",
		pageRes.status,
		"title:",
		pageText.includes("<title>Pi Comment</title>"),
		"markdown inlined:",
		pageText.includes("Preserve immutable source revisions for rollback."),
		"marked inlined:",
		pageText.includes("marked v18"),
	);

	// 2. Submit comments + note.
	const submitRes = await fetch(url + "/submit", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			comments: [
				{
					selectedText: "Preserve immutable source revisions for rollback.",
					comment: "Should this apply to drafts too?",
				},
				{
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

	// 3. Empty / malformed submits are rejected (review stays open).
	const empty = await openReview("empty-session", "x");
	const emptyRes = await fetch(empty.url + "/submit", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ comments: [], overallNote: "" }),
	});
	console.log("empty submit", emptyRes.status, await emptyRes.json());
	const badRes = await fetch(empty.url + "/submit", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ comments: "not-an-array" }),
	});
	console.log("bad shape", badRes.status, await badRes.json());
	await fetch(empty.url + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	console.log("empty cancel outcome", await empty.result);

	// 4. Second session gets its own ephemeral port + own content.
	const other = await openReview("other-session", "Other session text");
	console.log("other opened", other.url);
	const otherPage = await (await fetch(other.url)).text();
	console.log("other page has own text", otherPage.includes("Other session text"));
	await fetch(other.url + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	console.log("other outcome", await other.result);

	// 5. Reopening for the same session replaces the in-flight review.
	const first = await openReview(sessionId, "First");
	const second = await openReview(sessionId, "Second");
	console.log("first replaced:", (await first.result).reason);
	await fetch(second.url + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
	console.log("second cancelled:", (await second.result).reason);

	await shutdownAll();
	console.log("ok");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
