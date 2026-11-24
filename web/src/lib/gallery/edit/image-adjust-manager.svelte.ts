import {
  NEUTRAL_IMAGE_ADJUST,
  imageAdjustFilter,
  isNeutralImageAdjust,
  isSameImageAdjust,
  type ImageAdjust,
} from '#lib/gallery/edit/image-adjust.ts';
import type { EditActions, EditToolManager, ImageEditSaveOptions } from '#lib/managers/edit/edit-manager.svelte.ts';
import { getAssetAdjust, type AssetResponseDto } from '@immich/sdk';

/**
The Adjust panel's state: exposure, contrast, saturation and invert, saved through `PUT /assets/{id}/adjust`
(stored beside asset_edit, not in it, so stock Immich clients never see an action they cannot decode).
*/
export class ImageAdjustManager {
  /** Which half of the transform panel shows: the Adjust sliders or Immich's crop grid. */
  mode = $state<'edit' | 'crop'>('edit');

  exposure = $state(0);
  contrast = $state(0);
  saturation = $state(0);
  invert = $state(false);

  /** The adjustment the server holds, so an unchanged panel saves nothing. */
  #saved = $state<ImageAdjust>({ ...NEUTRAL_IMAGE_ADJUST });

  current: ImageAdjust = $derived({
    exposure: this.exposure,
    contrast: this.contrast,
    saturation: this.saturation,
    invert: this.invert,
  });

  hasChanges = $derived(!isSameImageAdjust(this.current, this.#saved));
  canReset = $derived(!isNeutralImageAdjust(this.current));
  filter = $derived(imageAdjustFilter(this.current));

  async load(assetId: string) {
    this.#set(NEUTRAL_IMAGE_ADJUST);
    this.#saved = { ...NEUTRAL_IMAGE_ADJUST };
    const adjust = await getAssetAdjust({ id: assetId });
    this.#saved = { ...adjust };
    this.#set(adjust);
  }

  resetAllChanges() {
    this.#set(NEUTRAL_IMAGE_ADJUST);
  }

  reset() {
    this.mode = 'edit';
    this.#set(NEUTRAL_IMAGE_ADJUST);
    this.#saved = { ...NEUTRAL_IMAGE_ADJUST };
  }

  #set({ exposure, contrast, saturation, invert }: ImageAdjust) {
    this.exposure = exposure;
    this.contrast = contrast;
    this.saturation = saturation;
    this.invert = invert;
  }
}

export const imageAdjustManager = new ImageAdjustManager();

export type SaveImageComposition = (
  assetId: string,
  edits: EditActions,
  adjust: ImageAdjust,
  options?: ImageEditSaveOptions,
) => Promise<boolean>;

/** Fold Adjust into the official tool save hook; persist geometry and colour in one recoverable operation. */
export const withImageAdjust = (
  transform: EditToolManager,
  saveComposition: SaveImageComposition,
  adjust = imageAdjustManager,
): EditToolManager => ({
  async onActivate(asset: AssetResponseDto, edits: EditActions) {
    await Promise.all([transform.onActivate(asset, edits), adjust.load(asset.id)]);
  },
  onDeactivate() {
    transform.onDeactivate();
    adjust.reset();
  },
  async resetAllChanges() {
    await transform.resetAllChanges();
    adjust.resetAllChanges();
  },
  get hasChanges() {
    return transform.hasChanges || adjust.hasChanges;
  },
  get canReset() {
    return transform.canReset || adjust.canReset;
  },
  get edits() {
    return transform.edits;
  },
  save(assetId, options) {
    return saveComposition(assetId, options?.edits ?? transform.edits, { ...adjust.current }, options);
  },
});
