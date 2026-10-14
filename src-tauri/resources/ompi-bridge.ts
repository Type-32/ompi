// ompi bridge: an omp extension loaded with `-e` into every process ompi spawns.
// It exposes session operations that omp's RPC protocol lacks: plan mode, in-file tree
// navigation, assistant-message edits, labels and a structured context breakdown.
//
// Wire: the host sends the prompt `/ompi <base64url JSON {req, op, ...args}>`; the bridge
// replies with `ctx.ui.notify("ompi:" + JSON {req, ok, ...})`. Slash commands are not
// written to the session file or to omp's prompt history.
//
// The interfaces below describe omp internals that are not public API. `hello` reports
// which ones exist so ompi can hide features whose functions disappeared in a newer omp.

const VERSION = 1;
const DEFAULT_PLAN_URL = "local://PLAN.md";
/** Provider replay metadata that describes the original text and must not survive an edit. */
const REPLAY_FIELDS = ["providerPayload", "responseId", "contextSnapshot", "errorId"] as const;

interface ContentBlock {
	type: string;
	text?: string;
	textSignature?: string;
	id?: string;
}

interface AgentMessage {
	role: string;
	content: ContentBlock[] | string;
	toolCallId?: string;
	[key: string]: unknown;
}

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	message?: AgentMessage;
}

interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
}

interface SessionManager {
	getEntry?(id: string): Entry | undefined;
	getEntries?(): Entry[];
	appendMessageToBranch?(message: AgentMessage, parentId: string | null): string;
	appendModeChange?(mode: string, data?: object): void;
	/** `pi.setLabel` is a no-op in rpc mode on omp 18.8.9; this is the method that persists a `label` entry. */
	appendLabelChange?(targetId: string, label: string | undefined): string;
}

interface AgentSession {
	sessionManager?: SessionManager;
	getPlanModeState?(): PlanModeState | undefined;
	setPlanModeState?(state: PlanModeState | undefined): void;
	setPlanProposalHandler?(handler: ((title: string) => Promise<unknown>) | null): void;
	preparePlanForReview?(title: string): Promise<unknown>;
	setPlanReferencePath?(path: string): void;
	hasBuiltInTool?(name: string): boolean;
	getEnabledToolNames?(): string[];
	setActiveToolsByName?(names: string[]): Promise<void>;
}

interface AgentRef {
	kind: string;
	session: AgentSession | null;
}

interface CommandContext {
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
}

interface ExtensionApi {
	pi?: { AgentRegistry?: { global?(): { list?(): AgentRef[] } } };
	registerCommand(name: string, options: { description: string; handler(args: string, ctx: CommandContext): Promise<void> }): void;
}

interface ContextBreakdown {
	contextWindow: number;
	usedTokens: number;
	autoCompactBufferTokens?: number;
	freeTokens?: number;
	categories?: { label: string; tokens: number }[];
}

type Args = Record<string, unknown>;
type Op = (args: Args, ctx: CommandContext) => Promise<object>;

const str = (v: unknown, name: string): string => {
	if (typeof v !== "string" || v === "") throw new Error(`${name} must be a non-empty string`);
	return v;
};

