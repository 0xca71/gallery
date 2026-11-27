import { websocketMock } from '#lib/gallery/__mocks__/websocket.mock.ts';
import { imageAdjustManager } from '#lib/gallery/edit/image-adjust-manager.svelte.ts';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { EditManager, EditToolType, generateIdempotencyKey } from '#lib/managers/edit/edit-manager.svelte.ts';
import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { factory } from '#test/unit/factories.ts';
import {
  AssetEditAction,
  AssetEditSaveFormat,
  AssetEditSaveMode,
  AssetEditSaveStatus,
  AssetTypeEnum,
  editAsset,
  getAssetAdjust,
  getAssetEditSave,
  getAssetEditSaveCapabilities,
  getAssetEdits,
  getAssetInfo,
  removeAssetEdits,
  saveAssetEdits,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import type { MessageFormatter } from 'svelte-i18n';

// Browser mode cannot automock `@immich/sdk` (its build uses `export *`): replace each function with a mock.
vi.mock('@immich/sdk', async (importOriginal) => {
  const module = await importOriginal<typeof import('@immich/sdk')>();
  const mocks = Object.fromEntries(
    Object.entries(module)
      .filter(([, value]) => typeof value === 'function')
      .map(([key]) => [key, vi.fn()]),
  );
  return { ...module, ...mocks };
});
vi.mock(import('#lib/stores/websocket.ts'), async (importOriginal) => {
  const module = await importOriginal();
  return Object.fromEntries(
    Object.entries(module).map(([key, value]) => [key, typeof value === 'function' ? vi.fn() : value]),
  ) as unknown as typeof module;
});
vi.mock('#lib/utils/i18n.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/utils/i18n.ts')>()),
  getFormatter: vi.fn(),
  getPreferredLocale: vi.fn(),
}));
// Browser mode rejects an import of a name the mock does not export, so keep the module's other exports.
vi.mock('@immich/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/ui')>()),
  toastManager: { success: vi.fn(), danger: vi.fn(), primary: vi.fn() },
  modalManager: { show: vi.fn() },
  ConfirmModal: {},
}));
vi.mock('#lib/managers/event-manager.svelte.ts', () => ({
  eventManager: { emit: vi.fn(), on: vi.fn() },
}));
vi.mock('#lib/managers/edit/transform-manager.svelte.ts', () => ({
  transformManager: {
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    resetAllChanges: vi.fn(),
    hasChanges: false,
    canReset: false,
    edits: [],
  },
}));
vi.mock('#lib/components/asset-viewer/editor/transform-tool/TransformTool.svelte', () => ({
  default: {},
}));
vi.mock('#lib/managers/edit/trim-manager.svelte.ts', () => ({
  trimManager: {
    onActivate: vi.fn(),
    onDeactivate: vi.fn(),
    resetAllChanges: vi.fn(),
    hasChanges: false,
    canReset: false,
    edits: [],
  },
}));
vi.mock('#lib/components/asset-viewer/editor/trim-tool/trim-tool.svelte', () => ({
  default: {},
}));

