<script setup lang="ts">
// Renders omp's blocking UI requests that aren't tool approvals: questions from the `ask`
// tool, selects, confirms, text inputs and editors. Timeouts are enforced here, as RPC asks.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { Session } from "~/composables/useSession";
import type { Dialog } from "~/utils/omp/schema";

const props = defineProps<{ session: Session; dialog: Dialog }>();

const text = ref("");
const picked = ref<Record<string, string[]>>({});
const custom = ref<Record<string, string>>({});
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
	() => props.dialog,
	d => {
		clearTimeout(timer);
		text.value = d.method === "editor" ? (d.prefill ?? "") : "";
		picked.value = {};
		custom.value = {};
		const timeout = "timeout" in d ? d.timeout : undefined;
		if (timeout) timer = setTimeout(() => void props.session.answer(d, { cancelled: true, timedOut: true }), timeout);
	},
	{ immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

const cancel = () => props.session.answer(props.dialog, { cancelled: true });

function toggle(qid: string, label: string, multi: boolean) {
	const cur = picked.value[qid] ?? [];
	picked.value = { ...picked.value, [qid]: multi ? (cur.includes(label) ? cur.filter(l => l !== label) : [...cur, label]) : [label] };
}

const askReady = computed(() => props.dialog.method !== "ask" || props.dialog.questions.every(q => (picked.value[q.id]?.length ?? 0) > 0 || custom.value[q.id]?.trim()));

function submitAsk() {
	if (props.dialog.method !== "ask") return;
	const answers = props.dialog.questions.map(q => ({
		id: q.id,
		selectedOptions: picked.value[q.id] ?? [],
		...(custom.value[q.id]?.trim() ? { customInput: custom.value[q.id]!.trim() } : {}),
	}));
	void props.session.answer(props.dialog, { answers });
}
</script>

<template>
	<UCard class="border-warning/50 ring-1 ring-warning/40" :ui="{ body: 'flex flex-col gap-3' }">
		<template v-if="dialog.method === 'ask'">
			<div v-for="q in dialog.questions" :key="q.id" class="flex flex-col gap-2">
				<p class="font-medium text-highlighted">{{ q.question }}</p>
				<div class="flex flex-wrap gap-2">
					<UButton
						v-for="o in q.options"
						:key="o.label"
						:label="o.label"
						:title="o.description"
						:variant="picked[q.id]?.includes(o.label) ? 'solid' : 'outline'"
						:color="picked[q.id]?.includes(o.label) ? 'primary' : 'neutral'"
						size="sm"
						@click="toggle(q.id, o.label, !!q.multi)"
					/>
				</div>
				<UInput v-model="custom[q.id]" placeholder="Or type your own answer" size="sm" />
			</div>
			<div class="flex justify-end gap-2">
				<UButton label="Skip" color="neutral" variant="ghost" @click="cancel" />
				<UButton label="Answer" icon="i-lucide-send" :disabled="!askReady" @click="submitAsk" />
			</div>
		</template>

		<template v-else-if="dialog.method === 'select'">
			<p class="font-medium whitespace-pre-wrap text-highlighted">{{ dialog.title }}</p>
			<div class="flex flex-col gap-1">
				<UButton
					v-for="(o, i) in dialog.options"
					:key="o"
					:label="o"
					:description="dialog.optionDetails?.[i]?.description"
					color="neutral"
					variant="outline"
					class="justify-start"
					@click="session.answer(dialog, { value: o })"
				/>
			</div>
			<div class="flex justify-end"><UButton label="Cancel" color="neutral" variant="ghost" @click="cancel" /></div>
		</template>

		<template v-else-if="dialog.method === 'confirm'">
			<p class="font-medium text-highlighted">{{ dialog.title }}</p>
			<p class="text-sm whitespace-pre-wrap text-muted">{{ dialog.message }}</p>
			<div class="flex justify-end gap-2">
				<UButton label="No" color="neutral" variant="outline" @click="session.answer(dialog, { confirmed: false })" />
				<UButton label="Yes" @click="session.answer(dialog, { confirmed: true })" />
			</div>
		</template>

		<template v-else>
			<p class="font-medium text-highlighted">{{ dialog.title }}</p>
			<UTextarea v-if="dialog.method === 'editor'" v-model="text" autoresize :rows="6" class="font-mono" />
			<UInput v-else v-model="text" :placeholder="dialog.placeholder" autofocus @keydown.enter="session.answer(dialog, { value: text })" />
			<div class="flex justify-end gap-2">
				<UButton label="Cancel" color="neutral" variant="ghost" @click="cancel" />
				<UButton label="Submit" @click="session.answer(dialog, { value: text })" />
			</div>
		</template>
	</UCard>
</template>
