<script setup lang="ts">
import { computed } from "vue";
import type { Tab } from "~/composables/useTabs";

defineProps<{ tab: Tab }>();
const tabs = useTabs();
const ws = useWorkspaces();
const ui = useUi();

const recent = computed(() => ws.sessions.value.filter(s => ws.byPath(s.cwd)).slice(0, 8));
</script>

<template>
	<div class="flex h-full items-center justify-center overflow-y-auto p-8">
		<div class="flex w-full max-w-2xl flex-col gap-8">
			<header class="flex flex-col gap-1">
				<h1 class="text-2xl font-semibold text-highlighted">New tab</h1>
				<p class="text-muted">Start a session in a workspace, or pick up a recent one.</p>
			</header>

			<section class="flex flex-col gap-2">
				<h2 class="text-xs font-semibold tracking-wide text-muted uppercase">New session in</h2>
				<div class="grid grid-cols-2 gap-2">
					<UButton
						v-for="w in ws.workspaces.value.slice(0, 6)"
						:key="w.id"
						icon="i-lucide-folder"
						:label="w.name"
						color="neutral"
						variant="outline"
						class="justify-start"
						:title="w.path"
						@click="newSessionIn(w)"
					/>
					<UButton icon="i-lucide-folder-plus" label="Add folder…" color="neutral" variant="ghost" class="justify-start" @click="addWorkspaceFolder().then(w => w && newSessionIn(w))" />
				</div>
			</section>

			<section v-if="recent.length" class="flex flex-col gap-2">
				<h2 class="text-xs font-semibold tracking-wide text-muted uppercase">Recent sessions</h2>
				<ul class="flex flex-col divide-y divide-default rounded-lg border border-default">
					<li v-for="s in recent" :key="s.file">
						<button
							type="button"
							class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-elevated"
							@click="tabs.openSession({ cwd: s.cwd, workspaceId: ws.byPath(s.cwd)!.id, file: s.file, extraDirs: ws.byPath(s.cwd)!.prefs.extraDirs })"
						>
							<UIcon name="i-lucide-message-square" class="size-4 shrink-0 text-muted" />
							<span class="min-w-0 flex-1 truncate">{{ s.title ?? "Untitled session" }}</span>
							<span class="shrink-0 text-xs text-dimmed">{{ s.cwd.split("/").at(-1) }}</span>
						</button>
					</li>
				</ul>
			</section>

			<p class="text-sm text-dimmed">
				<UKbd value="meta" /> <UKbd value="k" /> opens the command palette.
				<UButton label="Open it" size="xs" variant="link" @click="ui.paletteOpen.value = true" />
			</p>
		</div>
	</div>
</template>
