import TransformTool from '#lib/components/asset-viewer/editor/transform-tool/TransformTool.svelte';
import TrimTool from '#lib/components/asset-viewer/editor/trim-tool/trim-tool.svelte';
import { imageAdjustManager, withImageAdjust } from '#lib/gallery/edit/image-adjust-manager.svelte.ts';
import type { ImageAdjust } from '#lib/gallery/edit/image-adjust.ts';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { transformManager } from '#lib/managers/edit/transform-manager.svelte.ts';
import { trimManager } from '#lib/managers/edit/trim-manager.svelte.ts';
import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import AssetEditSaveModal from '#lib/modals/AssetEditSaveModal.svelte';
import { waitForWebsocketEvent } from '#lib/stores/websocket.ts';
import { sleep } from '#lib/utils.ts';
import { canEditAsset } from '#lib/utils/asset-editability.ts';
import { getDimensions } from '#lib/utils/asset-utils.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { composeViewerCrop, type CropRegion } from '#lib/utils/zoom-geometry.ts';
import {
  AssetEditSaveMode,
  AssetEditSaveStatus,
  AssetTypeEnum,
  editAsset,
  getAssetEditSave,
  getAssetEditSaveCapabilities,
  getAssetEdits,
  getAssetInfo,
  isHttpError,
  removeAssetEdits,
  saveAssetEdits,
  type AssetEditSaveCapabilitiesDto,
  type AssetEditSaveCreateDto,
  type AssetEditsCreateDto,
  type AssetResponseDto,
} from '@immich/sdk';
import { ConfirmModal, modalManager, toastManager } from '@immich/ui';
import { mdiContentCut, mdiCropRotate } from '@mdi/js';
import type { Component } from 'svelte';

export type EditAction = AssetEditsCreateDto['edits'][number];
export type EditActions = EditAction[];

