import {
  AssetTypeEnum,
  AssetEditSaveStatus,
  getAssetEditSave,
  getAssetEditSaveCapabilities,
  saveAssetEdits,
  editAsset,
  getAssetInfo,
  isHttpError,
  removeAssetEdits,
  type AssetEditsCreateDto,
  type AssetEditSaveCreateDto,
  type AssetResponseDto,
} from '@immich/sdk';
import { ConfirmModal, modalManager, toastManager } from '@immich/ui';
import { mdiContentCut, mdiCropRotate } from '@mdi/js';
import type { Component } from 'svelte';
import TransformTool from '$lib/components/asset-viewer/editor/transform-tool/TransformTool.svelte';
import TrimTool from '$lib/components/asset-viewer/editor/trim-tool/trim-tool.svelte';
import { transformManager } from '$lib/managers/edit/transform-manager.svelte';
import { trimManager } from '$lib/managers/edit/trim-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import AssetEditSaveModal from '$lib/modals/AssetEditSaveModal.svelte';
import { waitForWebsocketEvent } from '$lib/stores/websocket';
import { getFormatter } from '$lib/utils/i18n';

export type EditAction = AssetEditsCreateDto['edits'][number];
export type EditActions = EditAction[];

export interface EditToolManager {
  onActivate: (asset: AssetResponseDto, edits: EditActions) => Promise<void>;
  onDeactivate: () => void;
  resetAllChanges: () => Promise<void>;
  hasChanges: boolean;
  canReset: boolean;
  edits: EditAction[];
}

export enum EditToolType {
  Transform = 'transform',
  Trim = 'trim',
}

export interface EditTool {
  type: EditToolType;
  icon: string;
  component: Component;
  manager: EditToolManager;
}

export class EditManager {
  tools: EditTool[] = [
    {
      type: EditToolType.Transform,
      icon: mdiCropRotate,
      component: TransformTool,
      manager: transformManager,
    },
    {
      type: EditToolType.Trim,
      icon: mdiContentCut,
      component: TrimTool,
      manager: trimManager,
    },
  ];

  currentAsset = $state<AssetResponseDto | null>(null);
  selectedTool = $state<EditTool | null>(null);

  // used to disable multiple confirm dialogs and mouse events while one is open
  isShowingConfirmDialog = $state(false);
  isApplyingEdits = $state(false);
  hasAppliedEdits = $state(false);
  resultAssetId = $state<string | null>(null);
  pendingSave = $state<{ operationId: string; assetId: string } | null>(null);
  pendingRequest = $state<{ assetId: string; dto: AssetEditSaveCreateDto } | null>(null);

  hasUnsavedChanges = $derived(this.tools.some((t) => t.manager.hasChanges) && !this.hasAppliedEdits);
  canReset = $derived(this.tools.some((t) => t.manager.canReset));

  async closeConfirm(): Promise<boolean> {
    // Prevent multiple dialogs (usually happens with rapid escape key presses)
    if (this.isShowingConfirmDialog) {
      return false;
    }

    if (!this.hasUnsavedChanges) {
      return true;
    }

    this.isShowingConfirmDialog = true;

    const t = await getFormatter();

    const confirmed = await modalManager.show(ConfirmModal, {
      title: t('editor_discard_edits_title'),
      prompt: t('editor_discard_edits_prompt'),
      confirmText: t('editor_discard_edits_confirm'),
    });

    this.isShowingConfirmDialog = false;

    return confirmed;
  }

  reset() {
    for (const tool of this.tools) {
      tool.manager.onDeactivate?.();
    }
    this.selectedTool = this.tools[0];
  }

  async activateTool(toolType: EditToolType, asset: AssetResponseDto, edits: AssetEditsCreateDto) {
    this.hasAppliedEdits = false;
    this.resultAssetId = null;
    if (this.selectedTool?.type === toolType) {
      return;
    }

    this.currentAsset = asset;

    this.selectedTool?.manager.onDeactivate?.();
    const newTool = this.tools.find((t) => t.type === toolType);
    if (newTool) {
      this.selectedTool = newTool;
      await newTool.manager.onActivate?.(asset, edits.edits);
    }
  }

  cleanup() {
    for (const tool of this.tools) {
      tool.manager.onDeactivate?.();
    }
    this.currentAsset = null;
    this.selectedTool = null;
  }

  async resetAllChanges() {
    for (const tool of this.tools) {
      await tool.manager.resetAllChanges();
    }
  }

