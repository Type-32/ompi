<script setup lang="ts">
// Prompt box: Enter sends (steers while streaming), ⌘Enter queues a follow-up, Esc aborts.
// `/` autocompletes slash commands; TUI-only commands map to ompi features or are refused.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import type { Session } from "~/composables/useSession";
import type { ImageBlock, SlashCommand } from "~/utils/omp/schema";

const props = defineProps<{ session: Session }>();
const emit = defineEmits<{ openModels: []; tuiCommand: [name: string, args: string] }>();
const ui = useUi();
const drop = useDropRouter();
const toast = useToast();

const text = ref("");
const files = ref<string[]>([]);
const images = ref<ImageBlock[]>([]);
const selected = ref(0);
const root = useTemplateRef<HTMLElement>("root");
const prompt = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>("prompt");

/** TUI-only builtins: these never run over RPC, so ompi handles or refuses them. */
const TUI_ONLY = new Set([
	"agents", "branch", "rewind", "btw", "cleanse", "clear", "collab", "copy", "debug", "delete", "exit", "extensions", "fork", "git", "goal",
	"guided-goal", "hotkeys", "hub", "join", "leave", "live", "login", "logout", "loop", "new", "omfg", "open", "pause", "plan", "plan-review",
	"queue", "quit", "q", "record", "restart", "resume", "settings", "setup", "providers", "skills", "tan", "tree", "vibe", "status",
]);

const slash = computed(() => {
	const m = /^\/(\S*)$/.exec(text.value);
	if (!m) return undefined;
	const q = m[1]!.toLowerCase();
	const native: SlashCommand[] = [
		{ name: "plan", source: "ompi", description: "Toggle plan mode" },
		{ name: "new", source: "ompi", description: "New session in this workspace" },
		{ name: "fork", source: "ompi", description: "Fork this session" },
		{ name: "tree", source: "ompi", description: "Show the context graph" },
	];
	return [...native, ...props.session.commands.value.filter(c => c.name !== "ompi")]
		.filter(c => c.name.toLowerCase().startsWith(q) || c.aliases?.some(a => a.startsWith(q)))
		.slice(0, 12);
});
watch(slash, () => (selected.value = 0));

const queued = computed(() => {
	const q = props.session.state.value?.queuedMessages;
	return [...(q?.steering ?? []).map(m => ({ m, queue: "steering" as const })), ...(q?.followUp ?? []).map(m => ({ m, queue: "followUp" as const }))];
});

const mention = (p: string) => (/[\s"']/.test(p) ? `@"${p.replaceAll('"', "")}"` : `@${p}`);

function compose(): string {
	const cwd = props.session.target.cwd.replace(/\/$/, "");
	const paths = files.value.map(f => (f.startsWith(`${cwd}/`) ? f.slice(cwd.length + 1) : f));
	return [text.value.trim(), paths.map(mention).join(" ")].filter(Boolean).join("\n\n");
}

async function send(mode: "send" | "followUp") {
	const s = props.session;
	const raw = text.value.trim();
	const cmd = /^\/(\S+)\s*([\s\S]*)$/.exec(raw);
	if (cmd && !files.value.length && !images.value.length) {
		const [, name, args] = cmd;
		if (name === "ompi" || TUI_ONLY.has(name!)) {
			emit("tuiCommand", name!, args!.trim());
			text.value = "";
			return;
		}
	}
	const message = compose();
	if (!message && !images.value.length) return;
	const imgs = images.value;
	text.value = "";
	files.value = [];
	images.value = [];
	try {
		if (mode === "followUp" && s.streaming.value) await s.followUp(message);
		else await s.prompt(message, imgs);
	} catch (e) {
		text.value = raw;
		toast.add({ title: "Couldn't send", description: e instanceof Error ? e.message : String(e), color: "error" });
	}
}

function onKeydown(e: KeyboardEvent) {
	const list = slash.value;
	if (list?.length) {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			selected.value = (selected.value + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length;
			return;
		}
		if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.metaKey)) {
			e.preventDefault();
			const c = list[selected.value]!;
			const needsArgs = !!c.input?.hint || !!c.subcommands?.length;
			text.value = `/${c.name}${needsArgs || e.key === "Tab" ? " " : ""}`;
			if (!needsArgs && e.key === "Enter") void send("send");
			return;
		}
	}
	if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
		e.preventDefault();
		void send(e.metaKey || e.ctrlKey ? "followUp" : "send");
	} else if (e.key === "Escape" && props.session.streaming.value) {
		e.preventDefault();
		void props.session.abort();
	}
}

async function attach() {
	const picked = await openDialog({ multiple: true, directory: false, title: "Attach files" });
	if (Array.isArray(picked)) files.value = [...new Set([...files.value, ...picked])];
	else if (typeof picked === "string") files.value = [...new Set([...files.value, picked])];
}

