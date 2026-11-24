<script lang="ts">
  import type { FilmstripAsset } from '#lib/components/asset-viewer/AssetViewerFilmstrip.svelte';
  import RandomSection from '#lib/components/explore/RandomSection.svelte';
  import FilterPanel from '#lib/components/filter-panel/filter-panel.svelte';
  import { createFilterState } from '#lib/components/filter-panel/filter-panel.ts';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import Portal from '#lib/elements/Portal.svelte';
  import LibraryViewFilter from '#lib/gallery/library-view/LibraryViewFilter.svelte';
  import { keepSpacesLoaded, libraryViewOptions } from '#lib/gallery/library-view/library-view.svelte.ts';
  import { assetViewerManager } from '#lib/managers/asset-viewer-manager.svelte.ts';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { getNextAsset, getPreviousAsset } from '#lib/utils/asset-utils.ts';
  import { buildRandomSearchQuery, defaultRandomFilter } from '#lib/utils/explore-random.ts';
  import { filterStateToSearchTerms } from '#lib/utils/filter-search-terms.ts';
  import { decodeFilterParams } from '#lib/utils/filter-url.ts';
  import { lazyComponent } from '#lib/utils/lazy-component.svelte.ts';
  import { buildMapFilterConfig } from '#lib/utils/map-filter-config.ts';
  import { buildPhotosTimelineOptions } from '#lib/utils/photos-filter-options.ts';
  import { TimeBucketSize, getTimeBuckets, type AssetResponseDto } from '@immich/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { page } from '$app/state';

  keepSpacesLoaded();
  let filters = $state({ ...createFilterState(), ...decodeFilterParams(page.url) });
  let randomFilter = $state(defaultRandomFilter());
  const scope = $derived({
    ...filterStateToSearchTerms(filters),
    libraryId: page.url.searchParams.get('libraryId') ?? undefined,
  });
  const panelConfig = {
    ...buildMapFilterConfig(),
    sections: ['timeline', 'location'] as Array<'timeline' | 'location'>,
  };
  const pickerOptions = $derived.by(() => {
    const pickerFilters = { ...filters, selectedYear: undefined, selectedMonth: undefined };
    const random = buildRandomSearchQuery(randomFilter, {
      ...filterStateToSearchTerms(pickerFilters),
      libraryId: scope.libraryId,
    });
    return {
      ...buildPhotosTimelineOptions(pickerFilters, authManager.user.id),
      ...libraryViewOptions(),
      libraryId: scope.libraryId,
      albumId: random.albumIds?.[0],
      $type: random.type,
      takenAfter: random.takenAfter,
      takenBefore: random.takenBefore,
      bucketSize: TimeBucketSize.Month,
    };
  });
  let timeBuckets = $state<Array<{ timeBucket: string; count: number }>>([]);
  $effect(() => {
    const options = pickerOptions;
    const controller = new AbortController();
    void getTimeBuckets(options, { signal: controller.signal })
      .then((buckets) => {
        if (!controller.signal.aborted) {
          timeBuckets = buckets;
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error('Failed to fetch random filter buckets:', error);
        }
      });
    return () => controller.abort();
  });
  onDestroy(() => assetViewerManager.showAssetViewer(false));

  let viewerAssets = $state<AssetResponseDto[]>([]);
  const onselect = (assets: AssetResponseDto[], asset: AssetResponseDto) => {
    viewerAssets = assets;
    assetViewerManager.setAsset(asset);
  };
  const viewerIndex = $derived(viewerAssets.findIndex((asset) => asset.id === assetViewerManager.asset?.id));
  const cursor = $derived({
    current: assetViewerManager.asset!,
    previousAsset: viewerAssets[viewerIndex - 1],
    nextAsset: viewerAssets[viewerIndex + 1],
  });

  const resolveSlideshowStepAsset = (asset: AssetResponseDto, order: 'previous' | 'next') =>
    order === 'previous' ? getPreviousAsset(viewerAssets, asset) : getNextAsset(viewerAssets, asset);

  const resolveSlideshowRandomAsset = (isPlayable: (asset: AssetResponseDto) => boolean) => {
    const playableAssets = viewerAssets.filter((asset) => isPlayable(asset));
    return playableAssets[Math.floor(Math.random() * playableAssets.length)];
  };

  const selectFilmstripAsset = (asset: FilmstripAsset) => {
    if ('type' in asset) {
      assetViewerManager.setAsset(asset);
    }
  };
  const LazyAssetViewer = lazyComponent(() => import('#lib/components/asset-viewer/AssetViewer.svelte'));
</script>

{#snippet libraryViewSection()}<LibraryViewFilter />{/snippet}

<UserPageLayout title={$t('explore_random')}>
  <div class="flex min-h-0 flex-1">
    <FilterPanel
      config={panelConfig}
      bind:filters
      {timeBuckets}
      temporalSortOrder="desc"
      storageKey="gallery-filter-visible-sections-random"
      top={libraryViewSection}
    />
    <div class="min-w-0 flex-1 px-2 md:px-4">
      <RandomSection
        full
        bind:filter={randomFilter}
        {scope}
        {onselect}
        viewerAssetId={assetViewerManager.isViewing && viewerAssets.length > 0
          ? assetViewerManager.asset?.id
          : undefined}
        onassetschange={(assets) => {
          viewerAssets = assets;
          if (assets.length === 0) {
            assetViewerManager.showAssetViewer(false);
          }
        }}
      />
    </div>
  </div>
</UserPageLayout>

{#if assetViewerManager.isViewing && LazyAssetViewer.current}
  {const AssetViewer = $derived(LazyAssetViewer.current)}
  <Portal target="body">
    <AssetViewer
      {cursor}
      showNavigation={viewerAssets.length > 1}
      filmstripAssets={viewerAssets}
      onFilmstripAssetSelect={selectFilmstripAsset}
      {resolveSlideshowStepAsset}
      {resolveSlideshowRandomAsset}
      onClose={() => assetViewerManager.showAssetViewer(false)}
    />
  </Portal>
{/if}
