<script setup lang="ts">
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onBeforeUnmount, onMounted, reactive, watch } from "vue";

const tabs = useTabs();
const ws = useWorkspaces();
const ui = useUi();
const { groups } = useActions();

/** Tabs whose pane has been mounted. Restored tabs mount lazily, when first shown. */
const visited = reactive(new Set<string>());
watch(
	() => [tabs.activeId.value, tabs.tabs.value] as const,
	([active, list]) => {
		if (active) visited.add(active);
		const open = new Set(list.map(t => t.id));
		for (const id of visited) if (!open.has(id)) visited.delete(id);
	},
	{ immediate: true },
);

// App-level shortcuts are all modifier chords, so they must also fire while the composer has focus.
const always = (handler: () => unknown) => ({ handler, usingInput: true });

defineShortcuts({
	meta_k: always(() => (ui.paletteOpen.value = !ui.paletteOpen.value)),
	meta_t: always(() => tabs.open({ kind: "empty" })),
	meta_w: always(() => tabs.activeId.value && tabs.close(tabs.activeId.value)),
	meta_shift_t: always(() => tabs.reopenClosed()),
	ctrl_tab: always(() => tabs.cycle(1)),
	ctrl_shift_tab: always(() => tabs.cycle(-1)),
	meta_b: always(() => (ui.sidebarCollapsed.value = !ui.sidebarCollapsed.value)),
	"meta_\\": always(() => (ui.sidePanelOpen.value = !ui.sidePanelOpen.value)),
	"meta_,": always(() => tabs.open({ kind: "settings" })),
	meta_n: always(() => {
		const w = ws.workspaces.value[0];
		if (w) void newSessionIn(w);
		else ui.paletteOpen.value = true;
	}),
	...Object.fromEntries(
		Array.from({ length: 9 }, (_, i) => [
			`meta_${i + 1}`,
			always(() => {
				const t = i === 8 ? tabs.tabs.value.at(-1) : tabs.tabs.value[i];
				if (t) tabs.activate(t.id);
			}),
		]),
	),
});

// Folders dropped anywhere outside a session composer become workspaces.
// Session tabs register their own drop zone and claim drops over the composer first.
let unlisten: (() => void) | undefined;
onMounted(async () => {
	unlisten = await getCurrentWebview().onDragDropEvent(e => useDropRouter().dispatch(e.payload));
});
onBeforeUnmount(() => unlisten?.());
</script>

<template>
	<UApp :tooltip="{ delayDuration: 400 }" :toaster="{ position: 'bottom-right' }">
		<UDashboardGroup storage="local" storage-key="ompi" class="h-screen">
			<AppSidebar />
			<div class="flex min-w-0 flex-1 flex-col">
				<TabStrip />
				<div class="relative min-h-0 flex-1">
					<!-- One pane per tab, mounted on first visit and hidden (not unmounted) when inactive,
					     so switching tabs keeps scroll and drafts. Closing a tab unmounts its pane. -->
					<template v-for="t in tabs.tabs.value" :key="`${t.kind}:${t.id}`">
						<div v-if="visited.has(t.id)" v-show="t.id === tabs.activeId.value" class="absolute inset-0">
							<component :is="TAB_KINDS[t.kind].component" :tab="t" />
						</div>
					</template>
				</div>
			</div>
			<UDashboardSearch v-model:open="ui.paletteOpen.value" :groups="groups" :color-mode="true" placeholder="Search actions, sessions, commands…" shortcut="" />
		</UDashboardGroup>
	</UApp>
</template>

<style>
div[data-tauri-decorum-tb] {
    pointer-events: none;
    div[data-tauri-drag-region] {
        pointer-events: none;
    }
}
</style>