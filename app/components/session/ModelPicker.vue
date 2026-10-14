<script setup lang="ts">
// The catalog is ~1.6 MB (576 models on a typical setup), so it's fetched once per app run.
import { computed, ref, watch } from "vue";
import type { Session } from "~/composables/useSession";
import type { Model } from "~/utils/omp/schema";

const props = defineProps<{ session: Session }>();
const open = defineModel<boolean>("open", { default: false });
const toast = useToast();

const catalog = useState<Model[] | undefined>("omp-models", () => undefined);
const loading = ref(false);

async function load(force = false) {
	if (catalog.value && !force) return;
	loading.value = true;
	try {
		catalog.value = await props.session.models();
	} catch (e) {
		toast.add({ title: "Couldn't load models", description: String(e), color: "error" });
	} finally {
		loading.value = false;
	}
}
watch(open, v => v && void load(), { immediate: true });

const fmt = (n?: number) => (n === undefined ? "" : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);
const current = computed(() => props.session.state.value?.model);

const groups = computed(() => {
	const by = new Map<string, Model[]>();
	for (const m of catalog.value ?? []) {
		const list = by.get(m.provider) ?? [];
		list.push(m);
		by.set(m.provider, list);
	}
	return [...by.entries()].map(([provider, models]) => ({
		id: provider,
		label: provider,
		items: models.map(m => ({
			label: m.name || m.id,
			suffix: m.id,
			description: [m.contextWindow && `${fmt(m.contextWindow)} context`, m.cost?.input !== undefined && `$${m.cost.input}/$${m.cost.output ?? "?"} per M`].filter(Boolean).join(" · "),
			icon: m.input?.includes("image") ? "i-lucide-image" : m.reasoning ? "i-lucide-brain" : "i-lucide-cpu",
			active: current.value?.provider === m.provider && current.value.id === m.id,
			onSelect: async () => {
				open.value = false;
				try {
					await props.session.setModel(m.provider, m.id);
				} catch (e) {
					toast.add({ title: "Couldn't switch model", description: String(e), color: "error" });
				}
			},
		})),
	}));
});
</script>

<template>
	<UModal v-model:open="open" title="Choose a model" :ui="{ content: 'max-w-2xl' }">
		<template #content>
			<UCommandPalette
				:groups="groups"
				:loading="loading"
				:virtualize="{ estimateSize: 52 }"
				placeholder="Search models…"
				:fuse="{ resultLimit: 200, fuseOptions: { keys: ['label', 'suffix'] } }"
				class="h-[28rem]"
				close
				@update:open="open = $event"
			>
				<template #footer>
					<div class="flex items-center justify-between text-xs text-muted">
						<span>{{ catalog?.length ?? 0 }} models. Changes apply to this session only.</span>
						<UButton label="Refresh" icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost" :loading="loading" @click="load(true)" />
					</div>
				</template>
			</UCommandPalette>
		</template>
	</UModal>
</template>
