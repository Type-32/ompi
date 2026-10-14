<script setup lang="ts">
import type { ContextMenuItem } from "@nuxt/ui";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import type { Workspace } from "~/composables/useWorkspaces";
import type { SessionMeta } from "~/utils/omp/types";

const tabs = useTabs();
const ws = useWorkspaces();
const ui = useUi();
const drop = useDropRouter();
const toast = useToast();

const filter = ref("");
const expanded = ref<Record<string, boolean>>({});
const SHOWN_PER_WORKSPACE = 8;

const shown = computed(() => {
	const q = filter.value.trim().toLowerCase();
	return ws.workspaces.value
		.map(w => ({
			w,
			sessions: q ? w.sessions.filter(s => (s.title ?? "").toLowerCase().includes(q) || w.name.toLowerCase().includes(q)) : w.sessions,
		}))
		.filter(x => !q || x.sessions.length > 0 || x.w.name.toLowerCase().includes(q));
});

/** Session files currently open in a tab, keyed to their tab, for highlighting and live badges. */
const openFiles = computed(() => {
	const out = new Map<string, string>();
	for (const t of tabs.tabs.value) {
		if (t.kind !== "session") continue;
		const f = tabs.sessionOf(t.id)?.sessionFile.value ?? t.target.file;
		if (f) out.set(f, t.id);
	}
	return out;
});

function open(s: SessionMeta, w: Workspace, newTab = false) {
	tabs.openSession({ cwd: s.cwd, workspaceId: w.id, file: s.file, extraDirs: w.prefs.extraDirs }, { inActiveIfEmpty: !newTab });
}

function relTime(ms: number): string {
	const d = (Date.now() - ms) / 1000;
	if (d < 60) return "now";
	if (d < 3600) return `${Math.floor(d / 60)}m`;
	if (d < 86400) return `${Math.floor(d / 3600)}h`;
	if (d < 86400 * 30) return `${Math.floor(d / 86400)}d`;
	return new Date(ms).toLocaleDateString();
}

const confirmDelete = ref<SessionMeta>();
async function doDelete() {
	const s = confirmDelete.value;
	confirmDelete.value = undefined;
	if (!s) return;
	const tabId = openFiles.value.get(s.file);
	try {
		if (tabId) await tabs.close(tabId);
		await ws.deleteSession(s.file);
	} catch (e) {
		toast.add({ title: "Couldn't delete the session", description: String(e), color: "error" });
	}
}

function sessionMenu(s: SessionMeta, w: Workspace): ContextMenuItem[][] {
	return [
		[
			{ label: "Open", icon: "i-lucide-message-square", onSelect: () => open(s, w) },
			{ label: "Open in new tab", icon: "i-lucide-square-plus", onSelect: () => open(s, w, true) },
			{ label: "Reveal in Finder", icon: "i-lucide-folder-search", onSelect: () => void revealItemInDir(s.file) },
		],
		[{ label: "Delete…", icon: "i-lucide-trash-2", color: "error", onSelect: () => (confirmDelete.value = s) }],
	];
}

function workspaceMenu(w: Workspace): ContextMenuItem[][] {
	return [
		[
			{ label: "New session", icon: "i-lucide-plus", onSelect: () => void newSessionIn(w) },
			{ label: "Reveal in Finder", icon: "i-lucide-folder-search", onSelect: () => void revealItemInDir(w.path) },
		],
		...(w.added ? [[{ label: "Remove from sidebar", icon: "i-lucide-folder-minus", onSelect: () => void ws.removeFolder(w.path) }]] : []),
	];
}

const root = useTemplateRef<HTMLElement>("root");
let unregister: (() => void) | undefined;
onMounted(() => {
	unregister = drop.register({
		el: () => root.value,
		priority: 1,
		async onDrop(paths) {
			for (const p of paths) await ws.addFolder(p);
			toast.add({ title: paths.length === 1 ? "Workspace added" : `${paths.length} workspaces added`, icon: "i-lucide-folder-plus" });
		},
	});
});
onBeforeUnmount(() => unregister?.());
</script>

