<script lang="ts">
  import { page } from '$app/state';
  import GeolocationPointPickerModal from '$lib/modals/GeolocationPointPickerModal.svelte';
  import { getDetailedAddressRemainder } from '$lib/utils/address-display';
  import { applyContextualFilter, buildContextualMapUrl } from '$lib/utils/filter-target';
  import { handleError } from '$lib/utils/handle-error';
  import { ensureAssetAddress, updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Icon, IconButton, modalManager } from '@immich/ui';
  import { mdiContentCopy, mdiMapMarkerOutline, mdiMapOutline, mdiPencil } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    isOwner: boolean;
    /**
     * R4/E2 — false on a shared link, where there is no timeline to filter. Threaded from
     * DetailPanel exactly like `isOwner`.
     */
    canFilter?: boolean;
    asset: AssetResponseDto;
    onAddressResolved?: (asset: AssetResponseDto) => void;
  };

  let { isOwner, canFilter = false, asset = $bindable(), onAddressResolved }: Props = $props();

  // R9/E7 — a value that trims to nothing produces a patch that trims to nothing: the click would
  // close the asset viewer and apply NO filter. Such a value is rendered as plain text.
  let requestedPoint = $state('');
  $effect(() => {
    const exif = asset.exifInfo;
    const key = `${asset.id}:${exif?.latitude}:${exif?.longitude}`;
    if (
      (!isOwner && !canFilter) ||
      exif?.formattedAddress ||
      typeof exif?.latitude !== 'number' ||
      typeof exif?.longitude !== 'number' ||
      !['China', '中国', '中华人民共和国'].includes(exif?.country ?? '') ||
      requestedPoint === key
    ) {
      return;
    }
    requestedPoint = key;
    const id = asset.id;
    void ensureAssetAddress({ id })
      .then((result) => {
        if (!(
          asset.id === id &&
          `${asset.id}:${asset.exifInfo?.latitude}:${asset.exifInfo?.longitude}` === key &&
          result.formattedAddress
        )) {
          return;
        }

        asset = { ...asset, exifInfo: { ...asset.exifInfo, formattedAddress: result.formattedAddress } };
        onAddressResolved?.(asset);
      })
      .catch(() => {
        /* Keep the existing location when offline or the provider is unavailable. */
      });
  });

  const city = $derived(asset.exifInfo?.city?.trim() ?? '');
  const stateName = $derived(asset.exifInfo?.state?.trim() ?? '');
  const country = $derived(asset.exifInfo?.country?.trim() ?? '');
  const detailedAddress = $derived(getDetailedAddressRemainder(asset.exifInfo));

  // E10 — the pin carries the current context (Space scope + active filters) to the full map, and
  // centers it on this asset. Null on an album, which has no map URL (see buildContextualMapUrl).
  const mapUrl = $derived(
    buildContextualMapUrl(
      page.url,
      asset.exifInfo?.latitude && asset.exifInfo.longitude
        ? { lat: asset.exifInfo.latitude, lng: asset.exifInfo.longitude, zoom: 12.5 }
        : undefined,
    ),
  );

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(asset.exifInfo?.formattedAddress ?? '');
    } catch (error) {
      handleError(error, $t('errors.unable_to_copy_to_clipboard'));
    }
  };

  const onAction = async () => {
    const point = await modalManager.show(GeolocationPointPickerModal, { asset });
    if (!point) {
      return;
    }

    try {
      asset = await updateAsset({
        id: asset.id,
        updateAssetDto: { latitude: point.lat, longitude: point.lng },
      });
      requestedPoint = '';
    } catch (error) {
      handleError(error, $t('errors.unable_to_change_location'));
    }
  };
</script>

{#if asset.exifInfo?.country || asset.exifInfo?.formattedAddress}
  <!--
    R3 — this row used to be ONE <button> wrapping the pin, all three value lines AND the pencil.
    The three value lines are filter affordances now, so the outer button had to go (a button inside
    a button is invalid HTML) and the pencil became a real IconButton.
  -->
  <div class="flex w-full place-items-start justify-between gap-4 py-4 text-start" data-testid="detail-panel-location">
    <div class="flex min-w-0 gap-4">
      <div><Icon icon={mdiMapMarkerOutline} size="24" /></div>

      <div class="min-w-0">
        {#if detailedAddress}
          <p class="wrap-break-word" title={$t('detailed_address')} data-testid="detailed-address">{detailedAddress}</p>
        {/if}
        {#if asset.exifInfo?.city}
          <p>
            {#if canFilter && city}
              <button
                type="button"
                class="text-left hover:text-primary"
                aria-label="{$t('filter_by_location')}: {city}"
                onclick={() => applyContextualFilter({ city, state: undefined, country })}
              >
                {asset.exifInfo.city}
              </button>
            {:else}
              <span>{asset.exifInfo.city}</span>
            {/if}
          </p>
        {/if}
        {#if asset.exifInfo?.state}
          <div class="flex gap-2 text-sm">
            <p>
              {#if canFilter && stateName}
                <button
                  type="button"
                  class="text-left hover:text-primary"
                  aria-label="{$t('filter_by_location')}: {stateName}"
                  onclick={() => applyContextualFilter({ city: undefined, state: stateName, country })}
                >
                  {asset.exifInfo.state}
                </button>
              {:else}
                <span>{asset.exifInfo.state}</span>
              {/if}
            </p>
          </div>
        {/if}
        {#if asset.exifInfo?.country}
          <div class="flex gap-2 text-sm">
            <p>
              {#if canFilter && country}
                <button
                  type="button"
                  class="text-left hover:text-primary"
                  aria-label="{$t('filter_by_location')}: {country}"
                  onclick={() => applyContextualFilter({ city: undefined, state: undefined, country })}
                >
                  {asset.exifInfo.country}
                </button>
              {:else}
                <span>{asset.exifInfo.country}</span>
              {/if}
            </p>
          </div>
        {/if}
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      {#if asset.exifInfo?.formattedAddress}
        <IconButton
          icon={mdiContentCopy}
          aria-label={$t('copy_detailed_address')}
          size="small"
          shape="round"
          color="secondary"
          variant="ghost"
          onclick={copyAddress}
        />
      {/if}
      {#if canFilter && mapUrl}
        <IconButton
          href={mapUrl}
          icon={mdiMapOutline}
          aria-label={$t('view_in_map')}
          size="small"
          shape="round"
          color="secondary"
          variant="ghost"
        />
      {/if}
      {#if isOwner}
        <IconButton
          icon={mdiPencil}
          aria-label={$t('edit_location')}
          size="small"
          shape="round"
          color="secondary"
          variant="ghost"
          onclick={onAction}
        />
      {/if}
    </div>
  </div>
{:else if !asset.exifInfo?.city && isOwner}
  <!--
    The ONLY entry point to the geo picker for an asset with no location at all. Untested before this
    slice; pinned by detail-panel-location.spec.ts now. Do not delete it "fixing" the branch above.
  -->
  <button
    type="button"
    class="flex w-full place-items-start justify-between gap-4 rounded-lg py-4 text-start hover:text-primary"
    onclick={onAction}
    title={$t('add_location')}
    data-testid="detail-panel-location"
  >
    <div class="flex gap-4">
      <div><Icon icon={mdiMapMarkerOutline} size="24" /></div>
      <p>{$t('add_a_location')}</p>
    </div>
    <div class="p-1 focus:outline-none">
      <Icon icon={mdiPencil} size="20" />
    </div>
  </button>
{/if}
