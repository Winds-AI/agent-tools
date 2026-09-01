/**
 * pi extension: exa-web
 *
 * Adds two tools for web search and content extraction via the Exa API.
 *
 * Setup:
 *   1. Run npm install in this package directory.
 *   2. Copy .env.example to .env and set EXA_API_KEY.
 *   3. Restart Pi.
 *
 * Get a key at: https://dashboard.exa.ai/api-keys
 * Docs:        https://docs.exa.ai/reference/search
 *              https://docs.exa.ai/reference/get-contents
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";

// --- Config: optional .env beside this extension -----------------------

const ENV_PATH = fileURLToPath(new URL(".env", import.meta.url));

// dotenv.config() never overrides existing process.env values, so a real
// shell export (or CI env) wins over the .env file.
config({ path: ENV_PATH });

function getApiKey(): string {
	const key = process.env.EXA_API_KEY;
	if (!key) {
		const reason = existsSync(ENV_PATH)
			? `EXA_API_KEY is not set in ${ENV_PATH}`
			: `${ENV_PATH} does not exist`;
		throw new Error(
			`exa: ${reason}. Add a line: EXA_API_KEY=your-key-here\n` +
				`Get a key at: https://dashboard.exa.ai/api-keys\n` +
				`Then run /reload in pi.`,
		);
	}
	return key;
}

// --- HTTP ---------------------------------------------------------------

const EXA_BASE = "https://api.exa.ai";

async function exaRequest(endpoint: string, body: unknown, signal?: AbortSignal) {
	const res = await fetch(`${EXA_BASE}${endpoint}`, {
		method: "POST",
		headers: {
			"x-api-key": getApiKey(),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});
	const text = await res.text().catch(() => "");
	if (!res.ok) {
		throw new Error(`exa ${endpoint} failed: ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
	}
	// Exa also returns { error, tag } bodies on 200 OK when validation fails.
	// JSON.parse throws on non-JSON, which is fine for a 200.
	const parsed = JSON.parse(text);
	if (parsed && typeof parsed === "object" && "error" in parsed) {
		throw new Error(`exa ${endpoint} error: ${parsed.error}\ntag: ${parsed.tag ?? "unknown"}`);
	}
	return parsed;
}

// --- Helpers ------------------------------------------------------------

// Returns a ContentsOptions object only if at least one flag is set,
// so we never send an empty `contents: {}` to the API.
function buildContents(text?: boolean, highlights?: boolean, summary?: boolean) {
	const c: Record<string, true> = {};
	if (text) c.text = true;
	if (highlights) c.highlights = true;
	if (summary) c.summary = true;
	return Object.keys(c).length > 0 ? c : undefined;
}

async function writeTempFile(content: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-exa-web-"));
	const file = join(dir, "output.json");
	await writeFile(file, content, "utf8");
	return file;
}

// Stringify → truncate (same pattern as the built-in bash tool; truncateTail
// handles single-line input via its partial-line edge case) → temp file if
// truncated. Returns the tool result the LLM sees.
async function respond(data: unknown) {
	const fullJson = JSON.stringify(data);
	const t = truncateTail(fullJson, { maxBytes: DEFAULT_MAX_BYTES });
	let text = t.content;
	if (t.truncated) {
		const tempFile = await writeTempFile(fullJson);
		text +=
			`\n\n[Output truncated: showing ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}.` +
			` Full response at ${tempFile}]`;
	}
	return { content: [{ type: "text" as const, text }] };
}

// --- Extension ----------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Tool 1: exa_search
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description:
			"Search the web using Exa. Returns the raw Exa /search response as compact JSON (requestId, results[], costDollars, etc).",
		promptSnippet: "Search the web and return the raw Exa search response as JSON.",
		promptGuidelines: [
			"Use exa_search when you need current information from the public web.",
			'Use exa_search with category="research paper" for academic sources, or category="news" for recent events.',
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search query." }),
			numResults: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 100, description: "Number of results to return (1-100, default 10)." }),
			),
			type: Type.Optional(
				StringEnum(
					[
						"neural",
						"keyword",
						"auto",
						"hybrid",
						"fast",
						"instant",
						"deep-lite",
						"deep",
						"deep-reasoning",
						"magic",
					] as const,
					{ description: "Search type (default 'auto')." },
				),
			),
			category: Type.Optional(
				StringEnum(
					["company", "research paper", "news", "personal site", "financial report", "people"] as const,
					{ description: "Optional data category to focus the search on." },
				),
			),
			includeDomains: Type.Optional(
				Type.Array(Type.String(), { description: "Limit results to these domains (max 1200)." }),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String(), { description: "Exclude results from these domains (max 1200)." }),
			),
			startPublishedDate: Type.Optional(
				Type.String({ description: "ISO 8601 date — only return results published after this." }),
			),
			endPublishedDate: Type.Optional(
				Type.String({ description: "ISO 8601 date — only return results published before this." }),
			),
			text: Type.Optional(Type.Boolean({ description: "Include the full page text for each result." })),
			highlights: Type.Optional(Type.Boolean({ description: "Include highlighted snippets for each result." })),
			summary: Type.Optional(Type.Boolean({ description: "Include an LLM-generated summary for each result." })),
		}),
		async execute(_id, params, signal) {
			const body: Record<string, unknown> = {
				query: params.query,
				numResults: params.numResults,
				type: params.type,
				category: params.category,
				includeDomains: params.includeDomains,
				excludeDomains: params.excludeDomains,
				startPublishedDate: params.startPublishedDate,
				endPublishedDate: params.endPublishedDate,
			};
			const contents = buildContents(params.text, params.highlights, params.summary);
			if (contents) body.contents = contents;
			return respond(await exaRequest("/search", body, signal));
		},
	});

	// Tool 2: exa_get_contents
	pi.registerTool({
		name: "exa_get_contents",
		label: "Exa Get Contents",
		description:
			"Extract clean text, highlights, or summaries from a list of URLs via Exa. Returns the raw Exa /contents response as compact JSON (results[], statuses[] for per-URL success/error, costDollars, etc).",
		promptSnippet: "Extract content from a list of URLs and return the raw Exa contents response as JSON.",
		promptGuidelines: [
			"Use exa_get_contents to fetch the actual content of URLs.",
			"Use exa_get_contents with maxAgeHours=0 to force a fresh fetch instead of cache.",
		],
		parameters: Type.Object({
			urls: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 100,
				description: "URLs to extract content from (1-100).",
			}),
			text: Type.Optional(Type.Boolean({ description: "Include the full page text for each URL." })),
			highlights: Type.Optional(Type.Boolean({ description: "Include highlighted snippets for each URL." })),
			summary: Type.Optional(Type.Boolean({ description: "Include an LLM-generated summary for each URL." })),
			maxAgeHours: Type.Optional(
				Type.Integer({
					minimum: -1,
					maximum: 720,
					description:
						"Max age of cached content in hours. 0 = force fresh fetch. -1 = always use cache. Omit for fallback fetch.",
				}),
			),
		}),
		async execute(_id, params, signal) {
			const body: Record<string, unknown> = {
				urls: params.urls,
				maxAgeHours: params.maxAgeHours,
			};
			const contents = buildContents(params.text, params.highlights, params.summary);
			if (contents) body.contents = contents;
			return respond(await exaRequest("/contents", body, signal));
		},
	});
}
