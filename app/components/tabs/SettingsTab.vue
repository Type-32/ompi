<script setup lang="ts">
import { computed } from "vue";
import type { Tab } from "~/composables/useTabs";
import type { Workspace } from "~/composables/useWorkspaces";
import { host } from "~/utils/omp/host";
import type { Scope } from "~/utils/omp/types";

defineProps<{ tab: Tab }>();
const ws = useWorkspaces();
const toast = useToast();

const configured = computed(() => ws.workspaces.value.filter(w => w.added || Object.keys(w.prefs.rules ?? {}).length || w.prefs.model));

async function setScope(w: Workspace, scope: Scope) {
	await ws.setPrefs(w.path, { scope });
}

async function setModel(w: Workspace, model: string) {
	await ws.setPrefs(w.path, { model: model.trim() || undefined });
}

async function removeRule(w: Workspace, tool: string) {
	const rules = { ...(w.prefs.rules ?? {}) };
	delete rules[tool];
	await ws.setPrefs(w.path, { rules });
	try {
		await host.setWorkspaceRules(w.id, rules);
	} catch (e) {
		toast.add({ title: "Couldn't update the rule", description: String(e), color: "error" });
	}
}
</script>

<template>
	<div class="h-full overflow-y-auto">
		<div class="mx-auto flex max-w-3xl flex-col gap-8 p-8">
			<header>
				<h1 class="text-2xl font-semibold text-highlighted">Settings</h1>
			</header>

			<section class="flex flex-col gap-3">
				<h2 class="font-semibold text-highlighted">omp</h2>
				<UAlert v-if="ws.ompError.value" color="error" variant="subtle" icon="i-lucide-circle-alert" :description="ws.ompError.value" />
				<dl v-else-if="ws.omp.value" class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
					<dt class="text-muted">Version</dt>
					<dd>
						{{ ws.omp.value.version }}
						<UBadge v-if="!ws.omp.value.supported" label="too old — needs 18.8.9+" color="warning" variant="subtle" size="sm" />
					</dd>
					<dt class="text-muted">Binary</dt>
					<dd class="font-mono text-xs">{{ ws.omp.value.path }}</dd>
					<dt class="text-muted">Data folder</dt>
					<dd class="font-mono text-xs">{{ ws.omp.value.agentDir }}</dd>
				</dl>
				<p class="text-sm text-muted">
					ompi runs your installed omp, so it uses your logins, config, MCP servers and sessions. To use a different binary, start ompi with
					<code>OMPI_OMP_PATH=/path/to/omp</code>.
				</p>
			</section>

			<section class="flex flex-col gap-3">
				<h2 class="font-semibold text-highlighted">Workspaces</h2>
				<p class="text-sm text-muted">The default access scope and model apply to new sessions. "Always allow" rules apply to every session in the workspace.</p>
				<UCard v-for="w in configured.length ? configured : ws.workspaces.value.slice(0, 5)" :key="w.id" :ui="{ body: 'flex flex-col gap-3' }">
					<div class="flex items-center gap-2">
						<UIcon name="i-lucide-folder" class="size-4 text-muted" />
						<span class="font-medium text-highlighted">{{ w.name }}</span>
						<span class="truncate font-mono text-xs text-dimmed">{{ w.path }}</span>
					</div>
					<UFormField label="Default access scope">
						<USelect
							:model-value="w.prefs.scope"
							:items="SCOPES.map(s => ({ label: s.label, value: s.value, description: s.description }))"
							class="w-56"
							@update:model-value="v => setScope(w, v as Scope)"
						/>
					</UFormField>
					<UFormField label="Default model for new sessions" help="provider/model, e.g. anthropic/claude-sonnet-4-6. Empty uses omp's default.">
						<UInput :model-value="w.prefs.model ?? ''" placeholder="omp default" class="w-80 font-mono" @change="(e: Event) => setModel(w, (e.target as HTMLInputElement).value)" />
					</UFormField>
					<div v-if="Object.keys(w.prefs.rules ?? {}).length" class="flex flex-col gap-1">
						<span class="text-sm font-medium">Tool rules</span>
						<div v-for="(policy, tool) in w.prefs.rules" :key="tool" class="flex items-center gap-2 text-sm">
							<code>{{ tool }}</code>
							<UBadge :label="policy" size="sm" variant="subtle" />
							<UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="`Remove rule for ${tool}`" @click="removeRule(w, String(tool))" />
						</div>
					</div>
				</UCard>
			</section>

			<section class="flex flex-col gap-2">
				<h2 class="font-semibold text-highlighted">Keyboard</h2>
				<ul class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
					<li v-for="[k, d] in [
						[['meta', 'k'], 'Command palette'], [['meta', 't'], 'New tab'], [['meta', 'w'], 'Close tab'], [['meta', 'shift', 't'], 'Reopen closed tab'],
						[['meta', 'n'], 'New session'], [['meta', 'm'], 'Change model'], [['meta', 'shift', 'p'], 'Plan mode'], [['meta', '\\'], 'Side panel'],
						[['meta', 'b'], 'Sidebar'], [['meta', 'enter'], 'Queue follow-up'], [['escape'], 'Stop the turn'], [['ctrl', 'tab'], 'Next tab'],
					] as [string[], string][]" :key="d" class="flex items-center justify-between gap-2">
						<span class="text-muted">{{ d }}</span>
						<span class="flex gap-0.5"><UKbd v-for="x in k" :key="x" :value="x" /></span>
					</li>
				</ul>
			</section>
		</div>
	</div>
</template>