export default function ompiBridge(pi: ExtensionApi): void {
	const main = (): AgentSession | undefined =>
		pi.pi?.AgentRegistry?.global?.()?.list?.().find(r => r.kind === "main")?.session ?? undefined;

	const requireSession = (): AgentSession => {
		const s = main();
		if (!s) throw new Error("no live main session");
		return s;
	};

	const capabilities = (s: AgentSession | undefined) => ({
		plan: !!(s?.setPlanModeState && s.setPlanProposalHandler && s.preparePlanForReview && s.getPlanModeState),
		goto: true,
		editAssistant: !!(s?.sessionManager?.appendMessageToBranch && s.sessionManager.getEntry && s.sessionManager.getEntries),
		label: typeof s?.sessionManager?.appendLabelChange === "function",
		context: true,
	});

	const planState = (s: AgentSession) => {
		const st = s.getPlanModeState?.();
		return { plan: st?.enabled ? { enabled: true, planFilePath: st.planFilePath } : { enabled: false } };
	};

	const requirePlan = (): AgentSession => {
		const s = requireSession();
		if (!capabilities(s).plan) throw new Error("plan mode is unavailable in this omp version");
		return s;
	};

	const leavePlan = (s: AgentSession): void => {
		s.setPlanProposalHandler?.(null);
		s.setPlanModeState?.(undefined);
		s.sessionManager?.appendModeChange?.("none");
	};

	const ops: Record<string, Op> = {
		async hello() {
			const s = main();
			return { version: VERSION, capabilities: capabilities(s), ...(s ? planState(s) : { plan: { enabled: false } }) };
		},

		async "plan.enter"(a) {
			const s = requirePlan();
			const prev = s.getPlanModeState?.();
			if (prev?.enabled) return planState(s);
			const planFilePath = typeof a.planFilePath === "string" ? a.planFilePath : (prev?.planFilePath ?? DEFAULT_PLAN_URL);
			s.setPlanModeState?.({ enabled: true, planFilePath, workflow: prev?.workflow ?? "parallel", reentry: prev !== undefined });
			// Plan files and the `xd://propose` approval write both need the built-in `write` tool.
			const tools = s.getEnabledToolNames?.() ?? [];
			if (s.hasBuiltInTool?.("write") && !tools.includes("write")) await s.setActiveToolsByName?.([...tools, "write"]);
			s.setPlanProposalHandler?.(title => s.preparePlanForReview!(title));
			s.sessionManager?.appendModeChange?.("plan", { planFilePath });
			return planState(s);
		},

		async "plan.approve"(a) {
			const s = requirePlan();
			if (typeof a.planFilePath === "string") s.setPlanReferencePath?.(a.planFilePath);
			leavePlan(s);
			return planState(s);
		},

		async "plan.exit"() {
			const s = requirePlan();
			if (s.getPlanModeState?.()?.enabled) leavePlan(s);
			return planState(s);
		},

		async goto(a, ctx) {
			const r = await ctx.navigateTree(str(a.entryId, "entryId"), { summarize: false });
			return { cancelled: r.cancelled };
		},

		async editAssistant(a, ctx) {
			const s = requireSession();
			const sm = s.sessionManager;
			if (!capabilities(s).editAssistant || !sm?.getEntry || !sm.getEntries || !sm.appendMessageToBranch) {
				throw new Error("editing assistant messages is unavailable in this omp version");
			}
			const entry = sm.getEntry(str(a.entryId, "entryId"));
			const original = entry?.message;
			if (!entry || entry.type !== "message" || original?.role !== "assistant" || !Array.isArray(original.content)) {
				throw new Error("not an assistant message");
			}
			if (!Array.isArray(a.texts) || !a.texts.every(t => typeof t === "string")) throw new Error("texts must be strings");
			const texts = a.texts as string[];
			let i = 0;
			const content = original.content.map(b => {
				if (b.type !== "text") return b;
				const { textSignature: _signature, ...rest } = b;
				return { ...rest, text: texts[i++] ?? b.text };
			});
			const message: AgentMessage = { ...original, content };
			for (const k of REPLAY_FIELDS) delete message[k];
			let leaf = sm.appendMessageToBranch(message, entry.parentId);
			// Keep tool calls paired with their results: copy the chain of direct tool-result children.
			const callIds = new Set(content.filter(b => b.type === "toolCall" && b.id).map(b => b.id));
			if (callIds.size > 0) {
				const entries = sm.getEntries();
				let cursor = entry.id;
				for (;;) {
					const next = entries.find(
						e => e.parentId === cursor && e.message?.role === "toolResult" && callIds.has(e.message.toolCallId),
					);
					if (!next?.message) break;
					leaf = sm.appendMessageToBranch(next.message, leaf);
					cursor = next.id;
				}
			}
			const r = await ctx.navigateTree(leaf, { summarize: false });
			return { entryId: leaf, cancelled: r.cancelled };
		},

		async label(a) {
			const sm = requireSession().sessionManager;
			if (!sm?.appendLabelChange) throw new Error("labels are unavailable in this omp version");
			sm.appendLabelChange(str(a.entryId, "entryId"), typeof a.label === "string" && a.label ? a.label : undefined);
			return {};
		},

		async context() {
			const s = requireSession();
			try {
				// Dynamic on purpose: a static import of this omp internal would stop the whole bridge
				// from loading if a future omp moves it. omp only resolves literal specifiers here.
				const mod: { computeSessionContextBreakdown(s: AgentSession, o: object): ContextBreakdown } = await import(
					"@oh-my-pi/pi-coding-agent/session/context-usage-runtime"
				);
				const b = mod.computeSessionContextBreakdown(s, { snapcompactSavings: false });
				return {
					contextWindow: b.contextWindow,
					usedTokens: b.usedTokens,
					autoCompactBufferTokens: b.autoCompactBufferTokens ?? 0,
					freeTokens: b.freeTokens ?? 0,
					categories: (b.categories ?? []).map(c => ({ label: c.label, tokens: c.tokens })),
				};
			} catch (e) {
				return { unavailable: e instanceof Error ? e.message : String(e) };
			}
		},
	};

	pi.registerCommand("ompi", {
		description: "ompi desktop bridge (internal)",
		async handler(args, ctx) {
			let req = "";
			try {
				const parsed: unknown = JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8"));
				if (!parsed || typeof parsed !== "object") throw new Error("bridge request must be an object");
				const { req: r, op, ...rest } = parsed as Args;
				req = typeof r === "string" ? r : "";
				const fn = typeof op === "string" ? ops[op] : undefined;
				if (!fn) throw new Error(`unknown bridge op ${String(op)}`);
				ctx.ui.notify("ompi:" + JSON.stringify({ req, ok: true, ...(await fn(rest, ctx)) }), "info");
			} catch (e) {
				ctx.ui.notify("ompi:" + JSON.stringify({ req, ok: false, error: e instanceof Error ? e.message : String(e) }), "error");
			}
		},
	});
}