export const generateIdempotencyKey = (): string => {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export type ImageEditSaveOptions = { mode?: AssetEditSaveMode; edits?: EditActions };

export interface EditToolManager {
  onActivate: (asset: AssetResponseDto, edits: EditActions) => Promise<void>;
  onDeactivate: () => void;
  resetAllChanges: () => Promise<void>;
  hasChanges: boolean;
  canReset: boolean;
  edits: EditAction[];
  /** Saves the tool's changes itself instead of through the asset edits endpoint. */
  save?: (assetId: string, options?: ImageEditSaveOptions) => Promise<unknown>;
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
      // Gallery: the Adjust panel's colour adjustment saves with the transform tool.
      manager: withImageAdjust(transformManager, (assetId, edits, adjust, options) =>
        this.persistImageEdits(assetId, edits, adjust, options?.mode),
      ),
    },
    {
      type: EditToolType.Trim,
      icon: mdiContentCut,
      component: TrimTool,
      manager: trimManager,
    },
  ];

  currentAsset = $state<AssetResponseDto | null>(null);
  spaceId: string | undefined;
  selectedTool = $state<EditTool | null>(null);

  // used to disable multiple confirm dialogs and mouse events while one is open
  isShowingConfirmDialog = $state(false);
  isApplyingEdits = $state(false);
  hasAppliedEdits = $state(false);
  resultAssetId = $state<string | null>(null);
  saveCapabilities = $state<AssetEditSaveCapabilitiesDto | null>(null);
  pendingSave = $state<{ operationId: string; assetId: string } | null>(null);
  pendingRequest = $state<{ assetId: string; dto: AssetEditSaveCreateDto } | null>(null);

  hasUnsavedChanges = $derived(this.tools.some((t) => t.manager.hasChanges) && !this.hasAppliedEdits);
  canReset = $derived(this.tools.some((t) => t.manager.canReset));

  async closeConfirm(): Promise<boolean> {
    // Prevent multiple dialogs (usually happens with rapid escape key presses)
    if (this.isShowingConfirmDialog || this.isApplyingEdits) {
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

  async activateTool(toolType: EditToolType, asset: AssetResponseDto, edits: AssetEditsCreateDto, spaceId?: string) {
    this.hasAppliedEdits = false;
    this.resultAssetId = null;
    if (this.selectedTool?.type === toolType && this.currentAsset?.id === asset.id) {
      return;
    }

    this.spaceId = spaceId;
    this.currentAsset = asset;
    this.saveCapabilities = null;

    this.selectedTool?.manager.onDeactivate?.();
    const newTool = this.tools.find((t) => t.type === toolType);
    if (newTool) {
      this.selectedTool = newTool;
      await Promise.all([
        newTool.manager.onActivate(asset, edits.edits),
        asset.type === AssetTypeEnum.Image ? this.loadSaveCapabilities(asset.id) : undefined,
      ]);
    }
  }

  async loadSaveCapabilities(assetId = this.currentAsset?.id): Promise<AssetEditSaveCapabilitiesDto | null> {
    if (!assetId) {
      return null;
    }
    try {
      const capabilities = await getAssetEditSaveCapabilities({ id: assetId });
      if (this.currentAsset?.id === assetId) {
        this.saveCapabilities = capabilities;
      }
      return capabilities;
    } catch {
      return null;
    }
  }

  cleanup() {
    for (const tool of this.tools) {
      tool.manager.onDeactivate?.();
    }
    this.currentAsset = null;
    this.selectedTool = null;
    this.saveCapabilities = null;
  }

  async resetAllChanges() {
    if (this.isApplyingEdits || this.pendingSave || this.pendingRequest) return;
    for (const tool of this.tools) {
      await tool.manager.resetAllChanges();
    }
  }

  async applyEdits(): Promise<boolean> {
    if (!this.currentAsset || this.isApplyingEdits) return false;
    if (this.currentAsset.type === AssetTypeEnum.Image) return this.saveImageEdits();
    this.isApplyingEdits = true;
    const edits = this.selectedTool?.manager.edits ?? [];

    const assetId = this.currentAsset.id;
    const t = await getFormatter();

    try {
      // Setup the websocket listener before sending the edit request
      const timeout = this.currentAsset?.type === AssetTypeEnum.Video ? 30_000 : 10_000;
      const editCompleted = waitForWebsocketEvent('AssetEditReadyV2', (event) => event.asset.id === assetId, timeout);
      editCompleted.catch(() => {});

      const tool = this.selectedTool?.manager;
      await (tool?.save
        ? tool.save(assetId)
        : edits.length === 0
          ? removeAssetEdits({ id: assetId })
          : editAsset({
              id: assetId,
              assetEditsCreateDto: {
                edits,
              },
            }));

      await editCompleted;

      const refreshedAsset = await getAssetInfo({ id: assetId, spaceId: this.spaceId });
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
  async saveImageEdits(mode?: AssetEditSaveMode, edits?: EditActions): Promise<boolean> {
    if (
      !this.currentAsset ||
      this.currentAsset.type !== AssetTypeEnum.Image ||
      this.isApplyingEdits ||
      this.hasAppliedEdits
    )
      return false;
    const tool = this.selectedTool?.manager;
    if (!tool?.save) return false;
    return (await tool.save(this.currentAsset.id, { mode, edits })) === true;
  }

  async persistImageEdits(
    assetId: string,
    edits: EditActions,
    adjust: ImageAdjust,
    requestedMode?: AssetEditSaveMode,
  ): Promise<boolean> {
    if (!this.currentAsset || this.isApplyingEdits || this.isShowingConfirmDialog) {
      return false;
    }
    if (this.currentAsset.id !== assetId) return false;
    this.isApplyingEdits = true;
    const t = await getFormatter();
    try {
      if (!this.pendingSave || this.pendingSave.assetId !== assetId) {
        if (!this.pendingRequest || this.pendingRequest.assetId !== assetId) {
          const capabilities = this.saveCapabilities ?? (await this.loadSaveCapabilities(assetId));
          if (this.currentAsset?.id !== assetId) {
            return false;
          }
          if (!capabilities) {
            toastManager.danger(t('editor_save_status_unavailable'));
            return false;
          }
          const mode =
            requestedMode ?? (capabilities.canOverwrite ? AssetEditSaveMode.Overwrite : AssetEditSaveMode.Copy);
          if (
            (mode === AssetEditSaveMode.Overwrite && !capabilities.canOverwrite) ||
            (mode === AssetEditSaveMode.Copy && !capabilities.canCopy)
          ) {
            const reason = capabilities.overwriteUnavailableReason;
            toastManager.danger(
              t(
                reason === 'unsupported_format'
                  ? 'editor_save_unavailable_unsupported_format'
                  : reason === 'save_in_progress'
                    ? 'editor_save_unavailable_save_in_progress'
                    : 'editor_save_unavailable_not_writable',
              ),
            );
            return false;
          }
          this.pendingRequest = {
            assetId,
            dto: {
              mode,
              expectedVersion: this.currentAsset.updatedAt,
              idempotencyKey: generateIdempotencyKey(),
              edits: structuredClone($state.snapshot(edits)),
              adjust: { ...adjust },
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
          const refreshed = await getAssetInfo({
            id: operation.resultAssetId,
            spaceId: operation.resultAssetId === assetId ? this.spaceId : undefined,
          });
          if (this.currentAsset?.id !== assetId) {
            return false;
          }
          this.resultAssetId = refreshed.id;
          imageAdjustManager.reset();
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
          this.currentAsset = await getAssetInfo({ id: assetId, spaceId: this.spaceId });
          await this.loadSaveCapabilities(assetId);
          return false;
        }
        if (operation.error === 'recovery_required') {
          toastManager.danger(t('editor_save_recovery_required'));
          return false;
        }
        await sleep(750);
      }
      toastManager.primary(t('editor_save_pending'));
      return false;
    } catch (error) {
      if (!this.pendingSave && isHttpError(error) && error.status >= 400 && error.status < 500) {
        this.pendingRequest = null;
        if (error.status === 409) {
          this.currentAsset = await getAssetInfo({ id: assetId, spaceId: this.spaceId });
        }
        await this.loadSaveCapabilities(assetId);
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

  async saveImageCropFromViewer(asset: AssetResponseDto, crop: CropRegion, spaceId?: string): Promise<boolean> {
    if (asset.type !== AssetTypeEnum.Image || this.isApplyingEdits || this.isShowingConfirmDialog) {
      return false;
    }

    if (!canEditAsset(asset, { userId: authManager.authenticated ? authManager.user.id : undefined })) return false;
    this.hasAppliedEdits = false;
    this.resultAssetId = null;
    this.spaceId = spaceId;
    this.currentAsset = asset;
    this.saveCapabilities = null;
    this.selectedTool = this.tools.find((tool) => tool.type === EditToolType.Transform) ?? null;
    this.isShowingConfirmDialog = true;

    try {
      const [storedEdits] = await Promise.all([getAssetEdits({ id: asset.id }), imageAdjustManager.load(asset.id)]);
      const capabilities = await this.loadSaveCapabilities(asset.id);
      if (!capabilities) {
        const t = await getFormatter();
        toastManager.danger(t('editor_save_status_unavailable'));
        return false;
      }
      const mode = capabilities.canOverwrite
        ? AssetEditSaveMode.Overwrite
        : await modalManager.show(AssetEditSaveModal, { capabilities });
      if (!mode) return false;
      this.isShowingConfirmDialog = false;
      const dimensions = asset.exifInfo ? getDimensions(asset.exifInfo) : { width: asset.width, height: asset.height };
      const source = { width: dimensions.width || asset.width || 1, height: dimensions.height || asset.height || 1 };
      const displayed = { width: asset.width || source.width, height: asset.height || source.height };
      return await this.saveImageEdits(mode, composeViewerCrop(storedEdits.edits, crop, source, displayed));
    } catch {
      const t = await getFormatter();
      toastManager.danger(t('editor_edits_applied_error'));
      return false;
    } finally {
      this.isShowingConfirmDialog = false;
      this.cleanup();
    }
  }
}

export const editManager = new EditManager();
