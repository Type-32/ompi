// Tabs: `{ id, kind, params }`. A kind is an entry in the registry below; adding a tab kind
// means adding one entry. Session tabs own a live `Session` (kept here, not in components,
// so switching tabs never restarts omp).
import { load } from "@tauri-apps/plugin-store";
import type { Store } from "@tauri-apps/plugin-store";
import type { Component } from "vue";
import { computed, defineAsyncComponent, markRaw, ref, shallowReactive } from "vue";
import type { ComputedRef, Ref } from "vue";
import { host } from "~/utils/omp/host";
import type { HostStatus } from "~/utils/omp/types";
import { createSession } from "./useSession";
import type { Session, SessionTarget } from "./useSession";
import { useWorkspaces } from "./useWorkspaces";

export type TabParams =
	| { kind: "empty" }
	| { kind: "session"; target: SessionTarget }
	| { kind: "settings" };

export type Tab = { id: string } & TabParams;

export interface TabKind {
	component: Component;
	title(tab: Tab, session?: Session): string;
	icon(tab: Tab, session?: Session): string;
}

export const TAB_KINDS: Record<TabParams["kind"], TabKind> = {
	empty: {
		component: markRaw(defineAsyncComponent(() => import("~/components/tabs/EmptyTab.vue"))),
		title: () => "New tab",
		icon: () => "i-lucide-square-plus",
	},
	session: {
		component: markRaw(defineAsyncComponent(() => import("~/components/tabs/SessionTab.vue"))),
		title(tab, session) {
			const name = session?.state.value?.sessionName;
			if (name) return name;
			if (tab.kind !== "session") return "Session";
			const meta = tab.target.file ? useWorkspaces().sessionByFile(tab.target.file) : undefined;
			return meta?.title ?? (tab.target.file ? "Untitled session" : "New session");
		},
		icon: () => "i-lucide-message-square",
	},
	settings: {
		component: markRaw(defineAsyncComponent(() => import("~/components/tabs/SettingsTab.vue"))),
		title: () => "Settings",
		icon: () => "i-lucide-settings",
	},
};

export interface Tabs {
	tabs: Ref<Tab[]>;
	activeId: Ref<string | undefined>;
	active: ComputedRef<Tab | undefined>;
	activeSession: ComputedRef<Session | undefined>;
	sessionOf(tabId: string): Session | undefined;
	statusOf(tabId: string): { streaming: boolean; needsInput: boolean; planning: boolean; exited: boolean };
	open(params: TabParams, opts?: { replace?: string; background?: boolean }): string;
	openSession(target: SessionTarget, opts?: { inActiveIfEmpty?: boolean }): string;
	close(id: string): Promise<void>;
	reopenClosed(): void;
	activate(id: string): void;
	move(from: number, to: number): void;
	cycle(step: 1 | -1): void;
}

let shared: Tabs | undefined;

