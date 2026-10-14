// Thin typed wrapper over the Rust session host commands.
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";
import type { HostStatus, OmpInfo, Scope, SessionMeta } from "./types";

export interface OpenArgs {
	cwd: string;
	resume?: string;
	model?: string;
	extraDirs?: string[];
	workspaceId: string;
	runKey: string;
	scope: Scope;
	planning?: boolean;
}

export type Policy = "allow" | "prompt" | "deny";

const Response = z.object({ success: z.boolean(), command: z.string(), data: z.unknown().optional(), error: z.string().optional() });

export const host = {
	ompInfo: () => invoke<OmpInfo>("omp_info"),
	sessionList: () => invoke<SessionMeta[]>("session_list"),
	open: (args: OpenArgs) => invoke<number>("session_open", { args }),
	close: (handle: number) => invoke<void>("session_close", { handle }),
	status: (handle: number) => invoke<HostStatus | null>("session_status", { handle }),
	detach: (handle: number) => invoke<void>("session_detach", { handle }),
	refreshFile: (handle: number) => invoke<void>("session_refresh_file", { handle }),
	deleteSession: (file: string) => invoke<void>("session_delete", { file }),
	readPlan: (file: string, slug: string) => invoke<string>("plan_read", { file, slug }),
	setScope: (runKey: string, scope: Scope, planning: boolean) => invoke<void>("scope_set", { runKey, scope, planning }),
	setWorkspaceRules: (workspaceId: string, rules: Record<string, Policy>) => invoke<void>("workspace_rules_set", { workspaceId, rules }),

	/** Fire-and-forget frame; replies arrive on the attached channel. */
	send: (handle: number, frame: object) => invoke<void>("session_send", { handle, frame: JSON.stringify(frame) }),

	/** Request/response: Rust assigns the id. Resolves with `data`, throws omp's error. */
	async request<T = unknown>(handle: number, command: object, schema?: z.ZodType<T>): Promise<T> {
		const raw: unknown = await invoke("session_request", { handle, command: JSON.stringify(command) });
		const r = Response.parse(raw);
		if (!r.success) throw new Error(r.error ?? `${r.command} failed`);
		return schema ? schema.parse(r.data) : (r.data as T);
	},

	attach(handle: number, onFrame: (raw: unknown) => void): Promise<void> {
		const channel = new Channel<unknown>();
		channel.onmessage = onFrame;
		return invoke<void>("session_attach", { handle, channel });
	},

	onStatus: (fn: (s: HostStatus) => void): Promise<UnlistenFn> => listen<HostStatus>("omp:status", e => fn(e.payload)),
};
