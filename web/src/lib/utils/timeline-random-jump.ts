import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';

type RandomTimeline = Pick<TimelineManager, 'assetCount' | 'getRandomAsset'>;

/** Sample the entire filtered timeline, avoiding the previous target when another item exists. */
export async function pickRandomTimelineAsset(
  timeline: RandomTimeline,
  previousAssetId: string | null | undefined,
  isCurrent: () => boolean,
) {
  const count = timeline.assetCount;
  if (count === 0 || !isCurrent()) {
    return;
  }

  const index = Math.floor(Math.random() * count);
  const asset = await timeline.getRandomAsset(index);
  if (!isCurrent()) {
    return;
  }
  if (!asset || asset.id !== previousAssetId || count === 1) {
    return asset;
  }

  // Pick uniformly from the other indices instead of repeatedly drawing the same asset.
  const nextIndex = Math.floor(Math.random() * (count - 1));
  return timeline.getRandomAsset(nextIndex >= index ? nextIndex + 1 : nextIndex);
}
