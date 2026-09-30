<script lang="ts">
  import { getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
  import { DatePicker, IconButton } from '@immich/ui';
  import { mdiShuffle, mdiTune } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { DateTime } from 'luxon';
  import { handleError } from '$lib/utils/handle-error';
  import { dateRangeOptions, type RandomFilterState } from '$lib/utils/explore-random';

  let {
    filter = $bindable(),
    loading,
    onrefresh,
  }: { filter: RandomFilterState; loading: boolean; onrefresh: () => void } = $props();

  let expanded = $state(false);
  let albums = $state<AlbumResponseDto[]>([]);
  let albumsLoading = $state(false);
  const asDateTime = (value: string) => (value ? DateTime.fromISO(value) : undefined);

  async function loadAlbums() {
    if (albumsLoading || albums.length > 0) {
      return;
    }

    albumsLoading = true;
    try {
      const allAlbums = await getAllAlbums({});
      albums = [...allAlbums].sort((a, b) => a.albumName.localeCompare(b.albumName));
    } catch (error) {
      handleError(error, $t('errors.failed_to_load_assets'));
    } finally {
      albumsLoading = false;
    }
  }
</script>

<div class="flex flex-wrap items-center justify-end gap-2">
  {#if expanded}
    <div class="flex flex-wrap items-center gap-2">
      <label class="text-sm"
        >{$t('media_type')}
        <select
          class="ms-2 rounded-sm border p-2 dark:bg-immich-dark-gray"
          bind:value={filter.mediaType}
          disabled={loading}
          onchange={onrefresh}
        >
          <option value="all">{$t('all')}</option>
          <option value="image">{$t('photos')}</option>
          <option value="video">{$t('videos')}</option>
        </select>
      </label>

      <label class="text-sm"
        >{$t('album')}
        <select
          class="ms-2 max-w-56 rounded-sm border p-2 dark:bg-immich-dark-gray"
          bind:value={filter.albumId}
          disabled={loading || albumsLoading}
          onchange={onrefresh}
        >
          <option value="">{$t('all_albums')}</option>
          {#each albums as album (album.id)}
            <option value={album.id}>{album.albumName}</option>
          {/each}
        </select>
      </label>

      <label class="text-sm"
        >{$t('date_range')}
        <select
          class="ms-2 rounded-sm border p-2 dark:bg-immich-dark-gray"
          bind:value={filter.dateRange}
          disabled={loading}
          onchange={() => {
            if (filter.dateRange !== 'custom') {
              onrefresh();
            }
          }}
        >
          {#each dateRangeOptions as range (range)}
            <option value={range}>{$t(`explore_random_range_${range}`)}</option>
          {/each}
        </select>
      </label>

      {#if filter.dateRange === 'custom'}
        <label class="flex items-center gap-1 text-sm"
          >{$t('start_date')}
          <DatePicker
            value={asDateTime(filter.takenAfter)}
            maxDate={DateTime.now()}
            onChange={(date) => {
              filter.takenAfter = date?.toISODate() ?? '';
              onrefresh();
            }}
          />
        </label>
        <label class="flex items-center gap-1 text-sm"
          >{$t('end_date')}
          <DatePicker
            value={asDateTime(filter.takenBefore)}
            maxDate={DateTime.now()}
            onChange={(date) => {
              filter.takenBefore = date?.toISODate() ?? '';
              onrefresh();
            }}
          />
        </label>
      {/if}
    </div>
  {/if}

  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    icon={mdiTune}
    aria-label={$t('filters')}
    aria-expanded={expanded}
    onclick={() => {
      expanded = !expanded;
      if (expanded) {
        void loadAlbums();
      }
    }}
  />
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    icon={mdiShuffle}
    aria-label={$t('shuffle')}
    disabled={loading}
    onclick={onrefresh}
  />
</div>
