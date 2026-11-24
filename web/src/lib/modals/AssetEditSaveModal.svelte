<script lang="ts">
  import { AssetEditSaveMode, type AssetEditSaveCapabilitiesDto } from '@immich/sdk';
  import { FormModal } from '@immich/ui';
  import { mdiContentSave } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    capabilities: AssetEditSaveCapabilitiesDto;
    onClose: (mode: AssetEditSaveMode | null) => void;
  }
  const { capabilities, onClose }: Props = $props();
  let mode = $state(AssetEditSaveMode.Copy);
  const reason = $derived(capabilities.overwriteUnavailableReason);
  const reasonKey = $derived(
    reason === 'unsupported_format'
      ? 'editor_save_unavailable_unsupported_format'
      : reason === 'save_in_progress'
        ? 'editor_save_unavailable_save_in_progress'
        : 'editor_save_unavailable_not_writable',
  );
</script>

<FormModal
  title={$t('editor_save_mode_title')}
  icon={mdiContentSave}
  size="small"
  onClose={() => onClose(null)}
  onSubmit={() => onClose(mode)}
  submitText={mode === AssetEditSaveMode.Copy ? $t('editor_save_copy') : $t('editor_save_overwrite')}
  cancelText={$t('cancel')}
  disabled={mode === AssetEditSaveMode.Copy ? !capabilities.canCopy : !capabilities.canOverwrite}
>
  <div class="space-y-4">
    <label class="flex cursor-pointer gap-3 rounded-lg border border-immich-primary/30 p-4">
      <input
        type="radio"
        name="image-save-mode"
        value={AssetEditSaveMode.Copy}
        bind:group={mode}
        disabled={!capabilities.canCopy}
      />
      <span>
        <span class="block font-medium">{$t('editor_save_copy')}</span>
        <span class="mt-1 block text-sm">{$t('editor_save_copy_description')}</span>
      </span>
    </label>
    <label
      class="flex gap-3 rounded-lg border border-immich-primary/30 p-4"
      class:opacity-60={!capabilities.canOverwrite}
    >
      <input
        type="radio"
        name="image-save-mode"
        value={AssetEditSaveMode.Overwrite}
        bind:group={mode}
        disabled={!capabilities.canOverwrite}
      />
      <span>
        <span class="block font-medium">{$t('editor_save_overwrite')}</span>
        <span class="mt-1 block text-sm">{$t('editor_save_overwrite_description')}</span>
        {#if reason}
          <span class="text-immich-error mt-2 block text-sm">{$t(reasonKey)}</span>
        {/if}
      </span>
    </label>
  </div>
</FormModal>