describe('EditManager', () => {
  let editManager: EditManager;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getFormatter).mockResolvedValue(((key: string) => key) as MessageFormatter);
    websocketMock.waitForWebsocketEvent.mockResolvedValue(undefined as never);
    imageAdjustManager.reset();
    vi.mocked(getAssetAdjust).mockResolvedValue({ exposure: 0, contrast: 0, saturation: 0, invert: false });
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: 'source-id', edits: [] });
    authManager.setUser(factory.user());
    editManager = new EditManager();
  });

  describe('applyEdits', () => {
    it('should return false if no current asset', async () => {
      const result = await editManager.applyEdits();
      expect(result).toBe(false);
    });

    it('should call editAsset and emit AssetUpdate on success', async () => {
      const asset = factory.asset({ type: AssetTypeEnum.Video });
      const refreshedAsset = factory.asset({ id: asset.id, thumbhash: 'new-thumbhash' });
      vi.mocked(editAsset).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      editManager.currentAsset = asset;
      const result = await editManager.applyEdits();

      expect(result).toBe(true);
      expect(getAssetInfo).toHaveBeenCalledWith({ id: asset.id, spaceId: undefined });
      expect(eventManager.emit).toHaveBeenCalledWith('AssetUpdate', refreshedAsset);
      expect(eventManager.emit).toHaveBeenCalledWith('AssetEditsApplied', asset.id);
      expect(toastManager.primary).toHaveBeenCalled();
    });

    it('should emit AssetUpdate before AssetEditsApplied', async () => {
      const asset = factory.asset({ type: AssetTypeEnum.Video });
      const refreshedAsset = factory.asset({ id: asset.id });
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
      const asset = factory.asset({ type: AssetTypeEnum.Video });
      const refreshedAsset = factory.asset({ id: asset.id });
      vi.mocked(removeAssetEdits).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      editManager.currentAsset = asset;
      // tools have empty edits by default from the mock
      const result = await editManager.applyEdits();

      expect(result).toBe(true);
      expect(removeAssetEdits).toHaveBeenCalledWith({ id: asset.id });
      expect(editAsset).not.toHaveBeenCalled();
    });

    it('should save through the selected tool when it saves itself, and skip the edits endpoints', async () => {
      const asset = factory.asset({ type: AssetTypeEnum.Video });
      vi.mocked(getAssetInfo).mockResolvedValue(factory.asset({ id: asset.id }));
      const save = vi.fn().mockResolvedValue(undefined);
      editManager.selectedTool = {
        type: EditToolType.Trim,
        icon: '',
        component: {} as never,
        manager: { ...editManager.tools[1].manager, edits: [], save },
      };

      editManager.currentAsset = asset;
      const result = await editManager.applyEdits();

      expect(result).toBe(true);
      expect(save).toHaveBeenCalledWith(asset.id);
      expect(editAsset).not.toHaveBeenCalled();
      expect(removeAssetEdits).not.toHaveBeenCalled();
    });

    it('should return false and show error toast on failure', async () => {
      const asset = factory.asset({ type: AssetTypeEnum.Video });
      vi.mocked(removeAssetEdits).mockRejectedValue(new Error('fail'));

      editManager.currentAsset = asset;
      const result = await editManager.applyEdits();

      expect(result).toBe(false);
      expect(toastManager.danger).toHaveBeenCalled();
      expect(eventManager.emit).not.toHaveBeenCalled();
    });

    it('should set hasAppliedEdits to true on success', async () => {
      const asset = factory.asset({ type: AssetTypeEnum.Video });
      const refreshedAsset = factory.asset({ id: asset.id });
      vi.mocked(editAsset).mockResolvedValue(undefined as never);
      vi.mocked(getAssetInfo).mockResolvedValue(refreshedAsset);

      editManager.currentAsset = asset;
      expect(editManager.hasAppliedEdits).toBe(false);

      await editManager.applyEdits();
      expect(editManager.hasAppliedEdits).toBe(true);
    });

    it('should set isApplyingEdits during the operation', async () => {
      const asset = factory.asset({ type: AssetTypeEnum.Video });
      const refreshedAsset = factory.asset({ id: asset.id });
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('generateIdempotencyKey', () => {
    it('uses the native UUID generator when available', () => {
      vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'native-uuid') });

      expect(generateIdempotencyKey()).toBe('native-uuid');
    });

    it('generates a UUID v4 with getRandomValues when randomUUID is unavailable', () => {
      const bytes = Uint8Array.from({ length: 16 }, (_, index) => index);
      vi.stubGlobal('crypto', {
        getRandomValues: vi.fn((array: Uint8Array) => {
          array.set(bytes);
          return array;
        }),
      });

      const idempotencyKey = generateIdempotencyKey();

      expect(idempotencyKey).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
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
      editManager.currentAsset = factory.asset({ id: 'source-id', canEdit: true });
      editManager.selectedTool = editManager.tools[0];
      vi.mocked(getAssetEditSaveCapabilities).mockResolvedValue({
        canCopy: true,
        canOverwrite: true,
        overwriteUnavailableReason: null,
        outputFormat: AssetEditSaveFormat.Png,
      });
      vi.mocked(saveAssetEdits).mockResolvedValue(operation(AssetEditSaveStatus.Queued));
    });

    it('rejects explicit overwrite when overwrite capability is unavailable', async () => {
      vi.mocked(getAssetEditSaveCapabilities).mockResolvedValue({
        canCopy: true,
        canOverwrite: false,
        overwriteUnavailableReason: 'not_writable',
        outputFormat: AssetEditSaveFormat.Jpeg,
      });
      expect(await editManager.saveImageEdits(AssetEditSaveMode.Overwrite)).toBe(false);
      expect(saveAssetEdits).not.toHaveBeenCalled();
      expect(toastManager.danger).toHaveBeenCalledWith('editor_save_unavailable_not_writable');
      expect(editManager.hasAppliedEdits).toBe(false);
    });

    it('opens the independent result and publishes its update after a copy completes', async () => {
      const result = factory.asset({ id: 'copy-id' });
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, result.id));
      vi.mocked(getAssetInfo).mockResolvedValue(result);
      expect(await editManager.saveImageEdits(AssetEditSaveMode.Copy)).toBe(true);
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

    it('defaults to overwrite when capabilities allow it and keeps the original identity', async () => {
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

    it('falls back to copy when no mode is passed and overwrite is unavailable', async () => {
      vi.mocked(getAssetEditSaveCapabilities).mockResolvedValue({
        canCopy: true,
        canOverwrite: false,
        overwriteUnavailableReason: 'not_writable',
        outputFormat: AssetEditSaveFormat.Jpeg,
      });
      const result = factory.asset({ id: 'copy-id' });
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, result.id));
      vi.mocked(getAssetInfo).mockResolvedValue(result);
      expect(await editManager.saveImageEdits()).toBe(true);
      expect(saveAssetEdits).toHaveBeenCalledWith(
        expect.objectContaining({
          assetEditSaveCreateDto: expect.objectContaining({ mode: AssetEditSaveMode.Copy }),
        }),
      );
      expect(editManager.resultAssetId).toBe('copy-id');
    });

    it('reuses the idempotency key if the creation response is lost', async () => {
      vi.mocked(saveAssetEdits)
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce(operation(AssetEditSaveStatus.Queued));
      expect(await editManager.saveImageEdits()).toBe(false);
      const first = vi.mocked(saveAssetEdits).mock.calls[0][0];
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, 'source-id'));
      vi.mocked(getAssetInfo).mockResolvedValue(factory.asset({ id: 'source-id' }));
      expect(await editManager.saveImageEdits(AssetEditSaveMode.Copy)).toBe(true);
      expect(vi.mocked(saveAssetEdits).mock.calls[1][0]).toEqual(first);
    });

    it('resumes status polling after a disconnect without creating another file', async () => {
      vi.mocked(getAssetEditSave)
        .mockRejectedValueOnce(new Error('connection lost'))
        .mockResolvedValueOnce(operation(AssetEditSaveStatus.Completed, 'source-id'));
      vi.mocked(getAssetInfo).mockResolvedValue(factory.asset({ id: 'source-id' }));
      expect(await editManager.saveImageEdits()).toBe(false);
      expect(editManager.pendingSave?.operationId).toBe('operation-id');
      expect(await editManager.saveImageEdits()).toBe(true);
      expect(saveAssetEdits).toHaveBeenCalledTimes(1);
    });

    it.each([AssetEditSaveStatus.Failed, AssetEditSaveStatus.Conflict])(
      'keeps edits after a %s save',
      async (status) => {
        vi.mocked(getAssetInfo).mockResolvedValue(factory.asset({ id: 'source-id' }));
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

    it('saves a mobile viewer crop directly as an overwrite', async () => {
      const asset = factory.asset({ id: 'source-id', type: AssetTypeEnum.Image, canEdit: true });
      const refreshed = factory.asset({ id: 'source-id', type: AssetTypeEnum.Image, canEdit: true });
      const crop = { x: 120, y: 80, width: 640, height: 480 };
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, asset.id));
      vi.mocked(getAssetInfo).mockResolvedValue(refreshed);

      expect(await editManager.saveImageCropFromViewer(asset, crop)).toBe(true);
      expect(saveAssetEdits).toHaveBeenCalledWith({
        id: asset.id,
        assetEditSaveCreateDto: expect.objectContaining({
          mode: AssetEditSaveMode.Overwrite,
          edits: [{ action: AssetEditAction.Crop, parameters: crop }],
        }),
      });
      expect(editManager.currentAsset).toBeNull();
    });
    it('saves the full Adjust with crop/rotation via the official selected tool hook', async () => {
      const edits = [
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        { action: AssetEditAction.Crop, parameters: { x: 20, y: 30, width: 400, height: 300 } },
      ] as never;
      imageAdjustManager.exposure = 20;
      imageAdjustManager.contrast = -5;
      imageAdjustManager.saturation = 30;
      imageAdjustManager.invert = true;
      vi.mocked(getAssetEditSave).mockResolvedValue(operation(AssetEditSaveStatus.Completed, 'source-id'));
      vi.mocked(getAssetInfo).mockResolvedValue(editManager.currentAsset!);
      expect(await editManager.saveImageEdits(AssetEditSaveMode.Overwrite, edits)).toBe(true);
      expect(saveAssetEdits).toHaveBeenCalledWith(
        expect.objectContaining({
          assetEditSaveCreateDto: expect.objectContaining({
            edits,
            adjust: { exposure: 20, contrast: -5, saturation: 30, invert: true },
          }),
        }),
      );
      expect(imageAdjustManager.current).toEqual({ exposure: 0, contrast: 0, saturation: 0, invert: false });
      expect(editAsset).not.toHaveBeenCalled();
    });

    it('never guesses writable capability when the capability read fails', async () => {
      vi.mocked(getAssetEditSaveCapabilities).mockRejectedValue(new Error('offline'));
      expect(await editManager.saveImageEdits()).toBe(false);
      expect(saveAssetEdits).not.toHaveBeenCalled();
      expect(editManager.pendingRequest).toBeNull();
    });

    it('does not reset changes while an operation still needs recovery', async () => {
      const reset = vi.spyOn(editManager.tools[0].manager, 'resetAllChanges');
      editManager.pendingSave = { assetId: 'source-id', operationId: 'operation-id' };
      await editManager.resetAllChanges();
      expect(reset).not.toHaveBeenCalled();
    });
  });
});
