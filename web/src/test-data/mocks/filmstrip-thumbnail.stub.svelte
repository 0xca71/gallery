<script lang="ts">
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';

  interface Props {
    asset: TimelineAsset;
    preload?: boolean;
    onClick?: () => void;
  }

  let { asset, preload = false, onClick }: Props = $props();
</script>

<button
  type="button"
  data-testid={`filmstrip-thumbnail-${asset.id}`}
  data-preload={preload ? 'true' : 'false'}
  onclick={onClick}>{asset.id}</button
>
