// Workspaces (folders ompi runs sessions in) and the session index read from omp's store.
// Workspaces are the union of project folders found in the store and folders the user added.
import { load } from "@tauri-apps/plugin-store";
import type { Store } from "@tauri-apps/plugin-store";
import { computed, ref, shallowRef } from "vue";
import type { ComputedRef, Ref, ShallowRef } from "vue";
import { host } from "~/utils/omp/host";
import type { OmpInfo, Scope, SessionMeta } from "~/utils/omp/types";

export interface WorkspacePrefs {
	scope: Scope;
	model?: string;
	extraDirs: string[];
	/** Per-tool approval overrides, e.g. "Always allow bash in this workspace". */
	rules?: Record<string, "allow" | "prompt" | "deny">;
}

export interface Workspace {
	/** Stable id derived from the folder path; used for overlay file names. */
	id: string;
	path: string;
	name: string;
	prefs: WorkspacePrefs;
	sessions: SessionMeta[];
	added: boolean;
}

export interface Workspaces {
	omp: Ref<OmpInfo | undefined>;
	ompError: Ref<string | undefined>;
	sessions: ShallowRef<SessionMeta[]>;
	workspaces: ComputedRef<Workspace[]>;
	loading: Ref<boolean>;
	refresh(): Promise<void>;
	addFolder(path: string): Promise<Workspace>;
	removeFolder(path: string): Promise<void>;
	setPrefs(path: string, prefs: Partial<WorkspacePrefs>): Promise<void>;
	byPath(path: string): Workspace | undefined;
	sessionByFile(file: string): SessionMeta | undefined;
	deleteSession(file: string): Promise<void>;
}

const DEFAULT_PREFS: WorkspacePrefs = { scope: "write", extraDirs: [] };

/** FNV-1a: a short, stable, filename-safe id for a folder path. */
export function workspaceId(path: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < path.length; i++) {
		h ^= path.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `w${(h >>> 0).toString(36)}`;
}

let shared: Workspaces | undefined;

export function useWorkspaces(): Workspaces {
	if (shared) return shared;
	const omp = ref<OmpInfo>();
	const ompError = ref<string>();
	const sessions = shallowRef<SessionMeta[]>([]);
	const added = ref<string[]>([]);
	const prefs = ref<Record<string, WorkspacePrefs>>({});
	const loading = ref(true);
	let store: Store | undefined;

	const workspaces = computed<Workspace[]>(() => {
		const byPath = new Map<string, SessionMeta[]>();
		for (const s of sessions.value) {
			const list = byPath.get(s.cwd);
			if (list) list.push(s);
			else byPath.set(s.cwd, [s]);
		}
		for (const p of added.value) if (!byPath.has(p)) byPath.set(p, []);
		return [...byPath.entries()]
			.map(([path, list]) => ({
				id: workspaceId(path),
				path,
				name: path.split("/").filter(Boolean).at(-1) ?? path,
				prefs: { ...DEFAULT_PREFS, ...prefs.value[path] },
				sessions: list,
				added: added.value.includes(path),
			}))
			// Temp dirs omp falls back to outside a project aren't useful workspaces.
			.filter(w => w.added || !/^\/(private\/)?(tmp|var\/folders)\//.test(w.path))
			.sort((a, b) => (b.sessions[0]?.modifiedMs ?? 0) - (a.sessions[0]?.modifiedMs ?? 0) || a.name.localeCompare(b.name));
	});

	async function persist(): Promise<void> {
		store ??= await load("workspaces.json", { autoSave: false, defaults: {} });
		await store.set("added", added.value);
		await store.set("prefs", prefs.value);
		await store.save();
	}

	async function refresh(): Promise<void> {
		loading.value = true;
		try {
			if (!omp.value) omp.value = await host.ompInfo();
			ompError.value = undefined;
			sessions.value = await host.sessionList();
		} catch (e) {
			ompError.value = e instanceof Error ? e.message : String(e);
		} finally {
			loading.value = false;
		}
	}

	shared = {
		omp,
		ompError,
		sessions,
		workspaces,
		loading,
		refresh,
		async addFolder(path) {
			if (!added.value.includes(path)) added.value = [...added.value, path];
			await persist();
			return workspaces.value.find(w => w.path === path)!;
		},
		async removeFolder(path) {
			added.value = added.value.filter(p => p !== path);
			await persist();
		},
		async setPrefs(path, next) {
			prefs.value = { ...prefs.value, [path]: { ...DEFAULT_PREFS, ...prefs.value[path], ...next } };
			await persist();
		},
		byPath: path => workspaces.value.find(w => w.path === path),
		sessionByFile: file => sessions.value.find(s => s.file === file),
		async deleteSession(file) {
			await host.deleteSession(file);
			sessions.value = sessions.value.filter(s => s.file !== file);
		},
	};

	void (async () => {
		store = await load("workspaces.json", { autoSave: false, defaults: {} });
		added.value = (await store.get<string[]>("added")) ?? [];
		prefs.value = (await store.get<Record<string, WorkspacePrefs>>("prefs")) ?? {};
		await refresh();
	})();
	return shared;
}
