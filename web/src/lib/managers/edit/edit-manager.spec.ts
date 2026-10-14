import {
  AssetEditSaveMode,
  AssetEditSaveStatus,
  editAsset,
  getAssetInfo,
  removeAssetEdits,
  getAssetEditSaveCapabilities,
  getAssetEditSave,
  saveAssetEdits,
} from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import type { MessageFormatter } from 'svelte-i18n';
import { EditManager } from '$lib/managers/edit/edit-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { getFormatter } from '$lib/utils/i18n';
import { assetFactory } from '@test-data/factories/asset-factory';
import { websocketMock } from '@test-data/mocks/websocket.mock';

vi.mock('@immich/sdk');
vi.mock('$lib/stores/websocket');
vi.mock('$lib/modals/AssetEditSaveModal.svelte', () => ({ default: {} }));
vi.mock('$lib/utils/i18n', () => ({
  getFormatter: vi.fn(),
  getPreferredLocale: vi.fn(),
}));
vi.mock('@immich/ui', () => ({
  toastManager: { success: vi.fn(), danger: vi.fn(), primary: vi.fn() },
  modalManager: { show: vi.fn() },
  ConfirmModal: {},
}));
vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('$lib/managers/edit/transform-manager.svelte', () => ({
  transformManager: {
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    resetAllChanges: vi.fn(),
    hasChanges: false,
    canReset: false,
    edits: [],
  },
}));
vi.mock('$lib/components/asset-viewer/editor/transform-tool/transform-tool.svelte', () => ({
  default: {},
}));
vi.mock('$lib/managers/edit/trim-manager.svelte', () => ({
  trimManager: {
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    resetAllChanges: vi.fn(),
    hasChanges: false,
    canReset: false,
    edits: [],
  },
}));
vi.mock('$lib/components/asset-viewer/editor/trim-tool/trim-tool.svelte', () => ({
  default: {},
}));

