// One live omp session: transcript (persisted entries + streaming overlay), dialogs, state,
// commands, and bridge operations. The tab registry caches one per session tab.
import { computed, ref, shallowRef, triggerRef } from "vue";
import type { ComputedRef, Ref, ShallowRef } from "vue";
import { z } from "zod";
import { stripAnsi } from "~/utils/ansi";
import { parseFrame } from "~/utils/omp/frames";
import type { Frame } from "~/utils/omp/frames";
import { host } from "~/utils/omp/host";
import { applyFrame, emptyLive } from "~/utils/omp/live";
import type { LiveTurn } from "~/utils/omp/live";
import { BridgeReply, EntriesPage, Model, SessionState, SlashCommand, parseEntries } from "~/utils/omp/schema";
import type { Dialog, Entry, ImageBlock } from "~/utils/omp/schema";
import { activePath, buildItems, buildTree, labels, newestLeaf, planModeOnPath } from "~/utils/omp/transcript";
import type { Item, Tree } from "~/utils/omp/transcript";
import type { BridgeCapabilities, ContextBreakdown, HostStatus, Phase, Scope } from "~/utils/omp/types";

export interface SessionTarget {
	cwd: string;
	workspaceId: string;
	/** Existing session file to resume; absent for a new session. */
	file?: string;
	/** `provider/model` for a new session. Resumed sessions keep their own model. */
	model?: string;
	extraDirs?: string[];
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	text: string;
}

export interface PendingPlan {
	planFilePath: string;
	title?: string;
}

export type ApproveMode = "here" | "compact" | "new";

export interface Session {
	readonly target: SessionTarget;
	handle: Ref<number | undefined>;
	phase: Ref<Phase>;
	exit: Ref<string | undefined>;
	sessionFile: Ref<string | undefined>;
	state: ShallowRef<SessionState | undefined>;
	entries: ShallowRef<Entry[]>;
	tree: ComputedRef<Tree>;
	leafId: Ref<string | null>;
	items: ComputedRef<Item[]>;
	entryLabels: ComputedRef<Map<string, string>>;
	live: ShallowRef<LiveTurn>;
	streaming: ComputedRef<boolean>;
	dialogs: Ref<Dialog[]>;
	statusChips: Ref<Record<string, string>>;
	widgets: Ref<Record<string, string[]>>;
	notices: Ref<Notice[]>;
	commandOutput: Ref<{ id: number; text: string }[]>;
	commands: ShallowRef<SlashCommand[]>;
	caps: Ref<BridgeCapabilities>;
	planning: Ref<boolean>;
	planFilePath: Ref<string | undefined>;
	pendingPlan: Ref<PendingPlan | undefined>;
	retry: Ref<string | undefined>;
	compacting: Ref<boolean>;
	scope: Ref<Scope>;

	start(): Promise<void>;
	/** Start the process unless it's running or starting. Resumes a session the idle reaper stopped. */
	ensureRunning(): Promise<void>;
	stop(): Promise<void>;
	onStatus(s: HostStatus): void;
	/** Send a prompt; while streaming it steers the active turn. Slash commands go through here too. */
	prompt(message: string, images?: ImageBlock[]): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	answer(dialog: Dialog, response: object): Promise<void>;
	setScope(scope: Scope): Promise<void>;
	setPlanning(on: boolean, planFilePath?: string): Promise<void>;
	readPendingPlan(): Promise<string>;
	approvePlan(mode: ApproveMode): Promise<void>;
	/**
	 * Move the session's current position within this file (omp `navigateTree`).
	 * Targeting a user message rewinds to just before it, ready for a resend; any other entry
	 * lands on the newest point of its subtree.
	 */
	goto(entryId: string): Promise<void>;
	/** Continue the conversation right after `entryId` (after a user message, its reply branch is dropped). */
	continueFrom(entryId: string): Promise<void>;
	/** Switch to sibling `id`'s branch, landing at the newest entry in it. */
	switchBranch(id: string): Promise<void>;
	editUser(entryId: string, text: string, images?: ImageBlock[]): Promise<void>;
	editAssistant(entryId: string, texts: string[]): Promise<void>;
	fork(entryId?: string): Promise<void>;
	setLabel(entryId: string, label?: string): Promise<void>;
	contextBreakdown(): Promise<ContextBreakdown>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinking(level: string): Promise<void>;
	thinkingLevels(): Promise<string[]>;
	models(): Promise<Model[]>;
	removeQueued(message: string, queue: "steering" | "followUp"): Promise<void>;
	reloadEntries(): Promise<void>;
}

