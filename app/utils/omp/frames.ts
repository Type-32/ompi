// Discriminated parse of the stdout frames ompi acts on. Frames that fail to parse or that
// ompi doesn't route on come back as `{ type: "ignored" }`.
import { z } from "zod";
import { Dialog, Message, SlashCommand, ToolResult } from "./schema";

const ui = z.discriminatedUnion("method", [
	z.object({ method: z.literal("cancel"), id: z.string(), targetId: z.string() }),
	z.object({ method: z.literal("notify"), id: z.string(), message: z.string(), notifyType: z.enum(["info", "warning", "error"]).optional() }),
	z.object({ method: z.literal("setStatus"), id: z.string(), statusKey: z.string(), statusText: z.string().optional() }),
	z.object({ method: z.literal("setWidget"), id: z.string(), widgetKey: z.string(), widgetLines: z.array(z.string()).optional() }),
	z.object({ method: z.literal("open_url"), id: z.string(), url: z.string(), launchUrl: z.string().optional(), instructions: z.string().optional() }),
]);

const events = z.discriminatedUnion("type", [
	z.object({ type: z.literal("response"), id: z.string().optional(), command: z.string(), success: z.boolean(), data: z.unknown().optional(), error: z.string().optional() }),
	z.object({ type: z.literal("agent_start") }),
	z.object({ type: z.literal("agent_end"), isTerminal: z.boolean().optional() }),
	z.object({ type: z.literal("turn_end") }),
	z.object({ type: z.literal("message_start"), messageId: z.string().optional(), message: z.object({ role: z.string() }).passthrough() }),
	z.object({
		type: z.literal("message_update"),
		messageId: z.string(),
		assistantMessageEvent: z.object({ type: z.string(), contentIndex: z.number().optional(), delta: z.string().optional() }),
	}),
	z.object({ type: z.literal("message_end"), messageId: z.string().optional(), message: Message }),
	z.object({ type: z.literal("tool_execution_start"), toolCallId: z.string(), toolName: z.string(), args: z.record(z.string(), z.unknown()).catch({}), intent: z.string().optional() }),
	z.object({ type: z.literal("tool_execution_update"), toolCallId: z.string(), toolName: z.string(), partialResult: ToolResult }),
	z.object({ type: z.literal("tool_execution_end"), toolCallId: z.string(), toolName: z.string(), result: ToolResult, isError: z.boolean().optional() }),
	z.object({ type: z.literal("prompt_result"), id: z.string().optional(), agentInvoked: z.boolean() }),
	z.object({ type: z.literal("command_output"), text: z.string() }),
	z.object({ type: z.literal("available_commands_update"), commands: z.array(SlashCommand) }),
	z.object({ type: z.literal("session_info_update"), title: z.string().optional(), sessionId: z.string() }),
	z.object({ type: z.literal("config_update") }),
	z.object({ type: z.literal("model_changed") }),
	z.object({ type: z.literal("thinking_level_changed") }),
	z.object({ type: z.literal("notice"), level: z.enum(["info", "warning", "error"]), message: z.string(), source: z.string().optional() }),
	z.object({ type: z.literal("auto_compaction_start"), reason: z.string().catch("") }),
	z.object({ type: z.literal("auto_compaction_end"), aborted: z.boolean().catch(false), errorMessage: z.string().optional() }),
	z.object({ type: z.literal("auto_retry_start"), attempt: z.number(), maxAttempts: z.number(), delayMs: z.number(), errorMessage: z.string().catch("") }),
	z.object({ type: z.literal("auto_retry_end"), success: z.boolean() }),
]);

export type Frame =
	| z.infer<typeof events>
	| ({ type: "dialog" } & Dialog)
	| ({ type: "ui" } & z.infer<typeof ui>)
	| { type: "ignored" };

export function parseFrame(raw: unknown): Frame {
	if (raw && typeof raw === "object" && "type" in raw && raw.type === "extension_ui_request") {
		const d = Dialog.safeParse(raw);
		if (d.success) return { type: "dialog", ...d.data };
		const u = ui.safeParse(raw);
		return u.success ? { type: "ui", ...u.data } : { type: "ignored" };
	}
	const e = events.safeParse(raw);
	return e.success ? e.data : { type: "ignored" };
}
