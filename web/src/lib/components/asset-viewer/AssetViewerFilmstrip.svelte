<script lang="ts">
  import Thumbnail from '$lib/components/assets/thumbnail/Thumbnail.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import type { AssetResponseDto } from '@immich/sdk';
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  export type FilmstripAsset = AssetResponseDto | TimelineAsset;

  interface Props {
    assets: FilmstripAsset[];
    currentAssetId: string;
    onAssetSelect: (asset: FilmstripAsset) => void | Promise<void>;
    onInteract?: () => void;
  }

  let { assets, currentAssetId, onAssetSelect, onInteract }: Props = $props();

  let element = $state<HTMLDivElement>();
  let isInteracting = $state(false);
  let pendingAssetId = $state<string>();
  let selectionPendingAssetId = $state<string>();
  let scrollFrame: number | undefined;
  let scrollEndTimer: ReturnType<typeof setTimeout> | undefined;
  const filmstripPreloadBefore = 12;
  const filmstripPreloadAfter = 24;
  const scrollSettlementDelay = 80;
  const pendingAssetIndex = $derived(assets.findIndex(({ id }) => id === pendingAssetId));

  const getClosestAsset = () => {
    if (!element) {
      return;
    }

    const center = element.getBoundingClientRect().left + element.clientWidth / 2;
    let closest: HTMLElement | undefined;
    let closestDistance = Infinity;

    for (const item of element.querySelectorAll<HTMLElement>('[data-filmstrip-asset]')) {
      const rect = item.getBoundingClientRect();
      const distance = Math.abs(rect.left + rect.width / 2 - center);
      if (distance < closestDistance) {
        closest = item;
        closestDistance = distance;
      }
    }

    const assetId = closest?.dataset.filmstripAsset;
    return assets.find((asset) => asset.id === assetId);
  };

  const settleScroll = () => {
    if (!isInteracting) {
      return;
    }

    isInteracting = false;
    if (scrollEndTimer) {
      clearTimeout(scrollEndTimer);
    }
    scrollEndTimer = undefined;
    if (scrollFrame !== undefined) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    const settledAsset = getClosestAsset();
    if (settledAsset) {
      pendingAssetId = settledAsset.id;
    }
    const asset = assets.find(({ id }) => id === pendingAssetId);
    if (asset && asset.id !== currentAssetId) {
      selectionPendingAssetId = asset.id;
      void Promise.resolve(onAssetSelect(asset)).catch(() => {
        if (selectionPendingAssetId === asset.id) {
          selectionPendingAssetId = undefined;
        }
      });
    }
  };

  const scheduleScrollSettlement = () => {
    if (scrollEndTimer) {
      clearTimeout(scrollEndTimer);
    }
    scrollEndTimer = setTimeout(settleScroll, scrollSettlementDelay);
  };

  const updatePendingAsset = () => {
    onInteract?.();
    if (!isInteracting) {
      return;
    }

    if (scrollFrame !== undefined) {
      return;
    }

    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      const asset = getClosestAsset();
      if (asset) {
        pendingAssetId = asset.id;
      }
    });
    scheduleScrollSettlement();
  };

  const startInteraction = () => {
    if (scrollEndTimer) {
      clearTimeout(scrollEndTimer);
      scrollEndTimer = undefined;
    }
    isInteracting = true;
    onInteract?.();
  };

  const scheduleInteractionEnd = () => {
    scheduleScrollSettlement();
  };

  const selectAsset = (asset: FilmstripAsset) => {
    pendingAssetId = asset.id;
    selectionPendingAssetId = asset.id === currentAssetId ? undefined : asset.id;
    isInteracting = false;
    if (scrollFrame !== undefined) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    if (scrollEndTimer) {
      clearTimeout(scrollEndTimer);
      scrollEndTimer = undefined;
    }
    void onAssetSelect(asset);
  };

  const centerCurrentAsset = (assetId = currentAssetId) => {
    if (!element || isInteracting) {
      return;
    }

    const item = element.querySelector<HTMLElement>(`[data-filmstrip-asset="${CSS.escape(assetId)}"]`);
    if (!item) {
      return;
    }

    const containerCenter = element.getBoundingClientRect().left + element.clientWidth / 2;
    const itemRect = item.getBoundingClientRect();
    if (Math.abs(itemRect.left + itemRect.width / 2 - containerCenter) < 1) {
      return;
    }

    item.scrollIntoView({
      behavior: 'instant',
      block: 'nearest',
      inline: 'center',
    });
  };

  $effect(() => {
    void element;
    void assets;
    const selectionTarget = selectionPendingAssetId;
    if (selectionTarget && selectionTarget !== currentAssetId) {
      pendingAssetId = selectionTarget;
      untrack(() => centerCurrentAsset(selectionTarget));
      return;
    }

    if (selectionTarget === currentAssetId) {
      selectionPendingAssetId = undefined;
    }

    void currentAssetId;
    pendingAssetId = currentAssetId;
    // Position a refreshed timeline window before paint, without restarting native scroll snapping.
    untrack(centerCurrentAsset);
  });

  onDestroy(() => {
    if (scrollFrame !== undefined) {
      cancelAnimationFrame(scrollFrame);
    }
    if (scrollEndTimer) {
      clearTimeout(scrollEndTimer);
    }
  });
</script>

<div
  bind:this={element}
  class="pointer-events-auto absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1rem)] z-20 overflow-x-auto overscroll-x-contain bg-black/45 py-2 backdrop-blur-sm md:hidden"
  style="scroll-snap-type: x proximity; scrollbar-width: none;"
  role="listbox"
  tabindex="0"
  aria-label={$t('photos')}
  onpointerdown={startInteraction}
  onpointerup={scheduleInteractionEnd}
  onpointercancel={scheduleInteractionEnd}
  onwheel={startInteraction}
  onscroll={updatePendingAsset}
  onscrollend={settleScroll}
>
  <div class="flex w-max gap-1" style="padding-inline: calc(50vw - 28px);">
    {#each assets as asset, index (asset.id)}
      {@const timelineAsset = toTimelineAsset(asset)}
      {@const selected = asset.id === pendingAssetId}
      {@const distanceFromPending = index - pendingAssetIndex}
      {@const preload =
        pendingAssetIndex >= 0 &&
        distanceFromPending >= -filmstripPreloadBefore &&
        distanceFromPending <= filmstripPreloadAfter}
      <div
        class="relative size-14 shrink-0 snap-center overflow-hidden rounded-sm"
        data-filmstrip-asset={asset.id}
        role="option"
        aria-selected={selected}
      >
        <Thumbnail
          asset={timelineAsset}
          readonly
          {preload}
          thumbnailSize={56}
          dimmed={!selected}
          imageClass={selected ? 'ring-2 ring-white ring-offset-1 ring-offset-black' : 'opacity-75'}
          onClick={() => selectAsset(asset)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  div::-webkit-scrollbar {
    display: none;
  }
</style>
