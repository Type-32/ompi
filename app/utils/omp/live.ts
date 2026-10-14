// In-progress assistant output built from streaming frames. It's dropped once the turn's
// persisted entries arrive (`get_entries {since}`), so it only has to look right, not be durable.
import type { Frame } from "./frames";
import type { Part, ToolView } from "./transcript";

export interface LiveMessage {
	id: string;
	parts: Part[];
}

export interface LiveTurn {
	messages: LiveMessage[];
	tools: Map<string, ToolView>;
}

export const emptyLive = (): LiveTurn => ({ messages: [], tools: new Map() });

function messageFor(live: LiveTurn, id: string): LiveMessage {
	let m = live.messages.find(x => x.id === id);
	if (!m) {
		m = { id, parts: [] };
		live.messages.push(m);
	}
	return m;
}

/** Text and thinking deltas carry `contentIndex`: one part per content block. */
function appendDelta(m: LiveMessage, kind: "text" | "thinking", delta: string, index: number | undefined): void {
	if (index === undefined) {
		const last = m.parts.at(-1);
		if (last && last.kind === kind) last.text += delta;
		else m.parts.push({ kind, text: delta });
		return;
	}
	while (m.parts.length < index) m.parts.push({ kind: "text", text: "" });
	const slot = m.parts[index];
	if (slot && slot.kind === kind) slot.text += delta;
	else if (!slot) m.parts.push({ kind, text: delta });
	else m.parts.splice(index, 0, { kind, text: delta });
}

/** Apply one frame. Returns true when the live view changed. */
export function applyFrame(live: LiveTurn, f: Frame): boolean {
	switch (f.type) {
		case "message_update": {
			const ev = f.assistantMessageEvent;
			if (!ev.delta || (ev.type !== "text_delta" && ev.type !== "thinking_delta")) return false;
			appendDelta(messageFor(live, f.messageId), ev.type === "text_delta" ? "text" : "thinking", ev.delta, ev.contentIndex);
			return true;
		}
		case "tool_execution_start": {
			const view: ToolView = { id: f.toolCallId, name: f.toolName, args: f.args, intent: f.intent, status: "running" };
			live.tools.set(f.toolCallId, view);
			(live.messages.at(-1) ?? messageFor(live, `tool-${f.toolCallId}`)).parts.push({ kind: "tool", call: view });
			return true;
		}
		case "tool_execution_update": {
			const view = live.tools.get(f.toolCallId);
			if (!view) return false;
			view.result = f.partialResult;
			return true;
		}
		case "tool_execution_end": {
			const view = live.tools.get(f.toolCallId);
			if (!view) return false;
			view.result = f.result;
			view.status = f.isError ? "error" : "done";
			return true;
		}
		default:
			return false;
	}
}