<template>
	<UDashboardSidebar
		v-model:collapsed="ui.sidebarCollapsed.value"
		collapsible
		resizable
		:min-size="16"
		:default-size="20"
		:max-size="35"
		:ui="{ root: 'bg-elevated/40', header: 'pt-18' }"
        data-tauri-drag-region
	>
		<template #header="{ collapsed }" data-tauri-drag-region>
            <UDashboardNavbar data-tauri-drag-region class="w-full h-full">
                <template #default>
                    <div data-tauri-drag-region v-if="!collapsed" ref="root" class="flex w-full flex-col gap-2" :class="{ 'rounded-md ring-2 ring-primary': drop.hovered.value?.priority === 1 }">
                        <UButton block icon="i-lucide-search" label="Search…" color="neutral" variant="outline" class="justify-start text-muted" @click="ui.paletteOpen.value = true">
                            <template #trailing><UKbd value="meta" /><UKbd value="k" /></template>
                        </UButton>
                        <UInput v-model="filter" icon="i-lucide-filter" placeholder="Filter sessions" size="sm" />
                    </div>
                    <UButton v-else icon="i-lucide-search" color="neutral" variant="ghost" @click="ui.paletteOpen.value = true" />
                </template>
            </UDashboardNavbar>
		</template>

		<template #default="{ collapsed }">
			<div v-if="!collapsed" class="flex flex-col gap-3">
				<UAlert v-if="ws.ompError.value" color="error" variant="subtle" icon="i-lucide-circle-alert" title="omp isn't available" :description="ws.ompError.value" />
				<UAlert
					v-else-if="ws.omp.value && !ws.omp.value.supported"
					color="warning"
					variant="subtle"
					icon="i-lucide-triangle-alert"
					:title="`omp ${ws.omp.value.version} is too old`"
					description="ompi needs omp 18.8.9 or later. Run `omp update`."
				/>
				<div v-if="ws.loading.value && !ws.sessions.value.length" class="flex flex-col gap-2 p-1">
					<USkeleton v-for="i in 6" :key="i" class="h-6 w-full" />
				</div>
				<p v-else-if="!shown.length" class="px-2 text-sm text-muted">
					{{ filter ? "No matching sessions." : "No workspaces yet. Add a folder, or drop one here." }}
				</p>

				<section v-for="{ w, sessions } in shown" :key="w.id">
					<UContextMenu :items="workspaceMenu(w)">
						<div class="group flex items-center gap-1 px-1">
							<UIcon name="i-lucide-folder" class="size-4 shrink-0 text-muted" />
							<span class="truncate text-xs font-semibold tracking-wide text-muted uppercase" :title="w.path">{{ w.name }}</span>
							<UButton icon="i-lucide-plus" size="xs" color="neutral" variant="ghost" class="ms-auto opacity-0 group-hover:opacity-100" :aria-label="`New session in ${w.name}`" @click="newSessionIn(w)" />
						</div>
					</UContextMenu>
					<ul class="mt-1 flex flex-col">
						<li v-for="s in expanded[w.id] || filter ? sessions : sessions.slice(0, SHOWN_PER_WORKSPACE)" :key="s.file">
							<UContextMenu :items="sessionMenu(s, w)">
								<button
									type="button"
									class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-elevated"
									:class="openFiles.get(s.file) === tabs.activeId.value && openFiles.has(s.file) ? 'bg-elevated text-highlighted' : 'text-default'"
									@click="open(s, w)"
									@auxclick.middle="open(s, w, true)"
								>
									<UIcon v-if="openFiles.has(s.file) && tabs.statusOf(openFiles.get(s.file)!).streaming" name="i-lucide-loader-circle" class="size-3.5 shrink-0 animate-spin text-primary" />
									<span v-else-if="openFiles.has(s.file) && tabs.statusOf(openFiles.get(s.file)!).needsInput" class="size-2 shrink-0 rounded-full bg-warning" />
									<span v-else-if="s.parentSession" class="i-lucide-git-fork size-3.5 shrink-0 text-dimmed" />
									<span class="min-w-0 flex-1 truncate">{{ s.title ?? "Untitled session" }}</span>
									<span class="shrink-0 text-xs text-dimmed">{{ relTime(s.modifiedMs) }}</span>
								</button>
							</UContextMenu>
						</li>
						<li v-if="!filter && sessions.length > SHOWN_PER_WORKSPACE">
							<UButton
								size="xs"
								color="neutral"
								variant="link"
								:label="expanded[w.id] ? 'Show fewer' : `Show ${sessions.length - SHOWN_PER_WORKSPACE} more`"
								@click="expanded[w.id] = !expanded[w.id]"
							/>
						</li>
					</ul>
				</section>
			</div>
		</template>

		<template #footer="{ collapsed }">
			<div class="flex w-full items-center gap-1">
				<UButton :icon="'i-lucide-folder-plus'" :label="collapsed ? undefined : 'Add workspace'" color="neutral" variant="ghost" class="flex-1" @click="addWorkspaceFolder()" />
				<UButton v-if="!collapsed" icon="i-lucide-settings" color="neutral" variant="ghost" aria-label="Settings" @click="tabs.open({ kind: 'settings' })" />
			</div>
		</template>
	</UDashboardSidebar>

	<UModal :open="!!confirmDelete" title="Delete this session?" :description="confirmDelete?.title ?? 'Untitled session'" @update:open="v => !v && (confirmDelete = undefined)">
		<template #body>
			<p class="text-sm text-muted">The session file and its artifacts are removed from omp's session store. This can't be undone.</p>
		</template>
		<template #footer>
			<div class="flex w-full justify-end gap-2">
				<UButton label="Cancel" color="neutral" variant="ghost" @click="confirmDelete = undefined" />
				<UButton label="Delete" color="error" icon="i-lucide-trash-2" @click="doDelete" />
			</div>
		</template>
	</UModal>
</template>

<style>
</style>