<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { Tab } from "~/composables/useTabs";
import type { Dialog } from "~/utils/omp/schema";
import { host } from "~/utils/omp/host";

const props = defineProps<{ tab: Tab }>();
const tabs = useTabs();
const ws = useWorkspaces();
const ui = useUi();
const toast = useToast();

// Resolved once: a kept-alive view can outlive its tab's entry in the store (closing a tab
// removes the session before KeepAlive drops the view), so it must never re-look it up.
const resolved = tabs.sessionOf(props.tab.id);
if (!resolved) throw new Error(`No session for tab ${props.tab.id}`);
const session = computed(() => resolved);
const modelsOpen = ref(false);
watch(() => ui.modelPickerRequest.value, () => tabs.activeId.value === props.tab.id && (modelsOpen.value = true));

// Kept-alive background tabs stay mounted, so each shortcut checks this is the active tab.
const ifActive = (handler: () => unknown) => ({ usingInput: true, handler: () => tabs.activeId.value === props.tab.id && handler() });
defineShortcuts({
	meta_m: ifActive(() => (modelsOpen.value = true)),
	meta_shift_p: ifActive(() => session.value.caps.value.plan && !session.value.streaming.value && void session.value.setPlanning(!session.value.planning.value)),
});

/** Tool approvals attach to the newest running call of the same tool (omp sends no call id). */
const approvals = computed(() => {
	const out = new Map<string, Extract<Dialog, { method: "select" }>>();
	const running = [...session.value.live.value.tools.values()].filter(t => t.status === "running");
	for (const d of session.value.dialogs.value) {
		if (d.method !== "select") continue;
		const tool = /^Allow tool: (\S+)/.exec(d.title)?.[1];
		const call = tool && [...running].reverse().find(t => t.name === tool && !out.has(t.id));
		if (call) out.set(call.id, d);
	}
	return out;
});

const approvalIds = computed(() => new Set([...approvals.value.values()].map(d => d.id)));
const looseDialogs = computed(() => session.value.dialogs.value.filter(d => !approvalIds.value.has(d.id)));

async function approve(d: Dialog, value: string) {
	await session.value.answer(d, { value });
}

async function alwaysAllow(d: Dialog, tool: string) {
	const w = ws.byPath(session.value.target.cwd);
	if (w) {
		const rules = { ...(w.prefs.rules ?? {}), [tool]: "allow" as const };
		await ws.setPrefs(w.path, { rules });
		await host.setWorkspaceRules(w.id, rules);
	}
	await session.value.answer(d, { value: "Approve" });
	toast.add({ title: `${tool} is always allowed in ${w?.name ?? "this workspace"}`, icon: "i-lucide-shield-check" });
}

async function onTuiCommand(name: string, args: string) {
	const s = session.value;
	const w = ws.byPath(s.target.cwd);
	switch (name) {
		case "plan":
			if (!s.caps.value.plan) return toast.add({ title: "Plan mode isn't available with this omp version", color: "warning" });
			if (!s.planning.value) await s.setPlanning(true);
			else if (!args) await s.setPlanning(false);
			if (args) await s.prompt(args);
			return;
		case "new":
			if (w) await newSessionIn(w);
			return;
		case "fork":
			return s.fork();
		case "tree":
		case "branch":
		case "rewind":
			ui.sidePanelOpen.value = true;
			return;
		case "queue":
			if (args) await s.followUp(args);
			return;
		case "resume":
			ui.paletteOpen.value = true;
			return;
		case "settings":
		case "hotkeys":
			tabs.open({ kind: "settings" });
			return;
		case "quit":
		case "exit":
		case "q":
			return tabs.close(props.tab.id);
		default:
			toast.add({ title: `/${name} only works in the omp terminal UI`, description: "It wasn't sent to the model.", icon: "i-lucide-terminal", color: "neutral" });
	}
}

