<script setup lang="ts">
import { computed } from "vue";
import type { Dialog } from "~/utils/omp/schema";
import type { ToolView } from "~/utils/omp/transcript";

const props = defineProps<{ call: ToolView; approval?: Extract<Dialog, { method: "select" }>; streaming?: boolean }>();
const emit = defineEmits<{ approve: []; deny: []; alwaysAllow: [] }>();

const ICONS: Record<string, string> = {
	bash: "i-lucide-square-terminal",
	read: "i-lucide-file-text",
	write: "i-lucide-file-plus",
	edit: "i-lucide-file-pen",
	grep: "i-lucide-text-search",
	glob: "i-lucide-folder-search",
	find: "i-lucide-search-code",
	task: "i-lucide-users",
	todo: "i-lucide-list-checks",
	web_search: "i-lucide-globe",
	browser: "i-lucide-app-window",
	eval: "i-lucide-code",
	ask: "i-lucide-message-circle-question",
	lsp: "i-lucide-braces",
};

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const args = computed(() => props.call.args);

const subject = computed(() => {
	const a = args.value;
	return str(a.command) ?? str(a.path) ?? str(a.pattern) ?? str(a.query) ?? str(a.url) ?? props.call.intent ?? "";
});

const output = computed(() => {
	const r = props.call.result;
	if (!r) return "";
	return r.content.map(b => (b.type === "text" ? b.text : "")).join("");
});

const diff = computed(() => str(props.call.result?.details?.diff));
const diffLines = computed(() =>
	(diff.value ?? "").split("\n").map(l => ({ text: l, kind: /^\s*-\d+\|/.test(l) ? "del" : /^\s*\+\d+\|/.test(l) ? "add" : "ctx" })),
);

const label = computed(() => {
	const name = props.call.name;
	if (props.call.status === "running") return props.approval ? `Waiting for approval: ${name}` : `Running ${name}`;
	return props.call.status === "error" ? `${name} failed` : name;
});

const actions = computed(() =>
	props.approval
		? [
				{ label: "Approve", icon: "i-lucide-check", color: "primary" as const, onClick: () => emit("approve") },
				{ label: "Deny", icon: "i-lucide-x", color: "neutral" as const, variant: "outline" as const, onClick: () => emit("deny") },
				{ label: `Always allow ${props.call.name} here`, color: "neutral" as const, variant: "ghost" as const, onClick: () => emit("alwaysAllow") },
			]
		: undefined,
);
</script>

<template>
	<UChatTool
		:text="label"
		:suffix="subject"
		:icon="ICONS[call.name] ?? 'i-lucide-wrench'"
		:loading="call.status === 'running' && !approval"
		:streaming="streaming && call.status === 'running'"
		:default-open="!!approval || call.status === 'error'"
		:actions="actions"
		variant="card"
		:ui="{ suffix: 'truncate font-mono text-xs', root: call.status === 'error' ? 'ring-1 ring-error/40' : approval ? 'ring-1 ring-warning/60' : '' }"
	>
		<div class="flex max-h-96 flex-col gap-2 overflow-auto text-xs">
			<pre v-if="approval" class="rounded bg-warning/10 p-2 whitespace-pre-wrap text-default">{{ approval.title.replace(/^Allow tool: \S+\n?/, '') }}</pre>
			<pre v-if="call.name === 'bash' && str(args.command)" class="rounded bg-elevated p-2 font-mono whitespace-pre-wrap">$ {{ args.command }}</pre>
			<div v-if="diff" class="overflow-x-auto rounded border border-default font-mono">
				<div
					v-for="(l, i) in diffLines"
					:key="i"
					class="px-2 whitespace-pre"
					:class="l.kind === 'add' ? 'bg-success/10 text-success' : l.kind === 'del' ? 'bg-error/10 text-error' : 'text-muted'"
				>{{ l.text }}</div>
			</div>
			<pre v-else-if="call.name === 'write' && str(args.content)" class="rounded bg-elevated p-2 font-mono whitespace-pre-wrap">{{ args.content }}</pre>
			<pre v-if="output && !diff" class="rounded bg-elevated p-2 font-mono whitespace-pre-wrap" :class="{ 'text-error': call.status === 'error' }">{{ output }}</pre>
			<details v-if="!['bash', 'write', 'edit'].includes(call.name)" class="text-muted">
				<summary class="cursor-pointer">Arguments</summary>
				<pre class="mt-1 rounded bg-elevated p-2 font-mono whitespace-pre-wrap">{{ JSON.stringify(args, null, 2) }}</pre>
			</details>
		</div>
	</UChatTool>
</template>
