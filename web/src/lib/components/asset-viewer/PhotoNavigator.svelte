<script lang="ts">
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { navigatorViewport, panToNavigatorPoint } from '$lib/utils/zoom-geometry';
  import { scaleToFit, type Size } from '$lib/utils/container-utils';
  import { swapsDimensions } from '$lib/utils/zoom-geometry';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import { onDestroy } from 'svelte';

  let {
    image,
    viewport,
    src,
    limited,
    onRetry,
    onResetFocus,
  }: {
    image: Size;
    viewport: Size;
    src: string;
    limited: boolean;
    onRetry: () => void;
    onResetFocus: () => void;
  } = $props();
  const zoomState = $derived(assetViewerManager.zoomState);
  const rotation = $derived(zoomState.currentRotation);
  const swapped = $derived(swapsDimensions(rotation));
  const orientedImage = $derived(swapped ? { width: image.height, height: image.width } : image);
  const size = $derived(
    scaleToFit(orientedImage, {
      width: mediaQueryManager.pointerCoarse ? 128 : 200,
      height: Math.max(40, Math.min(180, viewport.height * 0.32)),
    }),
  );
  const frame = $derived(navigatorViewport(image, viewport, zoomState));
  const quality = $derived(assetViewerManager.imageLoaderStatus?.quality.original);
  const failed = $derived(quality === 'error');
  const loading = $derived(!limited && quality !== 'success' && !failed);
  let showExplanation = $state(false);
  let focusWithin = false;
  let panel = $state<HTMLElement>();
  let navigationImage = $state<HTMLButtonElement>();
  let drag = $state<{ pointerId: number; dx: number; dy: number }>();

  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId || !navigationImage) {
      return;
    }
    const rect = navigationImage.getBoundingClientRect();
    assetViewerManager.cancelZoomAnimation();
    assetViewerManager.zoomState = panToNavigatorPoint(
      image,
      viewport,
      zoomState,
      (event.clientX - rect.left) / rect.width + drag.dx,
      (event.clientY - rect.top) / rect.height + drag.dy,
    );
  };
  const start = (event: PointerEvent) => {
    if (event.button !== 0 || drag || !navigationImage) {
      return;
    }
    event.preventDefault();
    const rect = navigationImage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    const inside = x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height;
    drag = {
      pointerId: event.pointerId,
      dx: inside ? frame.x + frame.width / 2 - x : 0,
      dy: inside ? frame.y + frame.height / 2 - y : 0,
    };
    navigationImage.setPointerCapture(event.pointerId);
    move(event);
  };
  const end = (event: PointerEvent) => {
    if (drag?.pointerId !== event.pointerId) {
      return;
    }

    drag = undefined;
    if (navigationImage?.hasPointerCapture(event.pointerId)) {
      navigationImage.releasePointerCapture(event.pointerId);
    }
  };
  const keyPan = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.2 : 0.05;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    if (!dx && !dy) {
      return;
    }
    event.preventDefault();
    assetViewerManager.cancelZoomAnimation();
    assetViewerManager.zoomState = panToNavigatorPoint(
      image,
      viewport,
      zoomState,
      frame.x + frame.width / 2 + dx,
      frame.y + frame.height / 2 + dy,
    );
  };
  const outside = (event: PointerEvent) => {
    if (!panel?.contains(event.target as Node)) {
      showExplanation = false;
    }
  };
  onDestroy(() => {
    if (focusWithin || panel?.contains(document.activeElement)) {
      onResetFocus();
    }
  });
</script>

<svelte:document onpointerdown={outside} />

<div
  role="toolbar"
  tabindex="-1"
  bind:this={panel}
  data-overlay-interactive
  aria-label={$t('photo_navigator')}
  class="absolute inset-e-4 top-20 z-30 max-h-[calc(100%-6rem)] overflow-y-auto rounded-lg border border-white/20 bg-black/75 p-2 text-white shadow-lg backdrop-blur-sm"
  style:width="{(mediaQueryManager.pointerCoarse ? 128 : 200) + 16}px"
  transition:fade={{ duration: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 150 }}
  onfocusin={() => {
    focusWithin = true;
  }}
  onfocusout={(event) => {
    if (event.relatedTarget && !panel?.contains(event.relatedTarget as Node)) {
      focusWithin = false;
    }
  }}
  onwheel={(event) => event.stopPropagation()}
  ondblclick={(event) => event.stopPropagation()}
  onkeydown={(event) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.stopPropagation();
    }
    if (!(event.key === 'Escape' && showExplanation)) {
      return;
    }

    event.stopPropagation();
    showExplanation = false;
  }}