const PlanReply = z.object({ plan: z.object({ enabled: z.boolean(), planFilePath: z.string().optional() }) });
const Hello = PlanReply.extend({
	capabilities: z.object({ plan: z.boolean(), goto: z.boolean(), editAssistant: z.boolean(), label: z.boolean(), context: z.boolean() }),
});
const Breakdown = z.object({
	contextWindow: z.number().catch(0),
	usedTokens: z.number().catch(0),
	autoCompactBufferTokens: z.number().catch(0),
	freeTokens: z.number().catch(0),
	categories: z.array(z.object({ label: z.string(), tokens: z.number() })).catch([]),
	unavailable: z.string().optional(),
});
/** `write xd://propose` result: omp wraps the device's own result in `details.xdev.inner`. */
const ProposeDetails = z.object({
	xdev: z.object({
		tool: z.literal("propose"),
		inner: z.object({ planFilePath: z.string(), title: z.string().optional() }),
	}),
});

/** Plan slug from `local://<slug>-plan.md`. */
export const planSlug = (planFilePath: string): string | undefined => /^local:\/\/(.+)-plan\.md$/.exec(planFilePath)?.[1];

const NOTICE_LIMIT = 6;
const BRIDGE_TIMEOUT_MS = 30_000;
let bridgeSeq = 0;

