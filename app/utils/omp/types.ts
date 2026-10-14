// Shapes produced by ompi's own Rust host (trusted, typed by serde) and by the bridge.
// Data that comes from omp itself is parsed in `schema.ts` / `frames.ts`.

export type Phase = "starting" | "idle" | "streaming" | "exited";
export type Scope = "always-ask" | "write" | "yolo";

export interface OmpInfo {
	path: string;
	version: string;
	agentDir: string;
	supported: boolean;
}

export interface SessionMeta {
	file: string;
	id: string;
	cwd: string;
	title: string | null;
	created: string;
	modifiedMs: number;
	parentSession: string | null;
}

export interface HostStatus {
	handle: number;
	phase: Phase;
	needsInput: boolean;
	sessionFile: string | null;
	exit: string | null;
}

export interface BridgeCapabilities {
	plan: boolean;
	goto: boolean;
	editAssistant: boolean;
	label: boolean;
	context: boolean;
}

export interface ContextBreakdown {
	contextWindow: number;
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	categories: { label: string; tokens: number }[];
	unavailable?: string;
}
