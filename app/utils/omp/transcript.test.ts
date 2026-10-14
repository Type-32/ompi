// bun test app/utils/omp
import { describe, expect, test } from "bun:test";
import { applyFrame, emptyLive } from "./live";
import { parseFrame } from "./frames";
import { parseEntries } from "./schema";
import { activePath, buildItems, buildTree, labels, newestLeaf, planModeOnPath, splitMentions } from "./transcript";

const msg = (id: string, parentId: string | null, role: string, content: unknown, extra: object = {}) => ({
	type: "message",
	id,
	parentId,
	timestamp: "t",
	message: { role, content, model: "m", provider: "p", ...extra },
});

describe("transcript", () => {
	test("follows the active leaf and pairs tool results by id across a branch", () => {
		const entries = parseEntries([
			{ type: "model_change", id: "m0", parentId: null, timestamp: "t", model: "a/b" },
			msg("u1", "m0", "user", "first"),
			msg("a1", "u1", "assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }]),
			msg("r1", "a1", "toolResult", [{ type: "text", text: "ok" }], { toolCallId: "c1", toolName: "read", isError: false }),
			msg("u2", "r1", "user", "old"),
			msg("u3", "r1", "user", "edited"),
			msg("a3", "u3", "assistant", [{ type: "text", text: "answer" }]),
		]);
		const tree = buildTree(entries);
		const items = buildItems(tree, "a3");
		expect(items.map(i => i.kind)).toEqual(["user", "assistant", "user", "assistant"]);
		const tool = items[1]!.kind === "assistant" ? items[1]!.parts[0] : undefined;
		expect(tool?.kind === "tool" && tool.call.status).toBe("done");
		const edited = items[2]!;
		expect(edited.kind === "user" && [edited.text, edited.siblings.index, edited.siblings.count]).toEqual(["edited", 1, 2]);
		expect(newestLeaf(tree, "u2")).toBe("u2");
		expect(newestLeaf(tree, "r1")).toBe("a3");
	});

	test("resends behind per-turn hidden entries are still siblings", () => {
		// Real omp shape: each prompt gets its own custom_message before the user message, so the
		// two user messages have different direct parents but the same visible branch point.
		const entries = parseEntries([
			msg("u1", null, "user", "apple"),
			msg("a1", "u1", "assistant", [{ type: "text", text: "apple" }]),
			{ type: "custom_message", id: "c1", parentId: "a1", timestamp: "t", customType: "xdev-mount-notice", content: "x", display: false },
			msg("u2", "c1", "user", "kiwi"),
			msg("a2", "u2", "assistant", [{ type: "text", text: "kiwi" }]),
			{ type: "custom_message", id: "c2", parentId: "a1", timestamp: "t", customType: "xdev-mount-notice", content: "x", display: false },
			msg("u3", "c2", "user", "mango"),
			msg("a3", "u3", "assistant", [{ type: "text", text: "mango" }]),
		]);
		const items = buildItems(buildTree(entries), "a3");
		const edited = items[2]!;
		expect(edited.kind === "user" && [edited.text, edited.siblings.index, edited.siblings.count, edited.siblings.ids]).toEqual(["mango", 1, 2, ["u2", "u3"]]);
	});

	test("survives cycles, missing parents and unknown entry types", () => {
		const entries = parseEntries([
			{ type: "message", id: "a", parentId: "b", timestamp: "t", message: { role: "user", content: "x" } },
			{ type: "message", id: "b", parentId: "a", timestamp: "t", message: { role: "user", content: "y" } },
			{ type: "future_thing", id: "f", parentId: "missing", timestamp: "t", whatever: 1 },
			{ garbage: true },
		]);
		expect(entries.length).toBe(3);
		const tree = buildTree(entries);
		expect(activePath(tree, "a").length).toBe(2);
		expect(activePath(tree, "f").map(e => e.id)).toEqual(["f"]);
	});

	test("plan mode and labels follow the last entry on the path", () => {
		const entries = parseEntries([
			msg("u1", null, "user", "x"),
			{ type: "mode_change", id: "p1", parentId: "u1", timestamp: "t", mode: "plan", data: { planFilePath: "local://PLAN.md" } },
			{ type: "label", id: "l1", parentId: "p1", timestamp: "t", targetId: "u1", label: "start" },
			{ type: "label", id: "l2", parentId: "l1", timestamp: "t", targetId: "u1" },
			{ type: "mode_change", id: "p2", parentId: "l2", timestamp: "t", mode: "none" },
		]);
		const tree = buildTree(entries);
		expect(planModeOnPath(tree, "l2")).toEqual({ enabled: true, planFilePath: "local://PLAN.md" });
		expect(planModeOnPath(tree, "p2")).toEqual({ enabled: false });
		expect(labels(entries).has("u1")).toBe(false);
	});

	test("splits file mentions out of user text", () => {
		expect(splitMentions('look at @"my docs/a b.txt" and @src/x.ts, thanks @bob')).toEqual({
			text: "look at  and , thanks @bob",
			files: ["my docs/a b.txt", "src/x.ts"],
		});
	});

	test("live turn accumulates deltas per content block and tracks tools", () => {
		const live = emptyLive();
		const frames = [
			{ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm" } },
			{ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } },
			{ type: "message_update", messageId: "m1", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } },
			{ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
			{ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a" }] }, isError: true },
		];
		for (const f of frames) applyFrame(live, parseFrame(f));
		const parts = live.messages[0]!.parts;
		const describe = (p: (typeof parts)[number]) => (p.kind === "tool" ? `tool:${p.call.status}` : p.kind === "image" ? "image" : `${p.kind}:${p.text}`);
		expect(parts.map(describe)).toEqual(["thinking:hm", "text:Hello", "tool:error"]);
	});

	test("unknown or malformed frames are ignored", () => {
		expect(parseFrame({ type: "brand_new_event", x: 1 }).type).toBe("ignored");
		expect(parseFrame({ type: "message_update" }).type).toBe("ignored");
		expect(parseFrame({ type: "extension_ui_request", id: "d", method: "select", title: "Allow tool: bash", options: ["Approve", "Deny"] }).type).toBe("dialog");
	});
});
