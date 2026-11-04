<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import { editManager, EditToolType } from '$lib/managers/edit/edit-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import { AssetEditSaveMode, AssetTypeEnum, getAssetEdits, type AssetResponseDto } from '@immich/sdk';
  import { Button, HStack, Icon, IconButton } from '@immich/ui';
  import { mdiChevronDown, mdiClose } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => {
    return websocketEvents.on('on_asset_update', (assetUpdate) => {
      if (assetUpdate.id === asset.id) {
        asset = assetUpdate;
      }
    });
  });

  interface Props {
    asset: AssetResponseDto;
    onClose: () => void;
  }

  let { asset = $bindable(), onClose }: Props = $props();
  let saveMenuOpen = $state(false);
  let splitButtonContainer: HTMLDivElement | undefined = $state();

  const canOverwrite = $derived(editManager.saveCapabilities?.canOverwrite ?? true);
  const canCopy = $derived(editManager.saveCapabilities?.canCopy ?? true);
  const defaultSaveMode = $derived(canOverwrite ? AssetEditSaveMode.Overwrite : AssetEditSaveMode.Copy);
  const unavailableReason = $derived(editManager.saveCapabilities?.overwriteUnavailableReason ?? null);
  const unavailableReasonKey = $derived(
    unavailableReason === 'unsupported_format'
      ? 'editor_save_unavailable_unsupported_format'
      : unavailableReason === 'save_in_progress'
        ? 'editor_save_unavailable_save_in_progress'
        : 'editor_save_unavailable_not_writable',
  );

  onMount(async () => {
    const edits = await getAssetEdits({ id: asset.id });
    const toolType = asset.type === AssetTypeEnum.Video ? EditToolType.Trim : EditToolType.Transform;
    await editManager.activateTool(toolType, asset, edits);
  });

  onDestroy(() => {
    editManager.cleanup();
  });

  async function applyEdits(mode?: AssetEditSaveMode) {
    saveMenuOpen = false;
    const success =
      asset.type === AssetTypeEnum.Image
        ? await editManager.saveImageEdits(mode ?? defaultSaveMode)
        : await editManager.applyEdits();

    if (success) {
      onClose();
    }
  }

  async function closeEditor() {
    if (saveMenuOpen) {
      saveMenuOpen = false;
      return;
    }
    if (editManager.isApplyingEdits) {
      return;
    }
    if (await editManager.closeConfirm()) {
      onClose();
    }
  }

  function handleWindowClick(event: MouseEvent) {
    if (saveMenuOpen && !splitButtonContainer?.contains(event.target as Node)) {
      saveMenuOpen = false;
    }
  }
</script>

<svelte:window onclick={handleWindowClick} />

<svelte:document
  use:shortcuts={[
    { shortcut: { key: 'Escape' }, onShortcut: closeEditor },
    { shortcut: { key: 'Enter' }, onShortcut: () => applyEdits() },
  ]}
/>

<section class="dark relative flex h-full flex-col p-2 pt-3 dark:bg-immich-dark-bg dark:text-immich-dark-fg">
  <HStack class="me-4 justify-between">
    <HStack>
      <IconButton
        shape="round"
        variant="ghost"
        color="secondary"
        icon={mdiClose}
        aria-label={$t('close')}
        onclick={closeEditor}
      />
      <p class="text-lg text-immich-fg capitalize dark:text-immich-dark-fg">{$t('editor')}</p>
    </HStack>
    {#if asset.type === AssetTypeEnum.Image}
      <div class="relative inline-flex items-stretch" bind:this={splitButtonContainer} data-testid="editor-save-split">
        <Button
          shape="round"
          size="small"
          class="rounded-e-none"
          onclick={() => applyEdits(defaultSaveMode)}
          loading={editManager.isApplyingEdits}
          disabled={defaultSaveMode === AssetEditSaveMode.Overwrite ? !canOverwrite : !canCopy}
        >
          {defaultSaveMode === AssetEditSaveMode.Overwrite ? $t('editor_save_overwrite') : $t('editor_save_copy')}
        </Button>
        <Button
          shape="round"
          size="small"
          class="rounded-s-none border-s border-white/25 px-2"
          aria-label={$t('editor_save_mode_title')}
          aria-expanded={saveMenuOpen}
          aria-haspopup="menu"
          disabled={editManager.isApplyingEdits}
          onclick={() => (saveMenuOpen = !saveMenuOpen)}
        >
          <Icon icon={mdiChevronDown} size="18" />
        </Button>
        {#if saveMenuOpen}
          <div
            role="menu"
            class="absolute inset-e-0 top-full z-20 mt-1.5 w-72 rounded-xl border border-gray-200 bg-light p-1.5 text-immich-fg shadow-lg dark:border-gray-700 dark:bg-immich-dark-gray dark:text-immich-dark-fg"
          >
            <button
              type="button"
              role="menuitem"
              class="w-full rounded-lg p-2.5 text-start transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!canOverwrite}
              onclick={() => applyEdits(AssetEditSaveMode.Overwrite)}
            >
              <span class="block text-sm font-medium">{$t('editor_save_overwrite')}</span>
              <span class="mt-0.5 block text-xs text-muted">{$t('editor_save_overwrite_description')}</span>
              {#if unavailableReason}
                <span class="text-immich-error mt-1 block text-xs">{$t(unavailableReasonKey)}</span>
              {/if}
            </button>
            <button
              type="button"
              role="menuitem"
              class="mt-1 w-full rounded-lg p-2.5 text-start transition hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!canCopy}
              onclick={() => applyEdits(AssetEditSaveMode.Copy)}
            >
              <span class="block text-sm font-medium">{$t('editor_save_copy')}</span>
              <span class="mt-0.5 block text-xs text-muted">{$t('editor_save_copy_description')}</span>
            </button>
          </div>
        {/if}
      </div>
    {:else}
      <Button shape="round" size="small" onclick={() => applyEdits()} loading={editManager.isApplyingEdits}>
        {$t('save')}
      </Button>
    {/if}
  </HStack>

  <section
    inert={editManager.isApplyingEdits ||
      editManager.pendingSave?.assetId === asset.id ||
      editManager.pendingRequest?.assetId === asset.id}
  >
    {#if editManager.selectedTool}
      <editManager.selectedTool.component />
    {/if}
  </section>
  <div class="flex-1"></div>
  <section class="p-4">
    <Button
      variant="outline"
      onclick={() => editManager.resetAllChanges()}
      disabled={!editManager.canReset}
      class="self-start"
      shape="round"
      size="small"
    >
      {$t('editor_reset_all_changes')}
    </Button>
  </section>
</section>
