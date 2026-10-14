<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Session } from "~/composables/useSession";

const props = defineProps<{ session: Session }>();
const emit = defineEmits<{ openModels: []; attach: [] }>();
const toast = useToast();

const levels = ref<string[]>([]);
watch(
	() => [props.session.handle.value, props.session.state.value?.model?.id],
	async ([h]) => {
		if (h === undefined) return;
		levels.value = await props.session.thinkingLevels().catch(() => []);
	},
	{ immediate: true },
);

const model = computed(() => props.session.state.value?.model);
const thinking = computed(() => props.session.state.value?.thinkingLevel);
const scope = computed(() => SCOPES.find(s => s.value === props.session.scope.value) ?? SCOPES[1]!);
const usage = computed(() => props.session.state.value?.contextUsage);

async function run(what: string, fn: () => Promise<void>) {
	try {
		await fn();
	} catch (e) {
		toast.add({ title: `Couldn't ${what}`, description: e instanceof Error ? e.message : String(e), color: "error" });
	}
}

const scopeItems = computed(() =>
	SCOPES.map(s => ({
		label: s.label,
		description: s.description,
		icon: s.icon,
		type: "checkbox" as const,
		checked: s.value === props.session.scope.value,
		onSelect: () => void run("change the access scope", () => props.session.setScope(s.value)),
	})),
);

const thinkingItems = computed(() =>
	levels.value.map(l => ({
		label: l,
		type: "checkbox" as const,
		checked: l === thinking.value,
		onSelect: () => void run("change thinking", () => props.session.setThinking(l)),
	})),
);
</script>

<template>
	<div class="flex w-full flex-wrap items-center gap-1">
		<UTooltip text="Attach files (or drop them here)">
			<UButton icon="i-lucide-paperclip" size="sm" color="neutral" variant="ghost" aria-label="Attach files" @click="emit('attach')" />
		</UTooltip>

		<UButton
			:label="model ? model.name || model.id : 'Model'"
			icon="i-lucide-cpu"
			trailing-icon="i-lucide-chevron-down"
			size="sm"
			color="neutral"
			variant="ghost"
			:disabled="session.handle.value === undefined"
			@click="emit('openModels')"
		/>

		<UDropdownMenu v-if="levels.length" :items="thinkingItems">
			<UButton :label="thinking ?? 'thinking'" icon="i-lucide-brain" size="sm" color="neutral" variant="ghost" />
		</UDropdownMenu>

		<UDropdownMenu :items="scopeItems">
			<UTooltip :text="session.planning.value && session.scope.value === 'yolo' ? 'While planning, commands ask first even on Full access.' : scope.description">
				<UButton :label="scope.label" :icon="scope.icon" size="sm" :color="session.scope.value === 'yolo' ? 'warning' : 'neutral'" variant="ghost" />
			</UTooltip>
		</UDropdownMenu>

		<UTooltip v-if="session.caps.value.plan" text="Plan before editing" :kbds="['meta', 'shift', 'p']">
			<UButton
				label="Plan"
				icon="i-lucide-map"
				size="sm"
				:color="session.planning.value ? 'info' : 'neutral'"
				:variant="session.planning.value ? 'soft' : 'ghost'"
				:disabled="session.streaming.value"
				@click="run('toggle plan mode', () => session.setPlanning(!session.planning.value))"
			/>
		</UTooltip>

		<div class="ms-auto flex items-center gap-2">
			<UBadge v-for="(t, k) in session.statusChips.value" :key="k" :label="t" size="sm" variant="subtle" color="neutral" />
			<UTooltip v-if="usage" :text="`${usage.tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens`">
				<div class="flex items-center gap-1.5 text-xs text-muted">
					<UProgress :model-value="Math.min(100, usage.percent)" size="xs" class="w-16" :color="usage.percent > 80 ? 'warning' : 'neutral'" />
					<span class="tabular-nums">{{ Math.round(usage.percent) }}%</span>
				</div>
			</UTooltip>
		</div>
	</div>
</template>
