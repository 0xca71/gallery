<script lang="ts">
  interface Props {
    asset: { id: string };
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
