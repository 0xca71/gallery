<script lang="ts">
  import LoadingSpinner from '$lib/components/shared-components/LoadingSpinner.svelte';
  import { Icon } from '@immich/ui';
  import { mdiShuffle } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    loading?: boolean;
    onclick: () => void;
  }

  let { loading = false, onclick }: Props = $props();
</script>

<button
  type="button"
  class="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/95 text-gray-600 ring-1 ring-black/10 transition hover:bg-gray-100 hover:text-gray-900 disabled:cursor-wait disabled:opacity-60 dark:bg-immich-dark-gray dark:text-gray-300 dark:ring-white/10 dark:hover:bg-gray-700 dark:hover:text-white"
  {onclick}
  disabled={loading}
  aria-busy={loading}
  aria-label={$t('timeline_random_jump')}
  title={$t('timeline_random_jump')}
  data-testid="timeline-random-button"
>
  {#if loading}
    <LoadingSpinner size="medium" />
  {:else}
    <Icon icon={mdiShuffle} size="20" />
  {/if}
</button>