>
  <div class="mb-2 flex items-center justify-between gap-2 text-xs">
    <span aria-live="polite">{zoomState.currentZoom.toFixed(1)}×</span>
    {#if loading}
      <span
        role="status"
        aria-label={$t('photo_zoom_loading')}
        class="size-3 animate-spin rounded-full border border-white/30 border-t-white motion-reduce:animate-none"
      ></span>
    {:else if failed || limited}
      <button
        type="button"
        aria-label={$t(failed ? 'photo_zoom_error' : 'photo_zoom_limited')}
        aria-expanded={showExplanation}
        title={$t(failed ? 'photo_zoom_error' : 'photo_zoom_limited')}
        class="flex size-6 items-center justify-center rounded-full border text-sm font-bold {failed
          ? 'border-red-400 text-red-400'
          : 'border-white/50'}"
        onfocus={() => (showExplanation = true)}
        onpointerenter={(event) => {
          if (event.pointerType === 'mouse') {
            showExplanation = true;
          }
        }}
        onclick={() => (showExplanation = true)}>!</button
      >
    {/if}
  </div>
  <!-- A two-dimensional navigation surface; arrows offer the equivalent keyboard action. -->
  <button
    type="button"
    bind:this={navigationImage}
    aria-label={$t('photo_navigator_pan')}
    class="relative mx-auto block cursor-crosshair touch-none overflow-hidden rounded-sm outline-offset-2"
    style:width="{size.width}px"
    style:height="{size.height}px"
    onpointerdown={start}
    onpointermove={move}
    onpointerup={end}
    onpointercancel={end}
    onlostpointercapture={() => (drag = undefined)}
    onkeydown={keyPan}
  >
    <img
      {src}
      alt=""
      draggable={false}
      class="pointer-events-none absolute max-w-none"
      style:width="{swapped ? size.height : size.width}px"
      style:height="{swapped ? size.width : size.height}px"
      style:left="{(size.width - (swapped ? size.height : size.width)) / 2}px"
      style:top="{(size.height - (swapped ? size.width : size.height)) / 2}px"
      style:rotate="{rotation}deg"
    />
    <div
      class="pointer-events-none absolute border border-white bg-white/5 shadow-[0_0_0_400px_rgba(0,0,0,0.4)]"
      style:left="{frame.x * 100}%"
      style:top="{frame.y * 100}%"
      style:width="{frame.width * 100}%"
      style:height="{frame.height * 100}%"
    ></div>
  </button>
  {#if !mediaQueryManager.pointerCoarse}
    <div class="mt-2 flex items-center gap-2">
      <button
        type="button"
        class="size-7 shrink-0 rounded-sm hover:bg-white/15"
        aria-label={$t('photo_zoom_out')}
        onclick={() => (assetViewerManager.zoom = Math.max(1, zoomState.currentZoom / 1.25))}>−</button
      >
      <input
        type="range"
        min="0"
        max="1"
        step="0.001"
        value={Math.log10(zoomState.currentZoom)}
        aria-label={$t('photo_zoom_level')}
        aria-valuetext="{zoomState.currentZoom.toFixed(1)}×"
        class="min-w-0 flex-1 accent-white"
        oninput={(event) => (assetViewerManager.zoom = 10 ** Number(event.currentTarget.value))}
      />
      <button
        type="button"
        class="size-7 shrink-0 rounded-sm hover:bg-white/15"
        aria-label={$t('photo_zoom_in')}
        disabled={zoomState.currentZoom >= 10}
        onclick={() => (assetViewerManager.zoom = Math.min(10, zoomState.currentZoom * 1.25))}>+</button
      >
    </div>
    <button
      type="button"
      class="mt-1 w-full rounded-sm py-1 text-xs hover:bg-white/15"
      onclick={() => assetViewerManager.animatedZoom(1)}>{$t('photo_zoom_fit')}</button
    >
  {/if}
  {#if showExplanation && (failed || limited)}
    <div role="status" class="mt-2 text-xs/relaxed">
      {$t(failed ? 'photo_zoom_error' : 'photo_zoom_limited')}
      {#if failed}
        <button
          type="button"
          class="mt-2 w-full rounded-sm border border-white/30 py-1"
          onclick={() => {
            showExplanation = false;
            onRetry();
          }}>{$t('retry')}</button
        >
      {/if}
    </div>
  {/if}
</div>
