// Runtime schemas for the omp data ompi renders. Everything that crosses the RPC boundary is
// parsed here once; the rest of the app works with these typed shapes. Unknown entry types,
// roles and content blocks are kept as `other` so newer omp versions degrade instead of failing.
import { z } from "zod";

const text = z.object({ type: z.literal("text"), text: z.string() });
const image = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const thinking = z.object({ type: z.literal("thinking"), thinking: z.string() });
const toolCall = z.object({
	type: z.literal("toolCall"),
	id: z.string(),
	name: z.string(),
	arguments: z.record(z.string(), z.unknown()).catch({}),
	intent: z.string().optional(),
});
const otherBlock = z.object({ type: z.string() }).transform(() => ({ type: "other" as const }));

export const ContentBlock = z.union([text, image, thinking, toolCall, otherBlock]);
export type ContentBlock = z.infer<typeof ContentBlock>;
export type TextBlock = z.infer<typeof text>;
export type ImageBlock = z.infer<typeof image>;
export type ToolCallBlock = z.infer<typeof toolCall>;

const userContent = z.union([z.string(), z.array(z.union([text, image, otherBlock]))]);

export const ToolResult = z.object({
	content: z.array(z.union([text, image, otherBlock])).catch([]),
	details: z.record(z.string(), z.unknown()).optional().catch(undefined),
	isError: z.boolean().optional(),
});
export type ToolResult = z.infer<typeof ToolResult>;

const usage = z.object({
	input: z.number(),
	output: z.number(),
	totalTokens: z.number().optional(),
	cost: z.object({ total: z.number() }).partial().optional(),
});

export const Message = z.union([
	z.object({ role: z.enum(["user", "developer"]), content: userContent, timestamp: z.number().optional() }),
	z.object({
		role: z.literal("assistant"),
		content: z.array(ContentBlock),
		model: z.string().catch(""),
		provider: z.string().catch(""),
		usage: usage.optional().catch(undefined),
		stopReason: z.string().optional(),
		errorMessage: z.string().optional(),
	}),
	z.object({
		role: z.literal("toolResult"),
		toolCallId: z.string(),
		toolName: z.string(),
		content: ToolResult.shape.content,
		details: ToolResult.shape.details,
		isError: z.boolean().catch(false),
	}),
	z.object({ role: z.string() }).transform(m => ({ role: "other" as const, originalRole: m.role })),
]);
export type Message = z.infer<typeof Message>;

const base = { id: z.string(), parentId: z.string().nullable(), timestamp: z.string().catch("") };

export const Entry = z.union([
	z.object({ ...base, type: z.literal("message"), message: Message }),
	z.object({ ...base, type: z.literal("model_change"), model: z.string() }),
	z.object({ ...base, type: z.literal("thinking_level_change"), thinkingLevel: z.string().nullable().optional() }),
	z.object({ ...base, type: z.literal("mode_change"), mode: z.string(), data: z.object({ planFilePath: z.string().optional() }).partial().optional().catch(undefined) }),
	z.object({ ...base, type: z.literal("compaction"), summary: z.string().catch(""), tokensBefore: z.number().catch(0) }),
	z.object({ ...base, type: z.literal("branch_summary"), summary: z.string().catch("") }),
	z.object({ ...base, type: z.literal("label"), targetId: z.string(), label: z.string().optional() }),
	z.object({ ...base, type: z.string() }).transform(e => ({ id: e.id, parentId: e.parentId, timestamp: e.timestamp, type: "other" as const, originalType: e.type })),
]);
export type Entry = z.infer<typeof Entry>;
export type MessageEntry = Extract<Entry, { type: "message" }>;

export const EntriesPage = z.object({ entries: z.array(z.unknown()), leafId: z.string().nullable() });

/** Parse entries one by one so a single malformed record never hides the transcript. */
export function parseEntries(raw: unknown[]): Entry[] {
	const out: Entry[] = [];
	for (const r of raw) {
		const p = Entry.safeParse(r);
		if (p.success) out.push(p.data);
	}
	return out;
}

export const Model = z.object({
	provider: z.string(),
	id: z.string(),
	name: z.string().catch(""),
	reasoning: z.boolean().optional(),
	input: z.array(z.string()).optional(),
	contextWindow: z.number().optional(),
	cost: z.object({ input: z.number(), output: z.number() }).partial().optional().catch(undefined),
});
export type Model = z.infer<typeof Model>;

export const SessionState = z.object({
	model: Model.optional().catch(undefined),
	thinkingLevel: z.string().optional(),
	isStreaming: z.boolean().catch(false),
	isCompacting: z.boolean().catch(false),
	sessionId: z.string(),
	sessionFile: z.string().optional(),
	sessionName: z.string().optional(),
	queuedMessages: z.object({ steering: z.array(z.string()), followUp: z.array(z.string()) }).optional().catch(undefined),
	contextUsage: z.object({ tokens: z.number(), contextWindow: z.number(), percent: z.number() }).optional().catch(undefined),
	fastModeEnabled: z.boolean().optional(),
});
export type SessionState = z.infer<typeof SessionState>;

export const SlashCommand = z.object({
	name: z.string(),
	source: z.string(),
	description: z.string().optional(),
	aliases: z.array(z.string()).optional(),
	input: z.object({ hint: z.string().optional() }).optional(),
	subcommands: z.array(z.object({ name: z.string(), description: z.string().optional(), usage: z.string().optional() })).optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const AskQuestion = z.object({
	id: z.string(),
	question: z.string(),
	options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
	multi: z.boolean().optional(),
});
export type AskQuestion = z.infer<typeof AskQuestion>;

export const Dialog = z.discriminatedUnion("method", [
	z.object({ id: z.string(), method: z.literal("select"), title: z.string(), options: z.array(z.string()), optionDetails: z.array(z.object({ description: z.string().optional() })).optional(), timeout: z.number().optional() }),
	z.object({ id: z.string(), method: z.literal("confirm"), title: z.string(), message: z.string().catch(""), timeout: z.number().optional() }),
	z.object({ id: z.string(), method: z.literal("input"), title: z.string(), placeholder: z.string().optional(), timeout: z.number().optional() }),
	z.object({ id: z.string(), method: z.literal("editor"), title: z.string(), prefill: z.string().optional() }),
	z.object({ id: z.string(), method: z.literal("ask"), questions: z.array(AskQuestion) }),
]);
export type Dialog = z.infer<typeof Dialog>;

export const BridgeReply = z.object({ req: z.string(), ok: z.boolean(), error: z.string().optional() }).passthrough();
