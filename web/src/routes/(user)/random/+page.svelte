<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import RandomSection from '$lib/components/explore/RandomSection.svelte';
  import { t } from 'svelte-i18n';
  import type { AssetResponseDto } from '@immich/sdk';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { lazyComponent } from '$lib/utils/lazy-component.svelte';

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
  const LazyAssetViewer = lazyComponent(() => import('$lib/components/asset-viewer/AssetViewer.svelte'));
</script>

<UserPageLayout title={$t('explore_random')}>
  <div class="px-2 md:px-4">
    <RandomSection full {onselect} />
  </div>
</UserPageLayout>

{#if assetViewerManager.isViewing && LazyAssetViewer.current}
  {@const AssetViewer = LazyAssetViewer.current}
  <Portal target="body">
    <AssetViewer
      {cursor}
      showNavigation={viewerAssets.length > 1}
      onClose={() => assetViewerManager.showAssetViewer(false)}
    />
  </Portal>
{/if}