function reveal(entryId: string) {
	void nextTick(() => document.getElementById(`entry-${entryId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

const chatStatus = computed(() => (session.value.streaming.value ? "streaming" : "ready"));
const liveParts = computed(() => session.value.live.value.messages.flatMap(m => m.parts));

watch(
	() => session.value.notices.value.at(-1),
	n => n && toast.add({ title: n.text, color: n.level === "error" ? "error" : n.level === "warning" ? "warning" : "neutral" }),
);
watch(
	() => session.value.commandOutput.value.at(-1),
	() => nextTick(() => document.getElementById(`cmd-out-${props.tab.id}`)?.scrollIntoView({ block: "end" })),
);
</script>

<template>
	<div class="flex h-full min-h-0">
		<div class="flex min-w-0 flex-1 flex-col">
			<UAlert
				v-if="session.phase.value === 'exited' && session.exit.value"
				color="error"
				variant="subtle"
				icon="i-lucide-circle-alert"
				title="omp stopped"
				class="m-3"
				:actions="[{ label: 'Restart', icon: 'i-lucide-rotate-ccw', onClick: () => session.ensureRunning() }]"
			>
				<template #description><pre class="max-h-40 overflow-auto text-xs whitespace-pre-wrap">{{ session.exit.value }}</pre></template>
			</UAlert>

			<div class="min-h-0 flex-1 overflow-y-auto">
				<div class="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
					<div v-if="session.phase.value === 'starting'" class="flex flex-col gap-3">
						<USkeleton class="h-10 w-2/3 self-end" />
						<USkeleton class="h-24 w-full" />
					</div>
					<p v-else-if="!session.items.value.length && !liveParts.length" class="py-16 text-center text-muted">
						{{ session.planning.value ? "Plan mode is on. Describe what to plan." : "Start by asking omp to do something in " + session.target.cwd.split("/").at(-1) + "." }}
					</p>

					<MessageItem
						v-for="item in session.items.value"
						:key="item.kind === 'event' ? `ev-${item.entryId}` : item.entryId"
						:session="session"
						:item="item"
						:approvals="approvals"
						@approve="approve"
						@always-allow="alwaysAllow"
					/>

					<div v-if="liveParts.length" class="flex flex-col gap-2">
						<template v-for="(p, i) in liveParts" :key="i">
							<UChatReasoning v-if="p.kind === 'thinking'" :text="p.text" streaming>
								<p class="text-sm whitespace-pre-wrap text-muted">{{ p.text }}</p>
							</UChatReasoning>
							<OmpMarkdown v-else-if="p.kind === 'text'" :value="p.text" streaming />
							<ToolCard
								v-else-if="p.kind === 'tool'"
								:call="p.call"
								:approval="approvals.get(p.call.id)"
								streaming
								@approve="approve(approvals.get(p.call.id)!, 'Approve')"
								@deny="approve(approvals.get(p.call.id)!, 'Deny')"
								@always-allow="alwaysAllow(approvals.get(p.call.id)!, p.call.name)"
							/>
						</template>
					</div>
					<UChatShimmer v-if="session.streaming.value && !liveParts.length" text="Thinking…" class="text-sm" />

					<div v-for="c in session.commandOutput.value.slice(-3)" :id="`cmd-out-${tab.id}`" :key="c.id" class="rounded-lg border border-default bg-elevated/50 p-3">
						<pre class="overflow-x-auto font-mono text-xs whitespace-pre text-default">{{ c.text }}</pre>
					</div>

					<UAlert v-if="session.retry.value" color="warning" variant="subtle" icon="i-lucide-refresh-cw" :description="session.retry.value" />
					<UAlert v-if="session.compacting.value" color="info" variant="subtle" icon="i-lucide-shrink" description="Compacting context…" />

					<SessionDialogs v-for="d in looseDialogs" :key="d.id" :session="session" :dialog="d" />
					<PlanReview v-if="session.pendingPlan.value" :session="session" />

					<div v-for="(lines, k) in session.widgets.value" :key="k" class="rounded-md bg-elevated/50 px-3 py-2 font-mono text-xs text-muted">
						<div v-for="(l, i) in lines" :key="i">{{ l }}</div>
					</div>
				</div>
			</div>

			<div class="mx-auto w-full max-w-3xl px-6 pb-4">
				<Composer :session="session" @open-models="modelsOpen = true" @tui-command="onTuiCommand" />
			</div>
		</div>

		<aside v-if="ui.sidePanelOpen.value" class="w-80 shrink-0 border-l border-default bg-elevated/30">
			<ContextPanel :session="session" @reveal="reveal" />
		</aside>

		<ModelPicker v-model:open="modelsOpen" :session="session" />
		<span class="hidden">{{ chatStatus }}</span>
	</div>
</template>