async function onPaste(e: ClipboardEvent) {
	const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith("image/"));
	if (!item) return;
	e.preventDefault();
	const file = item.getAsFile();
	if (file) {
		const data = btoa(String.fromCodePoint(...new Uint8Array(await file.arrayBuffer())));
		images.value = [...images.value, { type: "image", data, mimeType: file.type }];
		return;
	}
	// WebKit sometimes exposes pasted screenshots only through the native clipboard.
	try {
		const img = await readImage();
		const { width, height } = await img.size();
		const rgba = await img.rgba();
		const canvas = new OffscreenCanvas(width, height);
		canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
		const blob = await canvas.convertToBlob({ type: "image/png" });
		const data = btoa(String.fromCodePoint(...new Uint8Array(await blob.arrayBuffer())));
		images.value = [...images.value, { type: "image", data, mimeType: "image/png" }];
	} catch {
		/* not an image after all */
	}
}

watch(
	() => ui.composerInsert.value,
	v => {
		if (!v) return;
		text.value = v.text;
		prompt.value?.textareaRef?.focus();
	},
);

let unregister: (() => void) | undefined;
onMounted(() => {
	unregister = drop.register({
		el: () => root.value,
		priority: 10,
		onDrop: paths => (files.value = [...new Set([...files.value, ...paths])]),
	});
	prompt.value?.textareaRef?.focus();
});
onBeforeUnmount(() => unregister?.());

defineExpose({ focus: () => prompt.value?.textareaRef?.focus() });

const status = computed(() => (props.session.streaming.value ? "streaming" : "ready"));
const placeholder = computed(() =>
	props.session.planning.value ? "Describe what to plan…" : props.session.streaming.value ? "Steer the current turn (⌘↵ queues a follow-up)…" : "Ask omp to do something…",
);
</script>

<template>
	<div ref="root" class="relative" :class="{ 'rounded-xl ring-2 ring-primary': drop.hovered.value?.priority === 10 }">
		<div v-if="slash?.length" class="absolute bottom-full z-10 mb-2 max-h-80 w-full overflow-y-auto rounded-lg border border-default bg-default p-1 shadow-lg">
			<button
				v-for="(c, i) in slash"
				:key="`${c.source}:${c.name}`"
				type="button"
				class="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm"
				:class="i === selected ? 'bg-elevated' : ''"
				@mouseenter="selected = i"
				@click="text = `/${c.name} `; prompt?.textareaRef?.focus()"
			>
				<span class="font-mono text-highlighted">/{{ c.name }}</span>
				<span v-if="c.input?.hint" class="font-mono text-xs text-dimmed">{{ c.input.hint }}</span>
				<span class="min-w-0 flex-1 truncate text-muted">{{ c.description }}</span>
				<UBadge :label="c.source" size="sm" variant="subtle" color="neutral" />
			</button>
		</div>

		<div v-if="queued.length" class="mb-2 flex flex-col gap-1">
			<div v-for="q in queued" :key="q.queue + q.m" class="flex items-center gap-2 rounded-md bg-elevated px-3 py-1 text-sm">
				<UIcon :name="q.queue === 'steering' ? 'i-lucide-corner-down-right' : 'i-lucide-list-end'" class="size-4 text-muted" />
				<span class="min-w-0 flex-1 truncate">{{ q.m }}</span>
				<span class="text-xs text-dimmed">{{ q.queue === "steering" ? "steering" : "after this turn" }}</span>
				<UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove" @click="session.removeQueued(q.m, q.queue)" />
			</div>
		</div>

		<UChatPrompt ref="prompt" v-model="text" :placeholder="placeholder" :submit-on-enter="false" variant="subtle" :rows="2" @keydown="onKeydown" @paste="onPaste">
			<template #header>
				<div v-if="files.length || images.length" class="flex flex-wrap gap-1">
					<UBadge v-for="f in files" :key="f" :label="f.split('/').at(-1)" :title="f" icon="i-lucide-paperclip" color="neutral" variant="outline">
						<template #trailing><UButton icon="i-lucide-x" size="xs" color="neutral" variant="link" class="-me-1 p-0" aria-label="Remove" @click="files = files.filter(x => x !== f)" /></template>
					</UBadge>
					<div v-for="(img, i) in images" :key="i" class="relative">
						<img :src="`data:${img.mimeType};base64,${img.data}`" class="h-12 rounded border border-default" alt="Pasted image" />
						<UButton icon="i-lucide-x" size="xs" color="neutral" variant="solid" class="absolute -top-1.5 -right-1.5 rounded-full p-0.5" aria-label="Remove image" @click="images = images.filter((_, j) => j !== i)" />
					</div>
				</div>
			</template>
			<UChatPromptSubmit :status="status" :disabled="!text.trim() && !files.length && !images.length && !session.streaming.value" @stop="session.abort()" @click.prevent="send('send')" />
			<template #footer>
				<SessionControls :session="session" @open-models="emit('openModels')" @attach="attach" />
			</template>
		</UChatPrompt>
	</div>
</template>