describe('EditManager', () => {
  let editManager: EditManager;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getFormatter).mockResolvedValue(((key: string) => key) as MessageFormatter);
    websocketMock.waitForWebsocketEvent.mockResolvedValue(undefined as never);
    editManager = new EditManager();
  });

  describe('applyEdits', () => {
    it('should return false if no current asset', async () => {
      const result = await editManager.applyEdits();
      expect(result).toBe(false);
    });

    it('should call editAsset and emit AssetUpdate on success', async () => {
      const asset = assetFactory.build();
      const refreshedAsset = assetFactory.build({ id: asset.id, thumbhash: 'new-thumbhash' });
      vi.mocked(editAsset).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      editManager.currentAsset = asset;
      const result = await editManager.applyEdits();

      expect(result).toBe(true);
      expect(getAssetInfo).toHaveBeenCalledWith({ id: asset.id });
      expect(eventManager.emit).toHaveBeenCalledWith('AssetUpdate', refreshedAsset);
      expect(eventManager.emit).toHaveBeenCalledWith('AssetEditsApplied', asset.id);
      expect(toastManager.primary).toHaveBeenCalled();
    });

    it('should emit AssetUpdate before AssetEditsApplied', async () => {
      const asset = assetFactory.build();
      const refreshedAsset = assetFactory.build({ id: asset.id });
      vi.mocked(editAsset).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      const emitCalls: string[] = [];
      vi.mocked(eventManager.emit).mockImplementation(((event: string) => {
        emitCalls.push(event);
      }) as typeof eventManager.emit);

      editManager.currentAsset = asset;
      await editManager.applyEdits();

      expect(emitCalls).toEqual(['AssetUpdate', 'AssetEditsApplied']);
    });

    it('should call removeAssetEdits when edits are empty', async () => {
      const asset = assetFactory.build();
      const refreshedAsset = assetFactory.build({ id: asset.id });
      vi.mocked(removeAssetEdits).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      editManager.currentAsset = asset;
      // tools have empty edits by default from the mock
      const result = await editManager.applyEdits();

      expect(result).toBe(true);
      expect(removeAssetEdits).toHaveBeenCalledWith({ id: asset.id });
      expect(editAsset).not.toHaveBeenCalled();
    });

    it('should return false and show error toast on failure', async () => {
      const asset = assetFactory.build();
      vi.mocked(removeAssetEdits).mockRejectedValue(new Error('fail'));

      editManager.currentAsset = asset;
      const result = await editManager.applyEdits();

      expect(result).toBe(false);
      expect(toastManager.danger).toHaveBeenCalled();
      expect(eventManager.emit).not.toHaveBeenCalled();
    });

    it('should set hasAppliedEdits to true on success', async () => {
      const asset = assetFactory.build();
      const refreshedAsset = assetFactory.build({ id: asset.id });
      vi.mocked(editAsset).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      editManager.currentAsset = asset;
      expect(editManager.hasAppliedEdits).toBe(false);

      await editManager.applyEdits();
      expect(editManager.hasAppliedEdits).toBe(true);
    });

    it('should set isApplyingEdits during the operation', async () => {
      const asset = assetFactory.build();
      const refreshedAsset = assetFactory.build({ id: asset.id });
      vi.mocked(editAsset).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      editManager.currentAsset = asset;
      expect(editManager.isApplyingEdits).toBe(false);

      const promise = editManager.applyEdits();
      expect(editManager.isApplyingEdits).toBe(true);

      await promise;
      expect(editManager.isApplyingEdits).toBe(false);
    });
  });

  describe('saveImageEdits', () => {
    const operation = (
      status: AssetEditSaveStatus,
      resultAssetId: string | null = null,
      error: string | null = null,
    ) => ({
      id: 'operation-id',
      assetId: 'source-id',
      resultAssetId,
      mode: AssetEditSaveMode.Copy,
      status,
      error,
    });
    beforeEach(() => {
      editManager.currentAsset = assetFactory.build({ id: 'source-id' });
      vi.mocked(getAssetEditSaveCapabilities).mockResolvedValue({
        canCopy: true,
        canOverwrite: true,
        overwriteUnavailableReason: null,
        outputFormat: 'png',
      });
      vi.mocked(modalManager.show).mockResolvedValue(AssetEditSaveMode.Copy as never);
      vi.mocked(saveAssetEdits).mockResolvedValue(operation(AssetEditSaveStatus.Queued));
    });

    it('cancels without starting a save or discarding the edits', async () => {
      vi.mocked(modalManager.show).mockResolvedValue(null as never);
      expect(await editManager.saveImageEdits()).toBe(false);
      expect(saveAssetEdits).not.toHaveBeenCalled();
      expect(editManager.hasAppliedEdits).toBe(false);
    });

    it('opens the independent result and publishes its update after a copy completes', async () => {
      const result = assetFactory.build({ id: 'copy-id' });
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, result.id));
      vi.mocked(getAssetInfo).mockResolvedValue(result);
      expect(await editManager.saveImageEdits()).toBe(true);
      expect(saveAssetEdits).toHaveBeenCalledWith({
        id: 'source-id',
        assetEditSaveCreateDto: expect.objectContaining({
          mode: AssetEditSaveMode.Copy,
          expectedVersion: editManager.currentAsset!.updatedAt,
          edits: [],
        }),
      });
      expect(editManager.resultAssetId).toBe('copy-id');
      expect(eventManager.emit).toHaveBeenCalledWith('AssetUpdate', result);
      expect(editManager.pendingRequest).toBeNull();
    });

    it('uses the overwrite choice and keeps the original identity', async () => {
      vi.mocked(modalManager.show).mockResolvedValue(AssetEditSaveMode.Overwrite as never);
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, 'source-id'));
      vi.mocked(getAssetInfo).mockResolvedValue(editManager.currentAsset!);
      expect(await editManager.saveImageEdits()).toBe(true);
      expect(saveAssetEdits).toHaveBeenCalledWith(
        expect.objectContaining({
          assetEditSaveCreateDto: expect.objectContaining({ mode: AssetEditSaveMode.Overwrite }),
        }),
      );
      expect(editManager.resultAssetId).toBe('source-id');
    });

    it('reuses the idempotency key if the creation response is lost', async () => {
      vi.mocked(saveAssetEdits)
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce(operation(AssetEditSaveStatus.Queued));
      expect(await editManager.saveImageEdits()).toBe(false);
      const first = vi.mocked(saveAssetEdits).mock.calls[0][0];
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, 'copy-id'));
      vi.mocked(getAssetInfo).mockResolvedValue(assetFactory.build({ id: 'copy-id' }));
      expect(await editManager.saveImageEdits()).toBe(true);
      expect(vi.mocked(saveAssetEdits).mock.calls[1][0]).toEqual(first);
      expect(modalManager.show).toHaveBeenCalledTimes(1);
    });

    it('resumes status polling after a disconnect without creating another file', async () => {
      vi.mocked(getAssetEditSave)
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce(operation(AssetEditSaveStatus.Completed, 'copy-id'));
      vi.mocked(getAssetInfo).mockResolvedValue(assetFactory.build({ id: 'copy-id' }));
      expect(await editManager.saveImageEdits()).toBe(false);
      expect(editManager.pendingSave?.operationId).toBe('operation-id');
      expect(await editManager.saveImageEdits()).toBe(true);
      expect(saveAssetEdits).toHaveBeenCalledTimes(1);
    });

    it.each([AssetEditSaveStatus.Failed, AssetEditSaveStatus.Conflict])(
      'keeps edits after a %s save',
      async (status) => {
        vi.mocked(getAssetEditSave).mockResolvedValue(operation(status, null, 'source_changed'));
        expect(await editManager.saveImageEdits()).toBe(false);
        expect(editManager.hasAppliedEdits).toBe(false);
        expect(editManager.pendingSave).toBeNull();
        expect(toastManager.danger).toHaveBeenCalledWith('editor_save_failed_source_changed');
      },
    );

    it('keeps the operation handle when recovery retains the original backup', async () => {
      vi.mocked(getAssetEditSave).mockResolvedValue(
        operation(AssetEditSaveStatus.Publishing, null, 'recovery_required'),
      );
      expect(await editManager.saveImageEdits()).toBe(false);
      expect(editManager.pendingSave?.operationId).toBe('operation-id');
      expect(toastManager.danger).toHaveBeenCalledWith('editor_save_recovery_required');
    });
  });
});
