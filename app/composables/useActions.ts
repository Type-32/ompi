// One action list feeds the ⌘K palette, keyboard shortcuts and menus.
import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { computed, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import { TAB_KINDS, useTabs } from "./useTabs";
import { useWorkspaces } from "./useWorkspaces";
import type { Workspace } from "./useWorkspaces";
import type { Scope } from "~/utils/omp/types";

export const SCOPES: { value: Scope; label: string; icon: string; description: string }[] = [
	{ value: "always-ask", label: "Always ask", icon: "i-lucide-shield", description: "Ask before edits and commands" },
	{ value: "write", label: "Write", icon: "i-lucide-shield-half", description: "Edits run; commands ask first" },
	{ value: "yolo", label: "Full access", icon: "i-lucide-shield-off", description: "Everything runs without asking" },
];

export interface UiState {
	paletteOpen: Ref<boolean>;
	sidePanelOpen: Ref<boolean>;
	sidebarCollapsed: Ref<boolean>;
	/** Set by the palette; the active session tab opens its model picker when this changes. */
	modelPickerRequest: Ref<number>;
	/** Text to place in the active composer (e.g. a slash command with a hint to fill in). */
	composerInsert: Ref<{ text: string; seq: number } | undefined>;
}

let ui: UiState | undefined;
export function useUi(): UiState {
	ui ??= {
		paletteOpen: ref(false),
		sidePanelOpen: ref(true),
		sidebarCollapsed: ref(false),
		modelPickerRequest: ref(0),
		composerInsert: ref(),
	};
	return ui;
}

export async function newSessionIn(ws: Workspace): Promise<void> {
	useTabs().openSession({ cwd: ws.path, workspaceId: ws.id, model: ws.prefs.model, extraDirs: ws.prefs.extraDirs });
}

export async function addWorkspaceFolder(): Promise<Workspace | undefined> {
	const picked = await openDialog({ directory: true, multiple: false, title: "Add a workspace folder" });
	if (typeof picked !== "string") return undefined;
	return useWorkspaces().addFolder(picked);
}

export function useActions(): { groups: ComputedRef<CommandPaletteGroup<CommandPaletteItem>[]> } {
	const tabs = useTabs();
	const ws = useWorkspaces();
	const u = useUi();

	const insert = (text: string) => {
		u.composerInsert.value = { text, seq: (u.composerInsert.value?.seq ?? 0) + 1 };
	};

	const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
		const s = tabs.activeSession.value;
		const out: CommandPaletteGroup<CommandPaletteItem>[] = [
			{
				id: "tabs",
				label: "Tabs",
				items: [
					{ label: "New tab", icon: "i-lucide-square-plus", kbds: ["meta", "t"], onSelect: () => tabs.open({ kind: "empty" }) },
					{ label: "Close tab", icon: "i-lucide-x", kbds: ["meta", "w"], onSelect: () => tabs.activeId.value && tabs.close(tabs.activeId.value) },
					{ label: "Reopen closed tab", icon: "i-lucide-rotate-ccw", kbds: ["meta", "shift", "t"], onSelect: () => tabs.reopenClosed() },
					...tabs.tabs.value.map(t => ({
						label: `Go to: ${useTabTitle(t.id)}`,
						icon: "i-lucide-arrow-right",
						onSelect: () => tabs.activate(t.id),
					})),
				],
			},
			{
				id: "sessions",
				label: "Sessions",
				items: [
					{
						label: "New session in…",
						icon: "i-lucide-plus",
						kbds: ["meta", "n"],
						children: ws.workspaces.value.map(w => ({ label: w.name, suffix: w.path, icon: "i-lucide-folder", onSelect: () => newSessionIn(w) })),
					},
					{
						label: "Open session…",
						icon: "i-lucide-history",
						children: ws.sessions.value.slice(0, 300).map(m => ({
							label: m.title ?? "Untitled session",
							suffix: m.cwd.split("/").at(-1),
							icon: "i-lucide-message-square",
							onSelect: () => {
								const w = ws.byPath(m.cwd);
								tabs.openSession({ cwd: m.cwd, workspaceId: w?.id ?? m.cwd, file: m.file, extraDirs: w?.prefs.extraDirs });
							},
						})),
					},
					{ label: "Add workspace folder…", icon: "i-lucide-folder-plus", onSelect: () => void addWorkspaceFolder() },
				],
			},
		];
		if (s) {
			out.push({
				id: "session",
				label: "This session",
				items: [
					{ label: s.planning.value ? "Leave plan mode" : "Plan mode", icon: "i-lucide-map", kbds: ["meta", "shift", "p"], disabled: !s.caps.value.plan, onSelect: () => void s.setPlanning(!s.planning.value) },
					{ label: "Change model…", icon: "i-lucide-cpu", kbds: ["meta", "m"], onSelect: () => u.modelPickerRequest.value++ },
					{
						label: "Access scope",
						icon: "i-lucide-shield",
						children: SCOPES.map(sc => ({ label: sc.label, description: sc.description, icon: sc.icon, onSelect: () => void s.setScope(sc.value) })),
					},
					{ label: "Compact context", icon: "i-lucide-shrink", onSelect: () => void s.prompt("/compact") },
					{ label: "Fork session", icon: "i-lucide-git-fork", onSelect: () => void s.fork() },
					{ label: "Abort", icon: "i-lucide-square", kbds: ["escape"], disabled: !s.streaming.value, onSelect: () => void s.abort() },
					{ label: "Toggle side panel", icon: "i-lucide-panel-right", kbds: ["meta", "\\"], onSelect: () => (u.sidePanelOpen.value = !u.sidePanelOpen.value) },
				],
			});
			const bySource = new Map<string, CommandPaletteItem[]>();
			for (const c of s.commands.value) {
				if (c.name === "ompi") continue;
				const item: CommandPaletteItem = {
					label: `/${c.name}`,
					description: c.description,
					icon: "i-lucide-terminal",
					...(c.subcommands?.length
						? { children: c.subcommands.map(sc => ({ label: `/${c.name} ${sc.name}`, description: sc.description, onSelect: () => (sc.usage ? insert(`/${c.name} ${sc.name} `) : void s.prompt(`/${c.name} ${sc.name}`)) })) }
						: { onSelect: () => (c.input?.hint ? insert(`/${c.name} `) : void s.prompt(`/${c.name}`)) }),
				};
				const list = bySource.get(c.source) ?? [];
				list.push(item);
				bySource.set(c.source, list);
			}
			const SOURCE_LABEL: Record<string, string> = { builtin: "Commands", skill: "Skills", extension: "Extensions", custom: "Custom commands", mcp_prompt: "MCP prompts", file: "File commands" };
			for (const [src, items] of bySource) out.push({ id: `cmd-${src}`, label: SOURCE_LABEL[src] ?? src, items });
		}
		out.push({
			id: "app",
			label: "App",
			items: [
				{ label: "Settings", icon: "i-lucide-settings", kbds: ["meta", ","], onSelect: () => tabs.open({ kind: "settings" }) },
				{ label: "Toggle sidebar", icon: "i-lucide-panel-left", kbds: ["meta", "b"], onSelect: () => (u.sidebarCollapsed.value = !u.sidebarCollapsed.value) },
				{ label: "Refresh sessions", icon: "i-lucide-refresh-cw", onSelect: () => void ws.refresh() },
			],
		});
		return out;
	});

	return { groups };
}

export function useTabTitle(tabId: string): string {
	const tabs = useTabs();
	const tab = tabs.tabs.value.find(t => t.id === tabId);
	if (!tab) return "";
	return TAB_KINDS[tab.kind].title(tab, tabs.sessionOf(tab.id));
}
