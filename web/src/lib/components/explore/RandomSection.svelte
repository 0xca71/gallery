<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Button, LoadingSpinner } from '@immich/ui';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { randomSeedManager } from '$lib/managers/random-seed-manager.svelte';
  import {
    buildRandomSearchFilter,
    defaultRandomFilter,
    isRandomExhausted,
    loadRandomBatch,
    loadRandomTotal,
    mergeUniqueAssets,
  } from '$lib/utils/explore-random';
  import ExploreAssetRow from './ExploreAssetRow.svelte';
  import RandomFilterControls from './RandomFilterControls.svelte';

  let {
    full = false,
    onselect,
    viewerAssetId,
    onassetschange,
  }: {
    full?: boolean;
    onselect: (assets: AssetResponseDto[], asset: AssetResponseDto) => void;
    viewerAssetId?: string;
    onassetschange?: (assets: AssetResponseDto[]) => void;
  } = $props();

  let filter = $state(defaultRandomFilter());
  let assets = $state<AssetResponseDto[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let total = $state<number | null>(null);
  let exhausted = $state(false);
  let sentinel = $state<HTMLElement>();
  let sentinelVisible = $state(false);
  let autoLoadPaused = $state(false);
  let controller: AbortController;
  const previewSize = 24;
  const viewerPrefetchRemaining = 72;
  let viewerLoadAttempt: string | undefined;

  async function refresh() {
    if (loading) {
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const { signal } = controller;
    loading = true;
    failed = false;
    assets = [];
    total = null;
    exhausted = false;
    autoLoadPaused = false;
    viewerLoadAttempt = undefined;

    try {
      const query = buildRandomSearchFilter(filter);
      if (full) {
        const seed = randomSeedManager.take(filter);
        if (seed) {
          assets = seed;
          total = await loadRandomTotal(query, signal).catch(() => null);
          exhausted = isRandomExhausted(assets.length, total, seed.length);
        } else {
          const [batch, matching] = await Promise.all([
            loadRandomBatch(query, signal),
            loadRandomTotal(query, signal).catch(() => null),
          ]);
          assets = batch;
          total = matching;
          exhausted = isRandomExhausted(assets.length, total, batch.length);
        }
      } else {
        assets = await loadRandomBatch(query, signal, previewSize);
        if (!signal.aborted) {
          randomSeedManager.set(assets, filter);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        failed = true;
        handleError(error, $t('errors.failed_to_load_assets'));
      }
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if ((!full && !viewerAssetId) || loading || exhausted) {
      return;
    }
    const signal = controller.signal;
    loading = true;
    try {
      const batch = await loadRandomBatch(buildRandomSearchFilter(filter), signal);
      if (signal.aborted) {
        return;
      }
      autoLoadPaused = false;
      const merged = mergeUniqueAssets(assets, batch);
      assets = merged.assets;
      exhausted = isRandomExhausted(assets.length, total, merged.added);
      onassetschange?.(assets);
    } catch (error) {
      if (!signal.aborted) {
        autoLoadPaused = true;
        handleError(error, $t('errors.failed_to_load_assets'));
      }
    } finally {
      loading = false;
    }
  }

  let observer: IntersectionObserver | undefined;

  $effect(() => {
    observer?.disconnect();
    sentinelVisible = false;
    if (!full || exhausted || !sentinel) {
      return;
    }

    observer ??= new IntersectionObserver(
      (entries) => {
        sentinelVisible = entries.some((entry) => entry.isIntersecting);
      },
      { rootMargin: '400px' },
    );
    observer.observe(sentinel);

    return () => observer?.disconnect();
  });

  $effect(() => {
    if (full && !exhausted && sentinelVisible && !loading && !autoLoadPaused) {
      void loadMore();
    }
  });

  // Viewer navigation happens in an overlay, where the page's infinite-scroll sentinel may
  // never become visible. Refill from the current asset instead, including the Explore preview.
  $effect(() => {
    if (!viewerAssetId) {
      viewerLoadAttempt = undefined;
      return;
    }
    const index = assets.findIndex(({ id }) => id === viewerAssetId);
    if (index === -1 || assets.length - index - 1 > viewerPrefetchRemaining || loading || exhausted) {
      return;
    }
    const attempt = `${viewerAssetId}:${assets.length}`;
    if (viewerLoadAttempt === attempt) {
      return;
    }
    // A failed request gets one attempt per position; moving to another photo can retry.
    viewerLoadAttempt = attempt;
    untrack(() => void loadMore());
  });

  onMount(() => {
    void refresh();
    return () => controller?.abort();
  });
</script>

<section class="mt-2 mb-6 dark:text-immich-dark-fg" aria-busy={loading}>
  <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
    {#if !full}
      <h2 class="pt-2 font-medium">{$t('explore_random')}</h2>
    {:else}
      <span></span>
    {/if}
    {#if full}
      <RandomFilterControls bind:filter {loading} onrefresh={refresh} />
    {:else}
      <a
        class="pe-4 text-sm font-medium hover:text-immich-primary dark:hover:text-immich-dark-primary"
        href={Route.random()}
        draggable="false">{$t('view_all')}</a
      >
    {/if}
  </div>

  {#if loading && assets.length === 0}
    <div class="flex h-24 items-center justify-center"><LoadingSpinner /></div>
  {/if}

  <ExploreAssetRow
    assets={full ? assets : assets.slice(0, previewSize)}
    {full}
    onselect={(asset) => onselect(assets, asset)}
  />

  {#if !loading && assets.length === 0}
    <p class="py-4 text-sm">{$t(failed ? 'errors.failed_to_load_assets' : 'no_results')}</p>
  {/if}

  {#if full && assets.length > 0}
    <div class="flex flex-col items-center gap-2 py-6 text-sm">
      {#if loading}<LoadingSpinner />{/if}
      {#if exhausted}
        <p>{$t('explore_random_exhausted')}</p>
      {:else if total !== null}
        <p>{$t('explore_random_progress', { values: { shown: assets.length, total } })}</p>
      {/if}
      {#if !exhausted}
        <Button size="small" color="secondary" variant="ghost" disabled={loading} onclick={() => loadMore()}>
          {$t('load_more')}
        </Button>
        <div bind:this={sentinel} class="h-px w-full"></div>
      {/if}
    </div>
  {/if}
</section>
