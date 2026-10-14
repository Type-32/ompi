<script setup lang="ts">
// Side panel: the session's entry tree laid out like `git log` (a straight chain stays in one
// column, each sibling branch indents one level), plus a context-usage breakdown.
import { useVirtualList } from "@vueuse/core";
import { computed, ref, watch } from "vue";
import type { Session } from "~/composables/useSession";
import type { Entry } from "~/utils/omp/schema";
import { activePath, textOf } from "~/utils/omp/transcript";
import type { ContextBreakdown } from "~/utils/omp/types";

const props = defineProps<{ session: Session }>();
const emit = defineEmits<{ reveal: [entryId: string] }>();
const toast = useToast();

const tab = ref<"graph" | "context">("graph");
const filter = ref<"conversation" | "all">("conversation");

interface Row {
	id: string;
	depth: number;
	icon: string;
	text: string;
	tone: "user" | "assistant" | "tool" | "error" | "event";
	onPath: boolean;
	branches: number;
}

const firstLine = (s: string, n = 90) => {
	const l = s.trim().split("\n")[0] ?? "";
	return l.length > n ? `${l.slice(0, n)}…` : l;
};

function describe(e: Entry): Omit<Row, "id" | "depth" | "onPath" | "branches"> | undefined {
	if (e.type === "message") {
		const m = e.message;
		if (m.role === "user") return { icon: "i-lucide-user", text: firstLine(textOf(m.content)) || "(attachments)", tone: "user" };
		if (m.role === "assistant") {
			const t = firstLine(textOf(m.content));
			const calls = m.content.filter(b => b.type === "toolCall").length;
			return { icon: "i-lucide-sparkles", text: t || (calls ? `${calls} tool call${calls > 1 ? "s" : ""}` : "(thinking)"), tone: m.stopReason === "error" ? "error" : "assistant" };
		}
		if (m.role === "toolResult") {
			if (filter.value === "conversation") return undefined;
			return { icon: m.isError ? "i-lucide-circle-x" : "i-lucide-wrench", text: m.toolName, tone: m.isError ? "error" : "tool" };
		}
		return undefined;
	}
	switch (e.type) {
		case "compaction":
			return { icon: "i-lucide-shrink", text: "Compacted", tone: "event" };
		case "branch_summary":
			return { icon: "i-lucide-git-branch", text: "Branch summary", tone: "event" };
		case "mode_change":
			return { icon: "i-lucide-map", text: e.mode === "plan" ? "Plan mode on" : "Plan mode off", tone: "event" };
		case "model_change":
			return filter.value === "all" ? { icon: "i-lucide-cpu", text: e.model, tone: "event" } : undefined;
		default:
			return undefined;
	}
}

const rows = computed<Row[]>(() => {
	const tree = props.session.tree.value;
	const onPath = new Set(activePath(tree, props.session.leafId.value).map(e => e.id));
	const out: Row[] = [];
	// Iterative DFS; children in file order. Branch points push their later children deeper.
	const stack: { e: Entry; depth: number }[] = [...(tree.children.get(null) ?? [])].reverse().map(e => ({ e, depth: 0 }));
	while (stack.length) {
		const { e, depth } = stack.pop()!;
		const kids = tree.children.get(e.id) ?? [];
		const d = describe(e);
		if (d) out.push({ id: e.id, depth, onPath: onPath.has(e.id), branches: kids.length, ...d });
		// Keep the active child (or the first) in this column; siblings indent.
		const main = kids.find(k => onPath.has(k.id)) ?? kids[0];
		for (const k of [...kids].reverse()) stack.push({ e: k, depth: k === main ? depth : depth + 1 });
	}
	return out;
});

const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(rows, { itemHeight: 28, overscan: 12 });
watch(
	() => props.session.leafId.value,
	id => {
		const i = rows.value.findIndex(r => r.id === id);
		if (i >= 0) scrollTo(Math.max(0, i - 8));
	},
);

async function run(what: string, fn: () => Promise<void>) {
	try {
		await fn();
	} catch (e) {
		toast.add({ title: `Couldn't ${what}`, description: e instanceof Error ? e.message : String(e), color: "error" });
	}
}

function menu(r: Row) {
	const s = props.session;
	const label = s.entryLabels.value.get(r.id);
	return [
		[
			{ label: "Continue from here", icon: "i-lucide-corner-down-right", onSelect: () => void run("move here", () => s.continueFrom(r.id)) },
			{ label: "Fork from here", icon: "i-lucide-git-fork", onSelect: () => void run("fork", () => s.fork(r.id)) },
		],
		...(s.caps.value.label
			? [[{
					label: label ? `Remove label “${label}”` : "Label…",
					icon: "i-lucide-bookmark",
					onSelect: () => {
						if (label) return void run("remove the label", () => s.setLabel(r.id));
						const name = window.prompt("Label this entry");
						if (name?.trim()) void run("add the label", () => s.setLabel(r.id, name.trim()));
					},
				}]]
			: []),
	];
}

function select(r: Row) {
	if (r.onPath) emit("reveal", r.id);
	else void run("switch branch", () => props.session.continueFrom(r.id));
}

const breakdown = ref<ContextBreakdown>();
const loadingCtx = ref(false);
async function loadContext() {
	if (!props.session.caps.value.context || props.session.handle.value === undefined) return;
	loadingCtx.value = true;
	try {
		breakdown.value = await props.session.contextBreakdown();
	} catch (e) {
		toast.add({ title: "Couldn't read context usage", description: String(e), color: "error" });
	} finally {
		loadingCtx.value = false;
	}
}
watch([tab, () => props.session.phase.value], ([t, p]) => t === "context" && p === "idle" && void loadContext(), { immediate: true });