/** `key` must be stable for the tab across webview reloads: the Rust host reattaches by it. */
export function createSession(target: SessionTarget, initialScope: Scope, key: string): Session {
	const handle = ref<number>();
	const phase = ref<Phase>("starting");
	const exit = ref<string>();
	const sessionFile = ref(target.file);
	const state = shallowRef<SessionState>();
	const entries = shallowRef<Entry[]>([]);
	const leafId = ref<string | null>(null);
	const live = shallowRef<LiveTurn>(emptyLive());
	const dialogs = ref<Dialog[]>([]);
	const statusChips = ref<Record<string, string>>({});
	const widgets = ref<Record<string, string[]>>({});
	const notices = ref<Notice[]>([]);
	const commandOutput = ref<{ id: number; text: string }[]>([]);
	const commands = shallowRef<SlashCommand[]>([]);
	const caps = ref<BridgeCapabilities>({ plan: false, goto: false, editAssistant: false, label: false, context: false });
	const planning = ref(false);
	const planFilePath = ref<string>();
	const pendingPlan = ref<PendingPlan>();
	const retry = ref<string>();
	const compacting = ref(false);
	const scope = ref<Scope>(initialScope);
	// One overlay file per process (rewriting it changes approval behaviour live), keyed by tab.
	const runKey = key;

	const bridgeWaiters = new Map<string, (r: z.infer<typeof BridgeReply>) => void>();
	let seq = 0;
	let startPromise: Promise<void> | undefined;

	const tree = computed(() => buildTree(entries.value));
	const items = computed(() => buildItems(tree.value, leafId.value));
	const entryLabels = computed(() => labels(entries.value));
	const streaming = computed(() => phase.value === "streaming");

	const notify = (level: Notice["level"], text: string) => {
		notices.value = [...notices.value.slice(-(NOTICE_LIMIT - 1)), { id: ++seq, level, text }];
	};

	const need = (): number => {
		if (handle.value === undefined) throw new Error("This session isn't running.");
		return handle.value;
	};

	async function reloadEntries(): Promise<void> {
		const page = await host.request(need(), { type: "get_entries" }, EntriesPage);
		entries.value = parseEntries(page.entries);
		leafId.value = page.leafId;
	}

	/** Append only what's new; fall back to a full reload when the cursor entry is gone.
	 *  `turn_end` and `agent_end` both sync, so calls are chained: two in flight would both
	 *  fetch from the same cursor and append the same entries twice. */
	let syncChain: Promise<void> = Promise.resolve();
	function syncEntries(): Promise<void> {
		syncChain = syncChain.then(async () => {
			const last = entries.value.at(-1)?.id;
			if (!last) return reloadEntries();
			try {
				const page = await host.request(need(), { type: "get_entries", since: last }, EntriesPage);
				const known = new Set(entries.value.map(e => e.id));
				const fresh = parseEntries(page.entries).filter(e => !known.has(e.id));
				if (fresh.length) entries.value = [...entries.value, ...fresh];
				leafId.value = page.leafId;
			} catch {
				await reloadEntries();
			}
		}, () => undefined);
		return syncChain;
	}

	async function refreshState(): Promise<void> {
		state.value = await host.request(need(), { type: "get_state" }, SessionState);
		if (state.value.sessionFile) sessionFile.value = state.value.sessionFile;
	}

	async function onFrame(raw: unknown): Promise<void> {
		const f = parseFrame(raw);
		if (applyFrame(live.value, f)) {
			triggerRef(live);
			// Like the TUI: a submitted plan ends the turn so the model can't keep going (or
			// re-propose in a loop) while the review is open.
			if (f.type === "tool_execution_end" && planning.value && !f.isError) {
				const d = ProposeDetails.safeParse(f.result.details);
				if (d.success) {
					pendingPlan.value = d.data.xdev.inner;
					void abort().catch(() => undefined);
				}
			}
			return;
		}
		switch (f.type) {
			case "agent_start":
				phase.value = "streaming";
				live.value = emptyLive();
				return;
			case "turn_end":
				await syncEntries();
				live.value = emptyLive();
				return;
			case "agent_end":
				if (f.isTerminal === false) return;
				phase.value = "idle";
				await syncEntries();
				live.value = emptyLive();
				await refreshState();
				detectProposedPlan();
				return;
			case "dialog":
				if (!dialogs.value.some(d => d.id === f.id)) dialogs.value = [...dialogs.value, f];
				return;
			case "ui":
				return onUi(f);
			case "command_output":
				commandOutput.value = [...commandOutput.value, { id: ++seq, text: stripAnsi(f.text) }];
				return;
			case "available_commands_update":
				commands.value = f.commands;
				return;
			case "session_info_update":
				if (state.value) state.value = { ...state.value, sessionName: f.title };
				return;
			case "config_update":
			case "model_changed":
			case "thinking_level_changed":
				return refreshState();
			case "notice":
				// omp's info notices are mostly MCP mount chatter; surface our own and real problems.
				if (f.source === "ompi" || f.level !== "info") notify(f.level, f.message);
				return;
			case "auto_compaction_start":
				compacting.value = true;
				return;
			case "auto_compaction_end":
				compacting.value = false;
				if (f.errorMessage) notify("error", `Compaction failed: ${f.errorMessage}`);
				return reloadEntries();
			case "auto_retry_start":
				retry.value = `Retrying (${f.attempt}/${f.maxAttempts}) in ${Math.round(f.delayMs / 1000)} s: ${f.errorMessage}`;
				return;
			case "auto_retry_end":
				retry.value = undefined;
				return;
		}
	}

	function onUi(f: Extract<Frame, { type: "ui" }>): void {
		switch (f.method) {
			case "cancel":
				dialogs.value = dialogs.value.filter(d => d.id !== f.targetId);
				return;
			case "notify": {
				if (!f.message.startsWith("ompi:")) return notify(f.notifyType ?? "info", f.message);
				const reply = BridgeReply.safeParse(JSON.parse(f.message.slice(5)));
				if (reply.success) bridgeWaiters.get(reply.data.req)?.(reply.data);
				return;
			}
			case "setStatus": {
				const next = { ...statusChips.value };
				if (f.statusText) next[f.statusKey] = stripAnsi(f.statusText);
				else delete next[f.statusKey];
				statusChips.value = next;
				return;
			}
			case "setWidget": {
				const next = { ...widgets.value };
				if (f.widgetLines?.length) next[f.widgetKey] = f.widgetLines.map(stripAnsi);
				else delete next[f.widgetKey];
				widgets.value = next;
				return;
			}
			case "open_url":
				notify("info", f.instructions ?? `Open ${f.launchUrl ?? f.url} to continue.`);
				return;
		}
	}

	/** Run a bridge op; its reply arrives as a notify frame correlated by `req`. */
	async function bridge<T>(op: string, args: object, schema: z.ZodType<T>): Promise<T> {
		const req = `r${++bridgeSeq}`;
		const bytes = new TextEncoder().encode(JSON.stringify({ req, op, ...args }));
		const payload = btoa(String.fromCodePoint(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
		const { promise: reply, resolve, reject } = Promise.withResolvers<z.infer<typeof BridgeReply>>();
		const timer = setTimeout(() => {
			bridgeWaiters.delete(req);
			reject(new Error(`omp didn't answer the ${op} request.`));
		}, BRIDGE_TIMEOUT_MS);
		bridgeWaiters.set(req, r => {
			clearTimeout(timer);
			bridgeWaiters.delete(req);
			resolve(r);
		});
		await host.request(need(), { type: "prompt", message: `/ompi ${payload}` });
		const r = await reply;
		if (!r.ok) throw new Error(r.error ?? `${op} failed`);
		return schema.parse(r);
	}

	function applyPlanState(p: { enabled: boolean; planFilePath?: string }): void {
		planning.value = p.enabled;
		planFilePath.value = p.planFilePath;
		if (!p.enabled) pendingPlan.value = undefined;
	}

	async function setPlanning(on: boolean, path?: string): Promise<void> {
		const r = on ? await bridge("plan.enter", path ? { planFilePath: path } : {}, PlanReply) : await bridge("plan.exit", {}, PlanReply);
		applyPlanState(r.plan);
		// omp's plan guard only blocks write/edit, so executable tools are clamped while planning.
		await host.setScope(runKey, scope.value, r.plan.enabled);
		await syncEntries();
	}

	/** After a planning turn, the newest `xd://propose` result since the last user message is the plan to review. */
	function detectProposedPlan(): void {
		if (!planning.value) return;
		const path = activePath(tree.value, leafId.value);
		for (let i = path.length - 1; i >= 0; i--) {
			const e = path[i]!;
			if (e.type !== "message") continue;
			if (e.message.role === "user") return;
			if (e.message.role !== "toolResult" || e.message.isError) continue;
			const d = ProposeDetails.safeParse(e.message.details);
			if (d.success) {
				pendingPlan.value = d.data.xdev.inner;
				return;
			}
		}
	}

	async function readPendingPlan(): Promise<string> {
		const p = pendingPlan.value;
		const slug = p && planSlug(p.planFilePath);
		if (!slug || !sessionFile.value) throw new Error("No plan is waiting for review.");
		return host.readPlan(sessionFile.value, slug);
	}

	async function prompt(message: string, images?: ImageBlock[]): Promise<void> {
		if (!message.trim() && !images?.length) return;
		await host.request(need(), {
			type: "prompt",
			message,
			...(images?.length ? { images } : {}),
			...(streaming.value ? { streamingBehavior: "steer" } : {}),
		});
	}

	async function approvePlan(mode: ApproveMode): Promise<void> {
		const p = pendingPlan.value;
		if (!p) return;
		const planText = await readPendingPlan();
		await bridge("plan.approve", { planFilePath: p.planFilePath }, PlanReply);
		applyPlanState({ enabled: false });
		await host.setScope(runKey, scope.value, false);
		if (mode === "new") {
			await host.request(need(), { type: "new_session" });
			await host.refreshFile(need());
			await Promise.all([reloadEntries(), refreshState()]);
			return prompt(`Implement this approved plan:\n\n${planText}`);
		}
		if (mode === "compact") {
			const title = p.title ?? "the plan";
			await host.request(need(), { type: "compact", customInstructions: `Keep what's needed to implement the approved plan "${title}".` });
		}
		await syncEntries();
		await prompt("Implement the approved plan.");
	}

	async function abort(): Promise<void> {
		await host.request(need(), { type: "abort" });
	}

	async function goto(entryId: string): Promise<void> {
		await bridge("goto", { entryId }, z.object({ cancelled: z.boolean() }));
		await reloadEntries();
	}

	async function start(): Promise<void> {
		phase.value = "starting";
		exit.value = undefined;
		try {
			const h = await host.open({
				cwd: target.cwd,
				resume: sessionFile.value,
				model: sessionFile.value ? undefined : target.model,
				extraDirs: target.extraDirs,
				workspaceId: target.workspaceId,
				runKey,
				scope: scope.value,
				planning: false,
			});
			handle.value = h;
			await host.attach(h, raw => void onFrame(raw).catch((e: unknown) => notify("error", String(e))));
			await Promise.all([reloadEntries(), refreshState()]);
			const hello = await bridge("hello", {}, Hello);
			caps.value = hello.capabilities;
			// Restore plan mode from the session's own history; this also picks up plans started in the TUI.
			const onPath = planModeOnPath(tree.value, leafId.value);
			if (caps.value.plan && onPath.enabled && !hello.plan.enabled) await setPlanning(true, onPath.planFilePath);
			else applyPlanState(hello.plan);
			commands.value = (await host.request(h, { type: "get_available_commands" }, z.object({ commands: z.array(SlashCommand) }))).commands;
			phase.value = "idle";
		} catch (e) {
			phase.value = "exited";
			exit.value = e instanceof Error ? e.message : String(e);
		}
	}

	return {
		target,
		handle,
		phase,
		exit,
		sessionFile,
		state,
		entries,
		tree,
		leafId,
		items,
		entryLabels,
		live,
		streaming,
		dialogs,
		statusChips,
		widgets,
		notices,
		commandOutput,
		commands,
		caps,
		planning,
		planFilePath,
		pendingPlan,
		retry,
		compacting,
		scope,

		start,
		ensureRunning() {
			if (handle.value !== undefined || startPromise) return startPromise ?? Promise.resolve();
			startPromise = start().finally(() => {
				startPromise = undefined;
			});
			return startPromise;
		},
		async stop() {
			if (handle.value !== undefined) await host.close(handle.value);
			handle.value = undefined;
			phase.value = "exited";
		},
		onStatus(s) {
			if (s.handle !== handle.value) return;
			if (s.sessionFile) sessionFile.value = s.sessionFile;
			if (s.phase === "exited") {
				// The process is gone either way; a reaped session restarts on the next ensureRunning().
				handle.value = undefined;
				live.value = emptyLive();
				dialogs.value = [];
				phase.value = "exited";
				exit.value = s.exit === "stopped while idle" ? undefined : (s.exit ?? undefined);
			}
		},
		prompt,
		async followUp(message) {
			await host.request(need(), { type: "follow_up", message });
		},
		abort,
		answer(dialog, response) {
			dialogs.value = dialogs.value.filter(d => d.id !== dialog.id);
			return host.send(need(), { type: "extension_ui_response", id: dialog.id, ...response });
		},
		async setScope(next) {
			scope.value = next;
			await host.setScope(runKey, next, planning.value);
		},
		setPlanning,
		readPendingPlan,
		approvePlan,
		goto,
		async continueFrom(entryId) {
			const e = tree.value.byId.get(entryId);
			if (!e) return;
			if (e.type !== "message" || e.message.role !== "user") return goto(entryId);
			// navigateTree rewinds *before* a user message. To continue after one, walk down its
			// first-child chain to the end of that exchange (the reply) and land there.
			let cur: Entry = e;
			for (let next = tree.value.children.get(cur.id)?.[0]; next; next = tree.value.children.get(cur.id)?.[0]) {
				if (next.type === "message" && next.message.role === "user") break;
				cur = next;
			}
			if (cur === e) throw new Error("This message has no reply to continue from yet.");
			await goto(cur.id);
		},
		async switchBranch(id) {
			const e = tree.value.byId.get(id);
			const isUser = e?.type === "message" && e.message.role === "user";
			const leaf = newestLeaf(tree.value, id);
			// A user message with no reply yet would be rewound past by navigateTree; nothing to switch to.
			if (isUser && leaf === id) throw new Error("That branch has no reply yet.");
			await goto(leaf);
		},
		async editUser(entryId, text, images) {
			if (!tree.value.byId.has(entryId)) return;
			if (streaming.value) await abort();
			// navigateTree on a user message rewinds to just before it; the resend becomes its sibling.
			await goto(entryId);
			await prompt(text, images);
		},
		async editAssistant(entryId, texts) {
			if (streaming.value) await abort();
			await bridge("editAssistant", { entryId, texts }, z.object({ entryId: z.string() }));
			await reloadEntries();
		},
		async fork(entryId) {
			await host.request(need(), { type: "fork", ...(entryId ? { entryId } : {}) });
			await host.refreshFile(need());
			await Promise.all([reloadEntries(), refreshState()]);
		},
		async setLabel(entryId, label) {
			await bridge("label", { entryId, ...(label ? { label } : {}) }, z.object({}));
			await syncEntries();
		},
		contextBreakdown: () => bridge("context", {}, Breakdown),
		async setModel(provider, modelId) {
			await host.request(need(), { type: "set_model", provider, modelId });
			await refreshState();
		},
		async setThinking(level) {
			await host.request(need(), { type: "set_thinking_level", level });
			await refreshState();
		},
		async thinkingLevels() {
			return (await host.request(need(), { type: "get_available_thinking_levels" }, z.object({ levels: z.array(z.string()) }))).levels;
		},
		async models() {
			const r = await host.request(need(), { type: "get_available_models" }, z.object({ models: z.array(z.unknown()) }));
			return r.models.flatMap(m => {
				const p = Model.safeParse(m);
				return p.success ? [p.data] : [];
			});
		},
		async removeQueued(message, queue) {
			await host.request(need(), { type: "remove_queued_message", message, queue });
			await refreshState();
		},
		reloadEntries,
	};
}
