<script lang="ts">
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { toTimelineAsset } from '$lib/utils/timeline-util';

  let {
    assets,
    full = false,
    onselect,
  }: { assets: AssetResponseDto[]; full?: boolean; onselect: (asset: AssetResponseDto) => void } = $props();
</script>

<div
  class={full
    ? 'grid w-full grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8'
    : 'flex h-24 max-w-fit flex-wrap gap-x-1 overflow-hidden md:h-42'}
>
  {#each assets as asset (asset.id)}
    <button
      type="button"
      class={full ? 'relative aspect-square overflow-hidden rounded-xl' : 'relative h-full flex-auto'}
      onclick={() => onselect(asset)}
      draggable="false"
    >
      <img
        src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail })}
        alt={$getAltText(toTimelineAsset(asset))}
        class="size-full min-w-max rounded-xl object-cover"
      />
    </button>
  {/each}
</div>
