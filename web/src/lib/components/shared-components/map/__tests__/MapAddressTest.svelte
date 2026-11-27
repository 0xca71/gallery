<script lang="ts">
  import type { MapMarkerResponseDto } from '@immich/sdk';
  import Map from '../Map.svelte';

  const { marker, customPopup = false }: { marker: MapMarkerResponseDto; customPopup?: boolean } = $props();
</script>

<div style="width: min(800px, 100%); height: 400px">
  {#if customPopup}
    <Map
      mapMarkers={[marker]}
      center={[marker.lon, marker.lat]}
      zoom={13}
      simplified
      useLocationPin
      showSettings={false}
      showSimpleControls={false}
    >
      {#snippet popup({ marker: point })}
        <p data-testid="custom-address-popup">{point.formattedAddress}</p>
        <p data-testid="custom-address-point">{point.lat},{point.lon}</p>
      {/snippet}
    </Map>
  {:else}
    <Map
      mapMarkers={[marker]}
      center={[marker.lon, marker.lat]}
      zoom={13}
      simplified
      useLocationPin
      showSettings={false}
      showSimpleControls={false}
    />
  {/if}
</div>