export function useTabs(): Tabs {
	if (shared) return shared;
	const tabs = ref<Tab[]>([]);
	const activeId = ref<string>();
	const sessions = shallowReactive(new Map<string, Session>());
	const closed: TabParams[] = [];
	let store: Store | undefined;
	let restored = false;

	const active = computed(() => tabs.value.find(t => t.id === activeId.value));

	function ensureSession(tab: Tab): Session | undefined {
		if (tab.kind !== "session") return undefined;
		let s = sessions.get(tab.id);
		if (!s) {
			const ws = useWorkspaces().byPath(tab.target.cwd);
			s = createSession(tab.target, ws?.prefs.scope ?? "write", tab.id);
			sessions.set(tab.id, s);
		}
		return s;
	}

	async function persist(): Promise<void> {
		if (!restored) return;
		store ??= await load("tabs.json", { autoSave: false, defaults: {} });
		// A session tab is persisted by its file, so it resumes the same session after restart.
		const saved = tabs.value.map(t => {
			if (t.kind !== "session") return t;
			const file = sessions.get(t.id)?.sessionFile.value ?? t.target.file;
			return file ? { ...t, target: { ...t.target, file } } : { id: t.id, kind: "empty" as const };
		});
		await store.set("tabs", saved);
		await store.set("active", activeId.value);
		await store.save();
	}

	function activate(id: string): void {
		activeId.value = id;
		const tab = tabs.value.find(t => t.id === id);
		if (tab) void ensureSession(tab)?.ensureRunning();
		void persist();
	}

	function open(params: TabParams, opts: { replace?: string; background?: boolean } = {}): string {
		const id = opts.replace ?? crypto.randomUUID();
		const tab: Tab = { id, ...params };
		if (opts.replace) {
			const old = sessions.get(opts.replace);
			if (old) {
				void old.stop();
				sessions.delete(opts.replace);
			}
			tabs.value = tabs.value.map(t => (t.id === opts.replace ? tab : t));
		} else {
			const at = tabs.value.findIndex(t => t.id === activeId.value);
			const next = [...tabs.value];
			next.splice(at < 0 ? next.length : at + 1, 0, tab);
			tabs.value = next;
		}
		if (!opts.background) activate(id);
		else void persist();
		return id;
	}

	host.onStatus((s: HostStatus) => {
		for (const sess of sessions.values()) sess.onStatus(s);
		void persist();
	});

	shared = {
		tabs,
		activeId,
		active,
		activeSession: computed(() => (active.value ? sessions.get(active.value.id) : undefined)),
		sessionOf: id => sessions.get(id),
		statusOf(id) {
			const s = sessions.get(id);
			return {
				streaming: s?.streaming.value ?? false,
				needsInput: (s?.dialogs.value.length ?? 0) > 0 || !!s?.pendingPlan.value,
				planning: s?.planning.value ?? false,
				exited: s?.phase.value === "exited" && !!s.exit.value,
			};
		},
		open,
		openSession(target, { inActiveIfEmpty = true } = {}) {
			if (target.file) {
				const existing = tabs.value.find(t => t.kind === "session" && (sessions.get(t.id)?.sessionFile.value ?? t.target.file) === target.file);
				if (existing) {
					activate(existing.id);
					return existing.id;
				}
			}
			const replace = inActiveIfEmpty && active.value?.kind === "empty" ? active.value.id : undefined;
			return open({ kind: "session", target }, { replace });
		},
		async close(id) {
			const i = tabs.value.findIndex(t => t.id === id);
			if (i < 0) return;
			const tab = tabs.value[i]!;
			const s = sessions.get(id);
			const file = s?.sessionFile.value;
			closed.push(tab.kind === "session" && file ? { kind: "session", target: { ...tab.target, file } } : { kind: tab.kind === "session" ? "empty" : tab.kind } as TabParams);
			// Drop the tab first so the UI moves on at once; omp's clean shutdown can take seconds.
			if (s) sessions.delete(id);
			tabs.value = tabs.value.filter(t => t.id !== id);
			if (activeId.value === id) {
				const next = tabs.value[Math.min(i, tabs.value.length - 1)];
				if (next) activate(next.id);
				else open({ kind: "empty" });
			}
			void persist();
			await s?.stop();
		},
		reopenClosed() {
			const p = closed.pop();
			if (p) open(p);
		},
		activate,
		move(from, to) {
			const next = [...tabs.value];
			const [t] = next.splice(from, 1);
			if (!t) return;
			next.splice(to, 0, t);
			tabs.value = next;
			void persist();
		},
		cycle(step) {
			const n = tabs.value.length;
			if (n === 0) return;
			const i = tabs.value.findIndex(t => t.id === activeId.value);
			activate(tabs.value[(i + step + n) % n]!.id);
		},
	};

	void (async () => {
		store = await load("tabs.json", { autoSave: false, defaults: {} });
		const saved = (await store.get<Tab[]>("tabs")) ?? [];
		tabs.value = saved.length ? saved : [{ id: crypto.randomUUID(), kind: "empty" }];
		restored = true;
		const want = await store.get<string>("active");
		activate(tabs.value.some(t => t.id === want) ? want! : tabs.value[0]!.id);
	})();
	return shared;
}
