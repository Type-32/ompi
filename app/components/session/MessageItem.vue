<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { computed, nextTick, ref, useTemplateRef } from "vue";
import type { Session } from "~/composables/useSession";
import type { Dialog } from "~/utils/omp/schema";
import type { Item, Part } from "~/utils/omp/transcript";

const props = defineProps<{ session: Session; item: Item; approvals: Map<string, Extract<Dialog, { method: "select" }>> }>();
const emit = defineEmits<{ approve: [d: Dialog, value: string]; alwaysAllow: [d: Dialog, tool: string] }>();
const toast = useToast();

const editing = ref(false);
const draft = ref<string[]>([]);
const editor = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }[]>("editor");

const textParts = computed(() => (props.item.kind === "assistant" ? props.item.parts.filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text") : []));
const label = computed(() => (props.item.kind !== "event" ? props.session.entryLabels.value.get(props.item.entryId) : undefined));
const canEdit = computed(() => props.item.kind === "user" || (props.item.kind === "assistant" && textParts.value.length > 0 && props.session.caps.value.editAssistant));

async function startEdit() {
	if (props.item.kind === "user") draft.value = [props.item.text];
	else if (props.item.kind === "assistant") draft.value = textParts.value.map(p => p.text);
	editing.value = true;
	await nextTick();
	editor.value?.[0]?.textareaRef?.focus();
}

async function run(what: string, fn: () => Promise<void>) {
	try {
		await fn();
	} catch (e) {
		toast.add({ title: `Couldn't ${what}`, description: e instanceof Error ? e.message : String(e), color: "error" });
	}
}

async function saveEdit() {
	const item = props.item;
	editing.value = false;
	if (item.kind === "user") {
		const files = item.files.map(f => (/\s/.test(f) ? `@"${f}"` : `@${f}`)).join(" ");
		const text = [draft.value[0] ?? "", files].filter(Boolean).join("\n\n");
		await run("resend the message", () => props.session.editUser(item.entryId, text, item.images));
	} else if (item.kind === "assistant") {
		await run("edit the message", () => props.session.editAssistant(item.entryId, draft.value));
	}
}

const copyText = computed(() => (props.item.kind === "user" ? props.item.text : textParts.value.map(p => p.text).join("\n\n")));

const menu = computed<DropdownMenuItem[][]>(() => {
	const item = props.item;
	if (item.kind === "event") return [];
	const s = props.session;
	return [
		[
			{ label: "Copy", icon: "i-lucide-copy", onSelect: () => void writeText(copyText.value) },
			...(canEdit.value ? [{ label: item.kind === "user" ? "Edit & resend" : "Edit", icon: "i-lucide-pencil", onSelect: () => void startEdit() }] : []),
			...(item.kind === "user" ? [{ label: "Retry", icon: "i-lucide-rotate-ccw", onSelect: () => void run("retry", () => s.editUser(item.entryId, item.text, item.images)) }] : []),
		],
		[
			{ label: "Continue from here", icon: "i-lucide-corner-down-right", onSelect: () => void run("move here", () => s.continueFrom(item.entryId)) },
			{ label: "Fork from here", icon: "i-lucide-git-fork", onSelect: () => void run("fork", () => s.fork(item.entryId)) },
			...(s.caps.value.label
				? [{
						label: label.value ? "Remove label" : "Label…",
						icon: "i-lucide-bookmark",
						onSelect: () => {
							if (label.value) return void run("remove the label", () => s.setLabel(item.entryId));
							const name = window.prompt("Label this message");
							if (name?.trim()) void run("add the label", () => s.setLabel(item.entryId, name.trim()));
						},
					}]
				: []),
		],
	];
});

const siblings = computed(() => (props.item.kind === "event" ? undefined : props.item.siblings));
const step = (d: -1 | 1) => {
	const sib = siblings.value;
	const id = sib?.ids[sib.index + d];
	if (id) void run("switch branch", () => props.session.switchBranch(id));
};
</script>

<template>
	<div v-if="item.kind === 'event'" class="flex items-center gap-2 py-1 text-xs text-dimmed">
		<div class="h-px flex-1 bg-border" />
		<UIcon :name="item.icon" class="size-3.5" />
		<span>{{ item.text }}</span>
		<div class="h-px flex-1 bg-border" />
	</div>

	<div v-else :id="`entry-${item.entryId}`" class="group flex flex-col gap-1" :class="item.kind === 'user' ? 'items-end' : 'items-start'">
		<UBadge v-if="label" :label="label" icon="i-lucide-bookmark" size="sm" variant="subtle" />

		<div v-if="editing" class="flex w-full flex-col gap-2 rounded-lg border border-primary/50 p-2">
			<UTextarea
				v-for="(_, i) in draft"
				:key="i"
				ref="editor"
				v-model="draft[i]"
				autoresize
				:rows="2"
				variant="none"
				@keydown.meta.enter="saveEdit"
				@keydown.esc="editing = false"
			/>
			<div class="flex items-center justify-end gap-2">
				<span class="me-auto text-xs text-muted">{{ item.kind === "user" ? "Resending creates a new branch; the old answer stays." : "Later messages stay on the old branch." }}</span>
				<UButton label="Cancel" size="sm" color="neutral" variant="ghost" @click="editing = false" />
				<UButton :label="item.kind === 'user' ? (session.streaming.value ? 'Stop & resend' : 'Resend') : 'Save'" size="sm" @click="saveEdit" />
			</div>
		</div>

		<div v-else-if="item.kind === 'user'" class="flex max-w-[85%] flex-col items-end gap-1.5">
			<div v-if="item.files.length" class="flex flex-wrap justify-end gap-1">
				<UBadge v-for="f in item.files" :key="f" :label="f.split('/').at(-1)" :title="f" icon="i-lucide-paperclip" color="neutral" variant="outline" size="sm" />
			</div>
			<img v-for="(img, i) in item.images" :key="i" :src="`data:${img.mimeType};base64,${img.data}`" class="max-h-48 rounded-md border border-default" alt="Attached image" />
			<div v-if="item.text" class="rounded-2xl bg-elevated px-4 py-2 whitespace-pre-wrap text-highlighted">{{ item.text }}</div>
		</div>

		<div v-else class="flex w-full flex-col gap-2">
			<template v-for="(p, i) in item.parts" :key="i">
				<UChatReasoning v-if="p.kind === 'thinking'" :text="p.text">
					<p class="text-sm whitespace-pre-wrap text-muted">{{ p.text }}</p>
				</UChatReasoning>
				<OmpMarkdown v-else-if="p.kind === 'text'" :value="p.text" />
				<img v-else-if="p.kind === 'image'" :src="`data:${p.mimeType};base64,${p.data}`" class="max-h-72 rounded-md" alt="Image from the model" />
				<ToolCard
					v-else-if="p.kind === 'tool'"
					:call="p.call"
					:approval="approvals.get(p.call.id)"
					@approve="emit('approve', approvals.get(p.call.id)!, 'Approve')"
					@deny="emit('approve', approvals.get(p.call.id)!, 'Deny')"
					@always-allow="emit('alwaysAllow', approvals.get(p.call.id)!, p.call.name)"
				/>
			</template>
			<UAlert v-if="item.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="item.error" />
			<p v-if="item.aborted" class="text-xs text-dimmed">Stopped.</p>
		</div>

		<div v-if="!editing" class="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100" :class="{ 'opacity-100': (siblings?.count ?? 0) > 1 }">
			<template v-if="siblings && siblings.count > 1">
				<UButton icon="i-lucide-chevron-left" size="xs" color="neutral" variant="ghost" :disabled="siblings.index === 0" aria-label="Previous branch" @click="step(-1)" />
				<span class="text-xs text-muted tabular-nums">{{ siblings.index + 1 }}/{{ siblings.count }}</span>
				<UButton icon="i-lucide-chevron-right" size="xs" color="neutral" variant="ghost" :disabled="siblings.index === siblings.count - 1" aria-label="Next branch" @click="step(1)" />
			</template>
			<UButton v-if="canEdit" icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" aria-label="Edit" @click="startEdit" />
			<UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" aria-label="Copy" @click="writeText(copyText)" />
			<UDropdownMenu :items="menu">
				<UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" aria-label="More" />
			</UDropdownMenu>
			<span v-if="item.kind === 'assistant' && item.model" class="ms-1 text-xs text-dimmed">{{ item.model }}</span>
		</div>
	</div>
</template>
