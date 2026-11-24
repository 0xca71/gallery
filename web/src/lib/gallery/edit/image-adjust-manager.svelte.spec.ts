import { ImageAdjustManager, withImageAdjust } from '#lib/gallery/edit/image-adjust-manager.svelte.ts';
import { imageAdjustFilter } from '#lib/gallery/edit/image-adjust.ts';
import type { EditToolManager } from '#lib/managers/edit/edit-manager.svelte.ts';
import { factory } from '#test/unit/factories.ts';
import { AssetEditSaveMode, getAssetAdjust } from '@immich/sdk';

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
const stored = { exposure: 15, contrast: -5, saturation: 40, invert: true };

const transformTool = (overrides: Partial<EditToolManager> = {}): EditToolManager => ({
  onActivate: vi.fn(),
  onDeactivate: vi.fn(),
  resetAllChanges: vi.fn(),
  hasChanges: false,
  canReset: false,
  edits: [],
  ...overrides,
});

describe('imageAdjustFilter', () => {
  it('is empty for a neutral adjustment', () => {
    expect(imageAdjustFilter({ exposure: 0, contrast: 0, saturation: 0, invert: false })).toBe('');
  });

  it('orders the functions as the server renders them: saturate, invert, brightness, contrast', () => {
    expect(imageAdjustFilter({ exposure: 20, contrast: 30, saturation: -50, invert: true })).toBe(
      'saturate(0.5) invert(1) brightness(1.2) contrast(1.3)',
    );
  });
});

describe(ImageAdjustManager.name, () => {
  let manager: ImageAdjustManager;

  beforeEach(() => {
    vi.resetAllMocks();
    manager = new ImageAdjustManager();
  });

  it('loads the stored adjustment without counting it as a change', async () => {
    vi.mocked(getAssetAdjust).mockResolvedValue(stored);

    await manager.load('asset-1');

    expect(manager.current).toEqual(stored);
    expect(manager.hasChanges).toBe(false);
    expect(manager.canReset).toBe(true);
  });

  it('counts a slider move as a change, and moving it back as none', async () => {
    vi.mocked(getAssetAdjust).mockResolvedValue(stored);
    await manager.load('asset-1');

    manager.exposure = 30;
    expect(manager.hasChanges).toBe(true);

    manager.exposure = 15;
    expect(manager.hasChanges).toBe(false);
  });

  it('rejects loading failure so the editor cannot silently overwrite stored Adjust', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(getAssetAdjust).mockRejectedValue(new Error('offline'));

    await expect(manager.load('asset-1')).rejects.toThrow('offline');

    expect(manager.current).toEqual({ exposure: 0, contrast: 0, saturation: 0, invert: false });
  });

  it('previews the current values', () => {
    manager.saturation = -100;
    expect(manager.filter).toBe('saturate(0)');
  });

  it('returns to the sliders and neutral values on reset', () => {
    manager.mode = 'crop';
    manager.contrast = 10;

    manager.reset();

    expect(manager.mode).toBe('edit');
    expect(manager.canReset).toBe(false);
    expect(manager.hasChanges).toBe(false);
  });
});

describe('withImageAdjust', () => {
  let adjust: ImageAdjustManager;
  const saveComposition = vi.fn().mockResolvedValue(true);
  const asset = factory.asset();

  beforeEach(() => {
    vi.resetAllMocks();
    adjust = new ImageAdjustManager();
    vi.mocked(getAssetAdjust).mockResolvedValue({ exposure: 0, contrast: 0, saturation: 0, invert: false });
    saveComposition.mockResolvedValue(true);
  });

  it('activates both the transform tool and the adjustment', async () => {
    const transform = transformTool();
    vi.mocked(getAssetAdjust).mockResolvedValue(stored);

    await withImageAdjust(transform, saveComposition, adjust).onActivate(asset, []);

    expect(transform.onActivate).toHaveBeenCalledWith(asset, []);
    expect(adjust.current).toEqual(stored);
  });

  it('reports a slider change as an unsaved change of the tool', () => {
    const tool = withImageAdjust(transformTool(), saveComposition, adjust);
    expect(tool.hasChanges).toBe(false);

    adjust.exposure = 5;

    expect(tool.hasChanges).toBe(true);
    expect(tool.canReset).toBe(true);
  });

  it('resets both on reset all', async () => {
    const transform = transformTool();
    adjust.invert = true;

    await withImageAdjust(transform, saveComposition, adjust).resetAllChanges();

    expect(transform.resetAllChanges).toHaveBeenCalled();
    expect(adjust.canReset).toBe(false);
  });

  it('saves geometry and the full current Adjust in a single operation', async () => {
    const edits = [{ action: 'rotate', parameters: { angle: 90 } }] as EditToolManager['edits'];
    adjust.invert = true;
    await withImageAdjust(transformTool({ edits }), saveComposition, adjust).save!(asset.id, {
      mode: AssetEditSaveMode.Copy,
    });
    expect(saveComposition).toHaveBeenCalledExactlyOnceWith(
      asset.id,
      edits,
      { exposure: 0, contrast: 0, saturation: 0, invert: true },
      { mode: AssetEditSaveMode.Copy },
    );
    expect(adjust.invert).toBe(true);
  });

  it('passes neutral Adjust explicitly after resetting both tools', async () => {
    const transform = transformTool();
    const tool = withImageAdjust(transform, saveComposition, adjust);
    vi.mocked(getAssetAdjust).mockResolvedValue(stored);
    await tool.onActivate(asset, []);
    await tool.resetAllChanges();
    await tool.save!(asset.id);
    expect(saveComposition).toHaveBeenCalledWith(
      asset.id,
      [],
      { exposure: 0, contrast: 0, saturation: 0, invert: false },
      undefined,
    );
  });

  it('passes direct navigator crop geometry through the same hook', async () => {
    const crop = [
      { action: 'crop', parameters: { x: 20, y: 30, width: 400, height: 300 } },
    ] as EditToolManager['edits'];
    const options = { edits: crop, mode: AssetEditSaveMode.Overwrite };
    await withImageAdjust(transformTool(), saveComposition, adjust).save!(asset.id, options);
    expect(saveComposition).toHaveBeenCalledWith(
      asset.id,
      crop,
      { exposure: 0, contrast: 0, saturation: 0, invert: false },
      options,
    );
  });

  it('keeps slider edits when persistence fails', async () => {
    adjust.exposure = 10;
    saveComposition.mockResolvedValue(false);
    expect(await withImageAdjust(transformTool(), saveComposition, adjust).save!(asset.id)).toBe(false);
    expect(adjust.exposure).toBe(10);
    expect(adjust.hasChanges).toBe(true);
  });
});
