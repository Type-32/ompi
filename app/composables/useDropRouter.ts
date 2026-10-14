// Tauri delivers native file drops to the webview as paths with a physical position.
// Zones register an element and a handler; a drop goes to the innermost zone under the cursor.
import { ref } from "vue";
import type { Ref } from "vue";
import type { DragDropEvent } from "@tauri-apps/api/webview";

export interface DropZone {
	el: () => HTMLElement | null | undefined;
	onDrop(paths: string[]): void;
	/** Larger wins when zones overlap (composer over sidebar over window). */
	priority: number;
}

export interface DropRouter {
	/** Zone currently under a drag, for highlighting. */
	hovered: Ref<DropZone | undefined>;
	dragging: Ref<boolean>;
	register(zone: DropZone): () => void;
	dispatch(e: DragDropEvent): void;
}

let shared: DropRouter | undefined;

export function useDropRouter(): DropRouter {
	if (shared) return shared;
	const zones = new Set<DropZone>();
	const hovered = ref<DropZone>();
	const dragging = ref(false);

	const zoneAt = (x: number, y: number): DropZone | undefined => {
		let best: DropZone | undefined;
		for (const z of zones) {
			const r = z.el()?.getBoundingClientRect();
			if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
			if (!best || z.priority > best.priority) best = z;
		}
		return best;
	};

	shared = {
		hovered,
		dragging,
		register(zone) {
			zones.add(zone);
			return () => zones.delete(zone);
		},
		dispatch(e) {
			if (e.type === "leave") {
				dragging.value = false;
				hovered.value = undefined;
				return;
			}
			// Positions are physical pixels; element rects are CSS pixels.
			const scale = window.devicePixelRatio || 1;
			const zone = zoneAt(e.position.x / scale, e.position.y / scale);
			if (e.type === "drop") {
				dragging.value = false;
				hovered.value = undefined;
				if (zone && e.paths.length) zone.onDrop(e.paths);
				return;
			}
			dragging.value = true;
			hovered.value = zone;
		},
	};
	return shared;
}
