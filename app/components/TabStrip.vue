<script setup lang="ts">
const tabs = useTabs();
const ui = useUi();

let dragFrom = -1;
function onDrop(to: number) {
	if (dragFrom >= 0 && dragFrom !== to) tabs.move(dragFrom, to);
	dragFrom = -1;
}
</script>

<template>
	<!-- Sits in the overlay titlebar: drag region everywhere except the tabs and buttons. -->
	<div data-tauri-drag-region class="flex h-11 shrink-0 items-end gap-1 border-b border-default bg-elevated/60 pr-2" :class="ui.sidebarCollapsed.value ? 'pl-20' : 'pl-2'">
		<div class="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" data-tauri-drag-region>
			<div
				v-for="(tab, i) in tabs.tabs.value"
				:key="tab.id"
				draggable="true"
				class="group relative flex h-9 max-w-56 min-w-28 shrink-0 cursor-default items-center gap-2 rounded-t-md border border-b-0 px-3 text-sm select-none"
				:class="tab.id === tabs.activeId.value ? 'border-default bg-default text-highlighted' : 'border-transparent text-muted hover:bg-default/50'"
				@mousedown.middle.prevent="tabs.close(tab.id)"
				@click="tabs.activate(tab.id)"
				@dragstart="dragFrom = i"
				@dragover.prevent
				@drop.prevent="onDrop(i)"
			>
				<UIcon v-if="tabs.statusOf(tab.id).streaming" name="i-lucide-loader-circle" class="size-4 shrink-0 animate-spin text-primary" />
				<UIcon v-else :name="TAB_KINDS[tab.kind].icon(tab, tabs.sessionOf(tab.id))" class="size-4 shrink-0" />
				<span class="truncate">{{ useTabTitle(tab.id) }}</span>
				<UBadge v-if="tabs.statusOf(tab.id).planning" label="Plan" size="sm" variant="subtle" color="info" class="shrink-0" />
				<span v-if="tabs.statusOf(tab.id).needsInput" class="size-2 shrink-0 rounded-full bg-warning" title="Waiting for you" />
				<UIcon v-if="tabs.statusOf(tab.id).exited" name="i-lucide-circle-alert" class="size-4 shrink-0 text-error" />
				<UButton
					icon="i-lucide-x"
					size="xs"
					color="neutral"
					variant="ghost"
					class="ms-auto -me-1 opacity-0 group-hover:opacity-100"
					:class="{ 'opacity-100': tab.id === tabs.activeId.value }"
					aria-label="Close tab"
					@click.stop="tabs.close(tab.id)"
				/>
			</div>
			<UTooltip text="New tab" :kbds="['meta', 't']">
				<UButton icon="i-lucide-plus" size="sm" color="neutral" variant="ghost" class="mb-1" aria-label="New tab" @click="tabs.open({ kind: 'empty' })" />
			</UTooltip>
		</div>
		<UTooltip text="Command palette" :kbds="['meta', 'k']">
			<UButton icon="i-lucide-command" size="sm" color="neutral" variant="ghost" class="mb-1" aria-label="Command palette" @click="ui.paletteOpen.value = true" />
		</UTooltip>
	</div>
</template>