  async applyEdits(): Promise<boolean> {
    this.isApplyingEdits = true;

    const edits = this.selectedTool ? this.selectedTool.manager.edits : [];
    if (!this.currentAsset) {
      return false;
    }

    const assetId = this.currentAsset.id;
    const t = await getFormatter();

    try {
      // Setup the websocket listener before sending the edit request
      const timeout = this.currentAsset?.type === AssetTypeEnum.Video ? 30_000 : 10_000;
      const editCompleted = waitForWebsocketEvent('AssetEditReadyV2', (event) => event.asset.id === assetId, timeout);

      await (edits.length === 0
        ? removeAssetEdits({ id: assetId })
        : editAsset({
            id: assetId,
            assetEditsCreateDto: {
              edits,
            },
          }));

      await editCompleted;

      const refreshedAsset = await getAssetInfo({ id: assetId });
      eventManager.emit('AssetUpdate', refreshedAsset);
      eventManager.emit('AssetEditsApplied', assetId);

      toastManager.primary(t('editor_edits_applied_success'));
      this.hasAppliedEdits = true;

      return true;
    } catch {
      toastManager.danger(t('editor_edits_applied_error'));
      return false;
    } finally {
      this.isApplyingEdits = false;
    }
  }

  async saveImageEdits(): Promise<boolean> {
    if (!this.currentAsset || this.isApplyingEdits || this.isShowingConfirmDialog) {
      return false;
    }
    const assetId = this.currentAsset.id;
    const t = await getFormatter();
    this.isApplyingEdits = true;
    try {
      if (!this.pendingSave || this.pendingSave.assetId !== assetId) {
        if (!this.pendingRequest || this.pendingRequest.assetId !== assetId) {
          const capabilities = await getAssetEditSaveCapabilities({ id: assetId });
          this.isShowingConfirmDialog = true;
          const mode = await modalManager.show(AssetEditSaveModal, { capabilities });
          this.isShowingConfirmDialog = false;
          if (!mode) {
            return false;
          }
          if (this.currentAsset?.id !== assetId) {
            return false;
          }
          this.pendingRequest = {
            assetId,
            dto: {
              mode,
              expectedVersion: this.currentAsset.updatedAt,
              idempotencyKey: crypto.randomUUID(),
              edits: structuredClone($state.snapshot(this.selectedTool?.manager.edits ?? [])),
            },
          };
        }
        const operation = await saveAssetEdits({ id: assetId, assetEditSaveCreateDto: this.pendingRequest.dto });
        this.pendingSave = { operationId: operation.id, assetId };
      }
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        const operation = await getAssetEditSave({ id: assetId, operationId: this.pendingSave.operationId });
        if (operation.status === AssetEditSaveStatus.Completed && operation.resultAssetId) {
          const refreshed = await getAssetInfo({ id: operation.resultAssetId });
          if (this.currentAsset?.id !== assetId) {
            return false;
          }
          this.resultAssetId = refreshed.id;
          eventManager.emit('AssetUpdate', refreshed);
          eventManager.emit('AssetEditsApplied', refreshed.id);
          this.pendingSave = null;
          this.pendingRequest = null;
          this.hasAppliedEdits = true;
          toastManager.primary(t('editor_edits_applied_success'));
          return true;
        }
        if (operation.status === AssetEditSaveStatus.Failed || operation.status === AssetEditSaveStatus.Conflict) {
          this.pendingSave = null;
          this.pendingRequest = null;
          const failures = {
            source_changed: 'editor_save_failed_source_changed',
            duplicate: 'editor_save_failed_duplicate',
            unsupported_format: 'editor_save_failed_unsupported_format',
            quota_exceeded: 'editor_save_failed_quota_exceeded',
            not_writable: 'editor_save_failed_not_writable',
            storage_full: 'editor_save_failed_storage_full',
            source_unavailable: 'editor_save_failed_source_unavailable',
            save_failed: 'editor_save_failed_save_failed',
          } as const;
          toastManager.danger(t(failures[operation.error as keyof typeof failures] ?? failures.save_failed));
          return false;
        }
        if (operation.error === 'recovery_required') {
          toastManager.danger(t('editor_save_recovery_required'));
          return false;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
      }
      toastManager.primary(t('editor_save_pending'));
      return false;
    } catch (error) {
      if (!this.pendingSave && isHttpError(error) && error.status >= 400 && error.status < 500) {
        this.pendingRequest = null;
        toastManager.danger(
          t(error.status === 409 ? 'editor_save_failed_source_changed' : 'editor_edits_applied_error'),
        );
      } else {
        toastManager.danger(
          t(this.pendingSave || this.pendingRequest ? 'editor_save_status_unavailable' : 'editor_edits_applied_error'),
        );
      }
      return false;
    } finally {
      this.isApplyingEdits = false;
      this.isShowingConfirmDialog = false;
    }
  }
}

export const editManager = new EditManager();
