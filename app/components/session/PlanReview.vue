<script setup lang="ts">
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ref, watch } from "vue";
import type { ApproveMode, Session } from "~/composables/useSession";

const props = defineProps<{ session: Session }>();
const toast = useToast();

const plan = ref<string>();
const error = ref<string>();
const comments = ref("");
const working = ref(false);

watch(
	() => props.session.pendingPlan.value?.planFilePath,
	async p => {
		plan.value = undefined;
		error.value = undefined;
		if (!p) return;
		try {
			plan.value = await props.session.readPendingPlan();
		} catch (e) {
			error.value = e instanceof Error ? e.message : String(e);
		}
	},
	{ immediate: true },
);

async function run(what: string, fn: () => Promise<void>) {
	working.value = true;
	try {
		await fn();
	} catch (e) {
		toast.add({ title: `Couldn't ${what}`, description: e instanceof Error ? e.message : String(e), color: "error" });
	} finally {
		working.value = false;
	}
}

const approve = (mode: ApproveMode) => run("approve the plan", () => props.session.approvePlan(mode));

function refine() {
	const note = comments.value.trim() || "Refine the plan.";
	comments.value = "";
	props.session.pendingPlan.value = undefined;
	void run("send your comments", () => props.session.prompt(note));
}

async function saveAs() {
	const title = props.session.pendingPlan.value?.title ?? "plan";
	const path = await save({ title: "Save plan", defaultPath: `${title.replace(/[^\w-]+/g, "-")}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
	if (!path || !plan.value) return;
	await run("save the plan", async () => {
		await invoke("plan_save", { path, content: plan.value });
		await props.session.setPlanning(false);
		toast.add({ title: "Plan saved", description: path, icon: "i-lucide-check" });
	});
}
</script>

<template>
	<UCard :ui="{ root: 'ring-1 ring-info/50', header: 'flex items-center gap-2', body: 'max-h-[55vh] overflow-y-auto' }">
		<template #header>
			<UIcon name="i-lucide-map" class="size-5 text-info" />
			<h3 class="font-semibold text-highlighted">Review plan: {{ session.pendingPlan.value?.title ?? "plan" }}</h3>
		</template>
		<UAlert v-if="error" color="error" variant="subtle" :description="error" />
		<OmpMarkdown v-else-if="plan" :value="plan" />
		<USkeleton v-else class="h-32 w-full" />
		<template #footer>
			<div class="flex flex-col gap-2">
				<UTextarea v-model="comments" placeholder="Comments for a revised plan (optional)" :rows="2" autoresize />
				<div class="flex flex-wrap items-center gap-2">
					<UButton label="Approve" icon="i-lucide-check" :loading="working" :disabled="!plan" @click="approve('here')" />
					<UDropdownMenu
						:items="[
							{ label: 'Approve in new session', description: 'Fresh context with only the plan', icon: 'i-lucide-square-plus', onSelect: () => approve('new') },
							{ label: 'Approve & compact', description: 'Summarise this discussion, then implement', icon: 'i-lucide-shrink', onSelect: () => approve('compact') },
						]"
					>
						<UButton icon="i-lucide-chevron-down" color="primary" variant="soft" :disabled="!plan || working" aria-label="More approval options" />
					</UDropdownMenu>
					<UButton label="Refine" icon="i-lucide-message-square-reply" color="neutral" variant="outline" :disabled="working" @click="refine" />
					<UButton label="Save plan…" icon="i-lucide-save" color="neutral" variant="ghost" :disabled="!plan || working" @click="saveAs" />
				</div>
			</div>
		</template>
	</UCard>
</template>
