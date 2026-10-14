<script setup lang="ts">
// Model and tool output is untrusted. Default plugins are off so raw HTML is never parsed
// (the `html` default is the only HTML path); only safe markdown features are re-enabled,
// and the security plugin drops dangerous URL schemes (javascript:, data:text/html, …).
import alert from "@comark/nuxt/plugins/alert";
import security from "@comark/nuxt/plugins/security";
import shiki from "@comark/nuxt/plugins/shiki";
import taskList from "@comark/nuxt/plugins/task-list";

defineProps<{ value: string; streaming?: boolean }>();

const plugins = [alert(), taskList(), shiki(), security()];
const options = { registerDefaultPlugins: false } as const;
</script>

<template>
	<Markdown :value="value" :streaming="streaming" :plugins="plugins" :options="options" class="max-w-none *:first:mt-0 *:last:mb-0" />
</template>
