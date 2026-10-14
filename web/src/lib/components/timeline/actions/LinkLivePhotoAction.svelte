<script lang="ts">
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import type { OnLink, OnUnlink, OnUnlinkAndDelete } from '$lib/utils/actions';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { getAssetInfo, unlinkAndDeleteLivePhoto, updateAsset } from '@immich/sdk';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiLinkOff, mdiMotionPlayOutline, mdiTimerSand } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onLink: OnLink;
    onUnlink: OnUnlink;
    onUnlinkAndDelete?: OnUnlinkAndDelete;
    deleteVideo?: boolean;
    menuItem?: boolean;
    unlink?: boolean;
  }

  let { onLink, onUnlink, onUnlinkAndDelete, deleteVideo = false, menuItem = false, unlink = false }: Props = $props();

  let loading = $state(false);

  let text = $derived(
    unlink ? $t(deleteVideo ? 'unlink_and_delete_motion_video' : 'unlink_motion_video') : $t('link_motion_video'),
  );
  let icon = $derived(unlink ? mdiLinkOff : mdiMotionPlayOutline);

  const onClick = () => (unlink ? handleUnlink() : handleLink());

  const handleLink = async () => {
    let [still, motion] = assetMultiSelectManager.ownedAssets;
    if ((still as TimelineAsset).isVideo) {
      [still, motion] = [motion, still];
    }

    try {
      loading = true;
      const stillResponse = await updateAsset({ id: still.id, updateAssetDto: { livePhotoVideoId: motion.id } });
      onLink({ still: toTimelineAsset(stillResponse), motion: motion as TimelineAsset });
      assetMultiSelectManager.clear();
    } catch (error) {
      handleError(error, $t('errors.unable_to_link_motion_video'));
    } finally {
      loading = false;
    }
  };

  const handleUnlink = async () => {
    const [still] = assetMultiSelectManager.ownedAssets;
    if (!still) {
      return;
    }
    const motionId = still.livePhotoVideoId;
    if (!motionId) {
      return;
    }
    try {
      loading = true;
      if (deleteVideo) {
        const confirmed = await modalManager.showDialog({
          title: $t('unlink_and_delete_motion_video'),
          prompt: $t('unlink_and_delete_motion_video_confirmation'),
          confirmText: $t('permanently_delete'),
        });
        if (!confirmed) {
          return;
        }
        const stillResponse = await unlinkAndDeleteLivePhoto({ id: still.id });
        onUnlinkAndDelete?.({ still: toTimelineAsset(stillResponse), motionId });
      } else {
        const stillResponse = await updateAsset({ id: still.id, updateAssetDto: { livePhotoVideoId: null } });
        const motionResponse = await getAssetInfo({ ...authManager.params, id: motionId });
        onUnlink({ still: toTimelineAsset(stillResponse), motion: toTimelineAsset(motionResponse) });
      }
      assetMultiSelectManager.clear();
    } catch (error) {
      handleError(error, $t('errors.unable_to_unlink_motion_video'));
    } finally {
      loading = false;
    }
  };
</script>

{#if menuItem}
  <MenuOption {text} {icon} {onClick} />
{/if}

{#if !menuItem}
  {#if loading}
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      aria-label={$t('loading')}
      icon={mdiTimerSand}
      onclick={() => {}}
    />
  {:else}
    <IconButton shape="round" color="secondary" variant="ghost" aria-label={text} {icon} onclick={onClick} />
  {/if}
{/if}
