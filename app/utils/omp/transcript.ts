// Turn omp session entries into renderable transcript items for the active branch.
// Pure functions over parsed entries; the session composable feeds them.
import type { ContentBlock, Entry, ImageBlock, MessageEntry, ToolResult } from "./schema";

export type Part =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "image"; data: string; mimeType: string }
	| { kind: "tool"; call: ToolView };

export interface ToolView {
	id: string;
	name: string;
	args: Record<string, unknown>;
	intent?: string;
	status: "running" | "done" | "error";
	result?: ToolResult;
}

export interface Siblings {
	index: number;
	count: number;
	/** Entry ids of each sibling, in file order. */
	ids: string[];
}

export type Item =
	| { kind: "user"; entryId: string; text: string; images: ImageBlock[]; files: string[]; siblings: Siblings }
	| { kind: "assistant"; entryId: string; parts: Part[]; model: string; error?: string; aborted: boolean; siblings: Siblings }
	| { kind: "event"; entryId: string; icon: string; text: string };

export interface Tree {
	byId: Map<string, Entry>;
	children: Map<string | null, Entry[]>;
	order: Map<string, number>;
}

export function buildTree(entries: Entry[]): Tree {
	const byId = new Map<string, Entry>();
	const children = new Map<string | null, Entry[]>();
	const order = new Map<string, number>();
	entries.forEach((e, i) => {
		byId.set(e.id, e);
		order.set(e.id, i);
		const list = children.get(e.parentId);
		if (list) list.push(e);
		else children.set(e.parentId, [e]);
	});
	return { byId, children, order };
}

/** Root-to-leaf chain. Stops on missing parents and cycles instead of looping. */
export function activePath(tree: Tree, leafId: string | null): Entry[] {
	const out: Entry[] = [];
	const seen = new Set<string>();
	let cur = leafId ? tree.byId.get(leafId) : undefined;
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id);
		out.push(cur);
		cur = cur.parentId ? tree.byId.get(cur.parentId) : undefined;
	}
	return out.reverse();
}

/** Newest entry in a subtree, by file order: where "switch to this branch" should land. */
export function newestLeaf(tree: Tree, rootId: string): string {
	let best = rootId;
	let bestOrder = tree.order.get(rootId) ?? -1;
	const stack = [rootId];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const o = tree.order.get(id) ?? -1;
		if (o > bestOrder) {
			best = id;
			bestOrder = o;
		}
		for (const c of tree.children.get(id) ?? []) stack.push(c.id);
	}
	return best;
}

const messageRole = (e: Entry): string | undefined => (e.type === "message" ? e.message.role : undefined);

/** Entries the transcript doesn't render (context notices, extension state, …). omp inserts
 *  them between a branch point and the next message, so each resend gets its own one. */
const isHidden = (e: Entry) => e.type === "other";

/** The visible branch point above an entry: its parent, skipping hidden entries. */
function branchPoint(tree: Tree, entry: Entry): string | null {
	let p = entry.parentId;
	for (let e = p ? tree.byId.get(p) : undefined; e && isHidden(e); e = e.parentId ? tree.byId.get(e.parentId) : undefined) p = e.parentId;
	return p;
}

/** Same-role messages reached from the same branch point through hidden entries only. */
function descendantsOfRole(tree: Tree, from: string | null, role: string, out: string[]): void {
	for (const c of tree.children.get(from) ?? []) {
		if (messageRole(c) === role) out.push(c.id);
		else if (isHidden(c)) descendantsOfRole(tree, c.id, role, out);
	}
}

/** The alternatives a branch switcher cycles through, in file order. */
function siblingsOf(tree: Tree, entry: MessageEntry): Siblings {
	const ids: string[] = [];
	descendantsOfRole(tree, branchPoint(tree, entry), entry.message.role, ids);
	ids.sort((a, b) => (tree.order.get(a) ?? 0) - (tree.order.get(b) ?? 0));
	return { index: Math.max(0, ids.indexOf(entry.id)), count: ids.length, ids };
}

type UserBlock = { type: "text"; text: string } | ImageBlock | { type: "other" };

export function textOf(content: string | readonly UserBlock[] | readonly ContentBlock[]): string {
	if (typeof content === "string") return content;
	let out = "";
	for (const b of content) if (b.type === "text") out += b.text;
	return out;
}

function imagesOf(content: string | readonly UserBlock[]): ImageBlock[] {
	if (typeof content === "string") return [];
	return content.filter((b): b is ImageBlock => b.type === "image");
}

/** `@"path"` / `@'path'` / `@path` mentions; the composer sends attached files this way. */
const MENTION = /@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g;

/** Split file mentions out of user text. Bare `@word` without `/` or `.` stays prose.
 *  Like omp, trailing punctuation after a bare mention is prose, not part of the path. */
