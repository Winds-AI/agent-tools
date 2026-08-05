/** Operational comment shape (UI + submit payload). Agent only sees selectedText + comment. */
export type Comment = {
	id: string;
	selectedText: string;
	comment: string;
};

export type ReviewOutcome =
	| { status: "submitted"; comments: Comment[]; overallNote: string }
	| { status: "cancelled"; reason: "user" | "replaced" | "shutdown" | "timeout" };

export type ReviewRequest = {
	sessionId: string;
	markdown: string;
	/** Auto-cancel after this many ms. Default 60 minutes. */
	timeoutMs?: number;
};