const segments = computed(() => {
	const b = breakdown.value;
	if (!b?.contextWindow) return [];
	const colors = ["bg-primary", "bg-info", "bg-success", "bg-warning", "bg-secondary", "bg-error"];
	return [
		...b.categories.filter(c => c.tokens > 0).map((c, i) => ({ label: c.label, tokens: c.tokens, color: colors[i % colors.length]! })),
		...(b.autoCompactBufferTokens ? [{ label: "Auto-compact buffer", tokens: b.autoCompactBufferTokens, color: "bg-accented" }] : []),
	].map(s => ({ ...s, pct: (s.tokens / b.contextWindow) * 100 }));
});

const compactNote = ref("");
async function compact() {
	const note = compactNote.value.trim();
	compactNote.value = "";
	await run("compact", () => props.session.prompt(note ? `/compact ${note}` : "/compact"));
}
</script>

<template>
	<div class="flex h-full min-h-0 flex-col">
		<div class="flex items-center gap-2 border-b border-default px-3 py-2">
			<UTabs
				v-model="tab"
				:items="[{ label: 'Graph', value: 'graph', icon: 'i-lucide-git-graph' }, { label: 'Context', value: 'context', icon: 'i-lucide-gauge' }]"
				:content="false"
				size="xs"
				variant="link"
			/>
			<USelect v-if="tab === 'graph'" v-model="filter" :items="[{ label: 'Conversation', value: 'conversation' }, { label: 'All', value: 'all' }]" size="xs" class="ms-auto w-32" />
		</div>

		<div v-if="tab === 'graph'" v-bind="containerProps" class="min-h-0 flex-1 overflow-y-auto py-1">
			<div v-bind="wrapperProps">
				<UContextMenu v-for="{ data: r } in list" :key="r.id" :items="menu(r)">
					<button
						type="button"
						class="flex h-7 w-full items-center gap-1.5 pe-2 text-left text-xs hover:bg-elevated"
						:class="r.onPath ? 'text-default' : 'text-dimmed'"
						:style="{ paddingInlineStart: `${8 + r.depth * 14}px` }"
						@click="select(r)"
					>
						<span class="h-full w-0.5 shrink-0 rounded" :class="r.onPath ? 'bg-primary' : 'bg-border'" />
						<UIcon
							:name="r.icon"
							class="size-3.5 shrink-0"
							:class="{ 'text-primary': r.tone === 'user' && r.onPath, 'text-error': r.tone === 'error', 'text-info': r.tone === 'event' }"
						/>
						<span class="min-w-0 flex-1 truncate" :class="{ 'font-medium': r.id === session.leafId.value }">{{ r.text }}</span>
						<UBadge v-if="session.entryLabels.value.get(r.id)" :label="session.entryLabels.value.get(r.id)" size="sm" variant="subtle" class="shrink-0" />
						<span v-if="r.branches > 1" class="flex shrink-0 items-center gap-0.5 text-dimmed"><UIcon name="i-lucide-git-branch" class="size-3" />{{ r.branches }}</span>
					</button>
				</UContextMenu>
			</div>
			<p v-if="!rows.length" class="px-3 py-6 text-center text-sm text-muted">No messages yet.</p>
		</div>

		<div v-else class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
			<template v-if="breakdown && !breakdown.unavailable">
				<div class="flex items-baseline justify-between text-sm">
					<span class="font-medium text-highlighted">{{ breakdown.usedTokens.toLocaleString() }} tokens</span>
					<span class="text-muted">of {{ breakdown.contextWindow.toLocaleString() }}</span>
				</div>
				<div class="flex h-3 overflow-hidden rounded-full bg-elevated">
					<div v-for="s in segments" :key="s.label" :class="s.color" :style="{ width: `${s.pct}%` }" :title="`${s.label}: ${s.tokens.toLocaleString()}`" />
				</div>
				<ul class="flex flex-col gap-1 text-xs">
					<li v-for="s in segments" :key="s.label" class="flex items-center gap-2">
						<span class="size-2.5 rounded-sm" :class="s.color" />
						<span class="flex-1">{{ s.label }}</span>
						<span class="text-muted tabular-nums">{{ s.tokens.toLocaleString() }}</span>
					</li>
					<li class="flex items-center gap-2">
						<span class="size-2.5 rounded-sm bg-elevated ring-1 ring-default" />
						<span class="flex-1">Free</span>
						<span class="text-muted tabular-nums">{{ breakdown.freeTokens.toLocaleString() }}</span>
					</li>
				</ul>
			</template>
			<UAlert v-else-if="breakdown?.unavailable" color="neutral" variant="subtle" :description="`Detailed breakdown unavailable: ${breakdown.unavailable}`" />
			<USkeleton v-else-if="loadingCtx" class="h-24 w-full" />

			<div class="flex flex-col gap-2 border-t border-default pt-3">
				<p class="text-sm font-medium text-highlighted">Compact</p>
				<UInput v-model="compactNote" placeholder="What to keep (optional)" size="sm" @keydown.enter="compact" />
				<UButton label="Compact now" icon="i-lucide-shrink" size="sm" color="neutral" variant="outline" :disabled="session.streaming.value" @click="compact" />
			</div>
		</div>
	</div>
</template>