export function splitMentions(text: string): { text: string; files: string[] } {
	const files: string[] = [];
	const rest = text.replace(MENTION, (whole: string, dq?: string, sq?: string, bare?: string) => {
		if (bare === undefined) {
			files.push(dq ?? sq ?? "");
			return "";
		}
		const trail = /[)\]}>.,;:!?"'`]+$/.exec(bare)?.[0] ?? "";
		const path = bare.slice(0, bare.length - trail.length);
		if (!path.includes("/") && !path.includes(".")) return whole;
		files.push(path);
		return trail;
	});
	return { text: rest.replace(/[ \t]+$/gm, "").replace(/^\s+|\s+$/g, ""), files };
}

function assistantParts(content: readonly ContentBlock[], results: Map<string, ToolResult>): Part[] {
	const parts: Part[] = [];
	for (const b of content) {
		switch (b.type) {
			case "text":
				if (b.text) parts.push({ kind: "text", text: b.text });
				break;
			case "thinking":
				if (b.thinking.trim()) parts.push({ kind: "thinking", text: b.thinking });
				break;
			case "image":
				parts.push({ kind: "image", data: b.data, mimeType: b.mimeType });
				break;
			case "toolCall": {
				const r = results.get(b.id);
				const status = r ? (r.isError ? "error" : "done") : "running";
				parts.push({ kind: "tool", call: { id: b.id, name: b.name, args: b.arguments, intent: b.intent, status, result: r } });
				break;
			}
		}
	}
	return parts;
}

function event(e: Entry): { icon: string; text: string } | undefined {
	switch (e.type) {
		case "model_change":
			return { icon: "i-lucide-cpu", text: `Model: ${e.model}` };
		case "thinking_level_change":
			return e.thinkingLevel ? { icon: "i-lucide-brain", text: `Thinking: ${e.thinkingLevel}` } : undefined;
		case "mode_change":
			return { icon: "i-lucide-map", text: e.mode === "plan" ? "Plan mode on" : e.mode === "none" ? "Plan mode off" : `Mode: ${e.mode}` };
		case "compaction":
			return { icon: "i-lucide-shrink", text: `Context compacted (${e.tokensBefore.toLocaleString()} tokens before)` };
		case "branch_summary":
			return { icon: "i-lucide-git-branch", text: "Summary of the abandoned branch" };
		default:
			return undefined;
	}
}

/**
 * Transcript items for the active path. Tool results pair with calls by id (adjacency isn't
 * enough on a branched path). The model/thinking entries every session opens with are hidden.
 */
export function buildItems(tree: Tree, leafId: string | null): Item[] {
	const path = activePath(tree, leafId);
	const results = new Map<string, ToolResult>();
	for (const e of path) {
		if (e.type === "message" && e.message.role === "toolResult") {
			results.set(e.message.toolCallId, { content: e.message.content, details: e.message.details, isError: e.message.isError });
		}
	}
	const items: Item[] = [];
	let seenMessage = false;
	for (const e of path) {
		if (e.type === "message") {
			const m = e.message;
			if (m.role === "user") {
				seenMessage = true;
				const { text, files } = splitMentions(textOf(m.content));
				items.push({ kind: "user", entryId: e.id, text, images: imagesOf(m.content), files, siblings: siblingsOf(tree, e) });
			} else if (m.role === "assistant") {
				seenMessage = true;
				items.push({
					kind: "assistant",
					entryId: e.id,
					parts: assistantParts(m.content, results),
					model: m.model,
					error: m.stopReason === "error" ? (m.errorMessage ?? "The model returned an error.") : undefined,
					aborted: m.stopReason === "aborted",
					siblings: siblingsOf(tree, e),
				});
			}
			continue;
		}
		if (!seenMessage && (e.type === "model_change" || e.type === "thinking_level_change")) continue;
		const ev = event(e);
		if (ev) items.push({ kind: "event", entryId: e.id, ...ev });
	}
	return items;
}

/** Labels by target entry id; later label entries win, an absent label removes it. */
export function labels(entries: readonly Entry[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const e of entries) {
		if (e.type !== "label") continue;
		if (e.label) out.set(e.targetId, e.label);
		else out.delete(e.targetId);
	}
	return out;
}

/** The last `mode_change` on the active path decides whether plan mode should be on. */
export function planModeOnPath(tree: Tree, leafId: string | null): { enabled: boolean; planFilePath?: string } {
	const path = activePath(tree, leafId);
	for (let i = path.length - 1; i >= 0; i--) {
		const e = path[i]!;
		if (e.type === "mode_change") return e.mode === "plan" ? { enabled: true, planFilePath: e.data?.planFilePath } : { enabled: false };
	}
	return { enabled: false };
}
