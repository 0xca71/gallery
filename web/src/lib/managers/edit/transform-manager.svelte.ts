import { AssetEditAction, AssetMediaSize, MirrorAxis, type AssetResponseDto, type CropParameters } from '@immich/sdk';
import { clamp } from 'lodash-es';
import { tick } from 'svelte';
import { type EditActions, type EditToolManager } from '$lib/managers/edit/edit-manager.svelte';
import { getAssetMediaUrl } from '$lib/utils';
import { getDimensions } from '$lib/utils/asset-utils';
import { normalizeTransformEdits } from '$lib/utils/editor';
import { handleError } from '$lib/utils/handle-error';

type Region = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ImageDimensions = {
  width: number;
  height: number;
};

type RegionConvertParams = {
  region: Region;
  from: ImageDimensions;
  to: ImageDimensions;
};

export enum ResizeBoundary {
  None = 'none',
  Marquee = 'marquee',
  TopLeft = 'top-left',
  TopRight = 'top-right',
  BottomLeft = 'bottom-left',
  BottomRight = 'bottom-right',
  Left = 'left',
  Right = 'right',
  Top = 'top',
  Bottom = 'bottom',
}

class TransformManager implements EditToolManager {
  canReset: boolean = $derived.by(() => this.checkEdits());
  hasChanges: boolean = $state(false);

  isInteracting = $state(false);
  isDragging = $state(false);
  animationFrame = $state<ReturnType<typeof requestAnimationFrame> | null>(null);
  dragAnchor = $state({ x: 0, y: 0 });
  marqueeStart = $state({ x: 0, y: 0 });
  hasMarqueeMoved = $state(false);
  resizeSide = $state(ResizeBoundary.None);
  imgElement = $state<HTMLImageElement | null>(null);
  cropAreaEl = $state<HTMLElement | null>(null);
  overlayEl = $state<HTMLElement | null>(null);
  cropFrame = $state<HTMLElement | null>(null);
  cropImageSize = $state<ImageDimensions>({ width: 1000, height: 1000 });
  cropImageScale = $state(1);
  cropAspectRatio = $state('free');
  originalImageSize = $state<ImageDimensions>({ width: 1000, height: 1000 });
  region = $state({ x: 0, y: 0, width: 100, height: 100 });
  baseRegion = $state({ x: 0, y: 0, width: 100, height: 100 });
  previewImageSize = $derived({
    width: this.cropImageSize.width * this.cropImageScale,
    height: this.cropImageSize.height * this.cropImageScale,
  });

  baseRotation = $state(0);
  fineRotation = $state(0);
  imageRotation = $derived(this.baseRotation + this.fineRotation);
  mirrorHorizontal = $state(false);
  mirrorVertical = $state(false);
  normalizedBaseRotation = $derived.by(() => {
    const newAngle = this.baseRotation % 360;
    return newAngle < 0 ? newAngle + 360 : newAngle;
  });
  normalizedRotation = $derived.by(() => {
    const rawAngle = this.imageRotation % 360;
    const positiveAngle = rawAngle < 0 ? rawAngle + 360 : rawAngle;
    const rounded = Math.round(positiveAngle * 100) / 100;
    return rounded >= 360 ? 0 : rounded;
  });

  edits = $derived.by(() => this.getEdits());

  setAspectRatio(aspectRatio: string) {
    this.hasChanges = true;
    this.cropAspectRatio = aspectRatio;

    if (!this.imgElement || !this.cropAreaEl) {
      return;
    }

    const newCrop = this.constrainRegionToRotatedImage(this.recalculateCrop(aspectRatio));
    if (newCrop) {
      this.animateCropChange(newCrop);
      this.region = newCrop;
      this.baseRegion = { ...newCrop };
    }
  }

  checkEdits() {
    return (
      Math.abs(this.previewImageSize.width - this.region.width) > 2 ||
      Math.abs(this.previewImageSize.height - this.region.height) > 2 ||
      this.mirrorHorizontal ||
      this.mirrorVertical ||
      this.normalizedRotation !== 0
    );
  }

  checkCropEdits() {
    return (
      Math.abs(this.previewImageSize.width - this.region.width) > 2 ||
      Math.abs(this.previewImageSize.height - this.region.height) > 2
    );
  }

  hasManualSubCrop() {
    const fullRegion = this.constrainRegionToRotatedImage({
      x: 0,
      y: 0,
      width: this.previewImageSize.width,
      height: this.previewImageSize.height,
    });
    return (
      Math.abs(fullRegion.width - this.region.width) > 2 ||
      Math.abs(fullRegion.height - this.region.height) > 2
    );
  }

  getEdits(): EditActions {
    const edits: EditActions = [];

    if (Math.abs(this.fineRotation) > 1e-4) {
      const cropRegion = this.getRotatedOriginalCropRegion();
      edits.push({
        action: AssetEditAction.Crop,
        parameters: cropRegion,
      });
    } else if (this.checkCropEdits()) {
      // Convert from display coordinates to loaded preview image coordinates
      let cropRegion = this.getRegionInPreviewCoords(this.region);

      // Transform crop coordinates to account for mirroring
      // The preview shows the mirrored image, but crop is applied before mirror on the server
      // So we need to "unmirror" the crop coordinates
      cropRegion = this.applyMirrorToCoords(cropRegion, this.cropImageSize);

      // Convert from preview image coordinates to original image coordinates
      cropRegion = this.convertRegion({
        region: cropRegion,
        from: this.cropImageSize,
        to: this.originalImageSize,
      });

      // Constrain to original image bounds (fixes possible rounding errors)
      cropRegion = this.constrainToBounds(cropRegion, this.originalImageSize);

      edits.push({
        action: AssetEditAction.Crop,
        parameters: cropRegion,
      });
    }

    // Mirror edits come before rotate in array so that compose applies rotate first, then mirror
    // This matches CSS where parent has rotate and child img has mirror transforms
    if (this.mirrorHorizontal) {
      edits.push({
        action: AssetEditAction.Mirror,
        parameters: {
          axis: MirrorAxis.Horizontal,
        },
      });
    }

    if (this.mirrorVertical) {
      edits.push({
        action: AssetEditAction.Mirror,
        parameters: {
          axis: MirrorAxis.Vertical,
        },
      });
    }

    if (this.normalizedRotation !== 0) {
      edits.push({
        action: AssetEditAction.Rotate,
        parameters: {
          angle: this.normalizedRotation,
        },
      });
    }

    return edits;
  }

  async resetAllChanges() {
    this.baseRotation = 0;
    this.fineRotation = 0;
    this.mirrorHorizontal = false;
    this.mirrorVertical = false;
    await tick();

    this.onImageLoad([]);
  }

  async onActivate(asset: AssetResponseDto, edits: EditActions): Promise<void> {
    const originalSize = getDimensions(asset.exifInfo!);
    this.originalImageSize = { width: originalSize.width ?? 0, height: originalSize.height ?? 0 };

    this.imgElement = new Image();
    this.imgElement.crossOrigin = 'anonymous';

    const imageURL = getAssetMediaUrl({
      id: asset.id,
      cacheKey: `${asset.thumbhash ?? ''}:${asset.fileModifiedAt}`,
      edited: false,
      size: AssetMediaSize.Preview,
    });

    this.imgElement.src = imageURL;
    this.imgElement.addEventListener('load', () => transformManager.onImageLoad(edits), { passive: true });
    this.imgElement.addEventListener('error', (error) => handleError(error, 'ErrorLoadingImage'), {
      passive: true,
    });

    addEventListener('mousemove', (e: MouseEvent) => transformManager.handleMouseMove(e), { passive: true });

    const transformEdits = edits.filter((e) => e.action === 'rotate' || e.action === 'mirror');

    // Normalize rotation and mirror edits to single rotation and mirror state
    // This allows edits to be imported in any order and still produce correct state
    const normalizedTransformation = normalizeTransformEdits(transformEdits);
    const nearestOrthogonal = Math.round(normalizedTransformation.rotation / 90) * 90;
    this.baseRotation = ((nearestOrthogonal % 360) + 360) % 360;
    this.fineRotation = Math.round((normalizedTransformation.rotation - nearestOrthogonal) * 10) / 10;
    this.mirrorHorizontal = normalizedTransformation.mirrorHorizontal;
    this.mirrorVertical = normalizedTransformation.mirrorVertical;

    await tick();

    this.resizeCanvas();
  }

  onDeactivate() {
    removeEventListener('mousemove', transformManager.handleMouseMove);

    this.reset();
  }

  reset() {
    this.isInteracting = false;
    this.animationFrame = null;
    this.dragAnchor = { x: 0, y: 0 };
    this.marqueeStart = { x: 0, y: 0 };
    this.hasMarqueeMoved = false;
    this.resizeSide = ResizeBoundary.None;
    this.imgElement = null;
    this.cropAreaEl = null;
    this.isDragging = false;
    this.overlayEl = null;
    this.baseRotation = 0;
    this.fineRotation = 0;
    this.mirrorHorizontal = false;
    this.mirrorVertical = false;
    this.region = { x: 0, y: 0, width: 100, height: 100 };
    this.baseRegion = { x: 0, y: 0, width: 100, height: 100 };
    this.cropImageSize = { width: 1000, height: 1000 };
    this.originalImageSize = { width: 1000, height: 1000 };
    this.cropImageScale = 1;
    this.cropAspectRatio = 'free';
    this.hasChanges = false;
  }

  mirror(axis: 'horizontal' | 'vertical') {
    this.hasChanges = true;

    if (this.normalizedBaseRotation % 180 !== 0) {
      axis = axis === 'horizontal' ? 'vertical' : 'horizontal';
    }

    if (axis === 'horizontal') {
      this.mirrorHorizontal = !this.mirrorHorizontal;
    } else {
      this.mirrorVertical = !this.mirrorVertical;
    }
  }

  async rotate(angle: number) {
    this.hasChanges = true;

    this.baseRotation += angle;
    await tick();
    this.onImageLoad();
  }

  setFineRotation(angle: number) {
    this.hasChanges = true;
    this.fineRotation = clamp(Math.round(angle * 10) / 10, -45, 45);
    this.region = this.constrainRegionToRotatedImage(this.baseRegion, this.fineRotation);
    this.draw();
  }

  recalculateCrop(aspectRatio: string = this.cropAspectRatio): Region {
    if (!this.cropAreaEl) {
      return this.region;
    }

    const canvasW = this.cropAreaEl.clientWidth;
    const canvasH = this.cropAreaEl.clientHeight;

    // Calculate new dimensions with aspect ratio
    const { newWidth: w, newHeight: h } = this.keepAspectRatio(this.region.width, this.region.height, aspectRatio);

    // Scale down if needed to fit in canvas
    let newWidth = w;
    let newHeight = h;

    if (w > canvasW) {
      newWidth = canvasW;
      newHeight = canvasW / (w / h);
    } else if (h > canvasH) {
      newHeight = canvasH;
      newWidth = canvasH * (w / h);
    }

    // Constrain position to keep crop area within canvas
    return {
      x: Math.max(0, Math.min(this.region.x, canvasW - newWidth)),
      y: Math.max(0, Math.min(this.region.y, canvasH - newHeight)),
      width: newWidth,
      height: newHeight,
    };
  }

  animateCropChange(to: Region, duration = 100) {
    if (!this.cropFrame) {
      return;
    }

    const from = this.region;
    const startTime = performance.now();
    const initialCrop = { ...from };

    const animate = (currentTime: number) => {
      const elapsedTime = currentTime - startTime;
      const progress = Math.min(elapsedTime / duration, 1);

      from.x = initialCrop.x + (to.x - initialCrop.x) * progress;
      from.y = initialCrop.y + (to.y - initialCrop.y) * progress;
      from.width = initialCrop.width + (to.width - initialCrop.width) * progress;
      from.height = initialCrop.height + (to.height - initialCrop.height) * progress;

      this.draw(from);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }

  keepAspectRatio(newWidth: number, newHeight: number, aspectRatio: string = this.cropAspectRatio) {
    const [widthRatio, heightRatio] = aspectRatio.split(':').map(Number);

    if (widthRatio && heightRatio) {
      const calculatedWidth = (newHeight * widthRatio) / heightRatio;
      return { newWidth: calculatedWidth, newHeight };
    }

    return { newWidth, newHeight };
  }

  adjustDimensions(
    newWidth: number,
    newHeight: number,
    aspectRatio: string,
    xLimit: number,
    yLimit: number,
    minSize: number,
  ) {
    if (aspectRatio === 'free') {
      return {
        newWidth: clamp(newWidth, minSize, xLimit),
        newHeight: clamp(newHeight, minSize, yLimit),
      };
    }

    let w = newWidth;
    let h = newHeight;

    const [ratioWidth, ratioHeight] = aspectRatio.split(':').map(Number);
    const aspectMultiplier = ratioWidth && ratioHeight ? ratioWidth / ratioHeight : w / h;

    h = w / aspectMultiplier;
    // When dragging a corner, use the biggest region that fits 'inside' the mouse location.
    if (h < newHeight) {
      h = newHeight;
      w = h * aspectMultiplier;
    }

    if (w > xLimit) {
      w = xLimit;
      h = w / aspectMultiplier;
    }
    if (h > yLimit) {
      h = yLimit;
      w = h * aspectMultiplier;
    }

    if (w < minSize) {
      w = minSize;
      h = w / aspectMultiplier;
    }
    if (h < minSize) {
      h = minSize;
      w = h * aspectMultiplier;
    }

    if (w / h !== aspectMultiplier) {
      if (w < minSize) {
        h = w / aspectMultiplier;
      }
      if (h < minSize) {
        w = h * aspectMultiplier;
      }
    }

    return { newWidth: w, newHeight: h };
  }

  draw(crop: Region = this.region) {
    if (!this.cropFrame) {
      return;
    }

    this.cropFrame.style.left = `${crop.x}px`;
    this.cropFrame.style.top = `${crop.y}px`;
    this.cropFrame.style.width = `${crop.width}px`;
    this.cropFrame.style.height = `${crop.height}px`;

    if (!this.overlayEl) {
      return;
    }

    this.overlayEl.style.clipPath = `
    polygon(
      0% 0%,
      0% 100%,
      100% 100%,
      100% 0%,
      0% 0%,
      ${crop.x}px ${crop.y}px,
      ${crop.x + crop.width}px ${crop.y}px,
      ${crop.x + crop.width}px ${crop.y + crop.height}px,
      ${crop.x}px ${crop.y + crop.height}px,
      ${crop.x}px ${crop.y}px
    )
  `;
  }

  onImageLoad(edits: EditActions | null = null) {
    const img = this.imgElement;
    if (!this.cropAreaEl || !img) {
      return;
    }

    this.cropImageSize = { width: img.width, height: img.height };
    const scale = this.calculateScale();

    if (edits === null) {
      const cropFrameEl = this.cropFrame;
      cropFrameEl?.classList.add('transition');
      this.baseRegion = this.normalizeCropArea(scale, this.baseRegion);
      this.region = this.constrainRegionToRotatedImage(this.baseRegion, this.fineRotation, scale);
      cropFrameEl?.addEventListener('transitionend', () => cropFrameEl?.classList.remove('transition'), {
        passive: true,
      });
    } else {
      const cropEdit = edits.find((e) => e.action === AssetEditAction.Crop);

      if (cropEdit && Math.abs(this.fineRotation) > 1e-4) {
        const params = cropEdit.parameters as CropParameters;
        this.region = this.convertRotatedCropToDisplayRegion(params, scale);
        this.baseRegion = { ...this.region };
      } else if (cropEdit) {
        const params = cropEdit.parameters as CropParameters;

        // convert from original image coordinates to loaded preview image coordinates
        // eslint-disable-next-line prefer-const
        let { x, y, width, height } = this.convertRegion({
          region: params,
          from: this.originalImageSize,
          to: this.cropImageSize,
        });

        // Transform crop coordinates to account for mirroring
        // The stored coordinates are for the original image, but we display mirrored
        // So we need to mirror the crop coordinates to match the preview
        if (this.mirrorHorizontal) {
          x = img.width - x - width;
        }
        if (this.mirrorVertical) {
          y = img.height - y - height;
        }

        // Convert from absolute pixel coordinates to display coordinates
        this.region = {
          x: x * scale,
          y: y * scale,
          width: width * scale,
          height: height * scale,
        };
        this.baseRegion = { ...this.region };
      } else {
        this.baseRegion = {
          x: 0,
          y: 0,
          width: img.width * scale,
          height: img.height * scale,
        };
        this.region = this.constrainRegionToRotatedImage(this.baseRegion, this.fineRotation, scale);
      }
    }
    this.cropImageScale = scale;

    img.style.width = `${img.width * scale}px`;
    img.style.height = `${img.height * scale}px`;

    this.draw();
  }

  calculateScale(): number {
    const img = this.imgElement;
    const cropArea = this.cropAreaEl;

    if (!cropArea || !img) {
      return 1;
    }

    const containerWidth = cropArea.clientWidth;
    const containerHeight = cropArea.clientHeight;

    // Fit image to container while maintaining aspect ratio
    let scale = containerWidth / img.width;
    if (img.height * scale > containerHeight) {
      scale = containerHeight / img.height;
    }

    return scale;
  }

  normalizeCropArea(scale: number, sourceRegion: Region = this.region) {
    const img = this.imgElement;
    if (!img) {
      return sourceRegion;
    }

    const scaleRatio = scale / this.cropImageScale;
    const scaledRegion = {
      x: sourceRegion.x * scaleRatio,
      y: sourceRegion.y * scaleRatio,
      width: sourceRegion.width * scaleRatio,
      height: sourceRegion.height * scaleRatio,
    };

    // Constrain to scaled image bounds
    return this.constrainToBounds(scaledRegion, {
      width: img.width * scale,
      height: img.height * scale,
    });
  }

  resizeCanvas() {
    const img = this.imgElement;
    const cropArea = this.cropAreaEl;

    if (!cropArea || !img) {
      return;
    }

    const scale = this.calculateScale();
    this.baseRegion = this.normalizeCropArea(scale, this.baseRegion);
    this.region = this.constrainRegionToRotatedImage(this.normalizeCropArea(scale, this.region), this.fineRotation, scale);
    this.cropImageScale = scale;

    img.style.width = `${img.width * scale}px`;
    img.style.height = `${img.height * scale}px`;

    this.draw();
  }

  handleMouseDownOn(e: MouseEvent, resizeBoundary: ResizeBoundary) {
    if (e.button !== 0) {
      return;
    }
    e.stopPropagation();

    const { mouseX, mouseY } = this.getMousePosition(e);
    this.isInteracting = true;

    const shouldStartMarquee =
      resizeBoundary === ResizeBoundary.Marquee ||
      (resizeBoundary === ResizeBoundary.None && (e.shiftKey || !this.hasManualSubCrop()));

    if (shouldStartMarquee) {
      this.resizeSide = ResizeBoundary.Marquee;
      this.isDragging = false;
      this.marqueeStart = { x: mouseX, y: mouseY };
      this.hasMarqueeMoved = false;
    } else if (resizeBoundary === ResizeBoundary.None) {
      this.resizeSide = ResizeBoundary.None;
      this.isDragging = true;
      this.dragAnchor = { x: mouseX - this.region.x, y: mouseY - this.region.y };
    } else {
      this.resizeSide = resizeBoundary;
      this.isDragging = false;
    }

    document.body.style.userSelect = 'none';
    addEventListener('mouseup', () => this.handleMouseUp(), { passive: true });
  }

  handleMouseMove(e: MouseEvent) {
    if (!this.cropAreaEl) {
      return;
    }

    const { mouseX, mouseY } = this.getMousePosition(e);

    if (this.isDragging) {
      this.moveCrop(mouseX, mouseY);
    } else if (this.resizeSide === ResizeBoundary.Marquee) {
      this.updateMarqueeCrop(mouseX, mouseY);
    } else if (this.resizeSide !== ResizeBoundary.None) {
      this.resizeCrop(mouseX, mouseY);
    }
  }

  handleMouseUp() {
    removeEventListener('mouseup', this.handleMouseUp);
    document.body.style.userSelect = '';

    this.isInteracting = false;
    this.isDragging = false;
    this.hasMarqueeMoved = false;
    this.resizeSide = ResizeBoundary.None;
  }

  getMousePosition(e: MouseEvent) {
    if (!this.cropAreaEl) {
      throw new Error('Crop area is undefined');
    }
    const clientRect = this.cropAreaEl.getBoundingClientRect();

    switch (this.normalizedBaseRotation) {
      case 90: {
        return {
          mouseX: e.clientY - clientRect.top,
          mouseY: -e.clientX + clientRect.right,
        };
      }
      case 180: {
        return {
          mouseX: -e.clientX + clientRect.right,
          mouseY: -e.clientY + clientRect.bottom,
        };
      }
      case 270: {
        return {
          mouseX: -e.clientY + clientRect.bottom,
          mouseY: e.clientX - clientRect.left,
        };
      }
      // also case 0:
      default: {
        return {
          mouseX: e.clientX - clientRect.left,
          mouseY: e.clientY - clientRect.top,
        };
      }
    }
  }

  moveCrop(mouseX: number, mouseY: number) {
    const cropArea = this.cropAreaEl;
    if (!cropArea) {
      return;
    }

    this.hasChanges = true;
    const movedRegion = {
      ...this.region,
      x: clamp(mouseX - this.dragAnchor.x, 0, cropArea.clientWidth - this.region.width),
      y: clamp(mouseY - this.dragAnchor.y, 0, cropArea.clientHeight - this.region.height),
    };
    this.region = this.constrainRegionToRotatedImage(movedRegion);
    this.baseRegion = { ...this.region };

    this.draw();
  }

  updateMarqueeCrop(mouseX: number, mouseY: number) {
    const canvas = this.cropAreaEl;
    if (!canvas) {
      return;
    }

    const x0 = clamp(this.marqueeStart.x, 0, canvas.clientWidth);
    const y0 = clamp(this.marqueeStart.y, 0, canvas.clientHeight);
    const clampedX = clamp(mouseX, 0, canvas.clientWidth);
    const clampedY = clamp(mouseY, 0, canvas.clientHeight);

    if (!this.hasMarqueeMoved) {
      if (Math.hypot(clampedX - x0, clampedY - y0) < 6) {
        return;
      }
      this.hasMarqueeMoved = true;
    }

    this.hasChanges = true;
    const minSize = 20;
    const dirX = clampedX >= x0 ? 1 : -1;
    const dirY = clampedY >= y0 ? 1 : -1;
    const xLimit = Math.max(minSize, dirX >= 0 ? canvas.clientWidth - x0 : x0);
    const yLimit = Math.max(minSize, dirY >= 0 ? canvas.clientHeight - y0 : y0);
    const desiredWidth = Math.max(minSize, Math.abs(clampedX - x0));
    const desiredHeight = Math.max(minSize, Math.abs(clampedY - y0));

    const { newWidth: w, newHeight: h } = this.adjustDimensions(
      desiredWidth,
      desiredHeight,
      this.cropAspectRatio,
      xLimit,
      yLimit,
      minSize,
    );

    const newRegion = {
      x: dirX >= 0 ? x0 : Math.max(0, x0 - w),
      y: dirY >= 0 ? y0 : Math.max(0, y0 - h),
      width: w,
      height: h,
    };

    this.region = this.constrainRegionToRotatedImage(newRegion);
    this.baseRegion = { ...this.region };
    this.draw();
  }

  resizeCrop(mouseX: number, mouseY: number) {
    const canvas = this.cropAreaEl;
    const currentCrop = this.region;
    if (!canvas) {
      return;
    }
    this.isInteracting = true;

    this.hasChanges = true;
    const { x, y, width, height } = currentCrop;
    const minSize = 24;
    let newRegion = { ...currentCrop };

    let desiredWidth = width;
    let desiredHeight = height;

    // Width
    switch (this.resizeSide) {
      case ResizeBoundary.Left:
      case ResizeBoundary.TopLeft:
      case ResizeBoundary.BottomLeft: {
        desiredWidth = Math.max(minSize, width + (x - Math.max(mouseX, 0)));
        break;
      }
      case ResizeBoundary.Right:
      case ResizeBoundary.TopRight:
      case ResizeBoundary.BottomRight: {
        desiredWidth = Math.max(minSize, Math.max(mouseX, 0) - x);
        break;
      }
      // no default
    }

    // Height
    switch (this.resizeSide) {
      case ResizeBoundary.Top:
      case ResizeBoundary.TopLeft:
      case ResizeBoundary.TopRight: {
        desiredHeight = Math.max(minSize, height + (y - Math.max(mouseY, 0)));
        break;
      }
      case ResizeBoundary.Bottom:
      case ResizeBoundary.BottomLeft:
      case ResizeBoundary.BottomRight: {
        desiredHeight = Math.max(minSize, Math.max(mouseY, 0) - y);
        break;
      }
      // no default
    }

    // Old
    switch (this.resizeSide) {
      case ResizeBoundary.None:
      case ResizeBoundary.Marquee: {
        break;
      }
      case ResizeBoundary.Left: {
        const { newWidth: w, newHeight: h } = this.keepAspectRatio(desiredWidth, height);
        const finalWidth = clamp(w, minSize, canvas.clientWidth);
        newRegion = {
          x: Math.max(0, x + width - finalWidth),
          y,
          width: finalWidth,
          height: clamp(h, minSize, canvas.clientHeight),
        };
        break;
      }
      case ResizeBoundary.Right: {
        const { newWidth: w, newHeight: h } = this.keepAspectRatio(desiredWidth, height);
        newRegion = {
          ...newRegion,
          width: clamp(w, minSize, canvas.clientWidth - x),
          height: clamp(h, minSize, canvas.clientHeight),
        };
        break;
      }
      case ResizeBoundary.Top: {
        const { newWidth: w, newHeight: h } = this.adjustDimensions(
          desiredWidth,
          desiredHeight,
          this.cropAspectRatio,
          canvas.clientWidth,
          canvas.clientHeight,
          minSize,
        );
        newRegion = {
          x,
          y: Math.max(0, y + height - h),
          width: w,
          height: h,
        };
        break;
      }
      case ResizeBoundary.Bottom: {
        const { newWidth: w, newHeight: h } = this.adjustDimensions(
          desiredWidth,
          desiredHeight,
          this.cropAspectRatio,
          canvas.clientWidth,
          canvas.clientHeight - y,
          minSize,
        );
        newRegion = {
          ...newRegion,
          width: w,
          height: h,
        };
        break;
      }
      case ResizeBoundary.TopLeft: {
        const { newWidth: w, newHeight: h } = this.adjustDimensions(
          desiredWidth,
          desiredHeight,
          this.cropAspectRatio,
          canvas.clientWidth,
          canvas.clientHeight,
          minSize,
        );
        newRegion = {
          x: Math.max(0, x + width - w),
          y: Math.max(0, y + height - h),
          width: w,
          height: h,
        };
        break;
      }
      case ResizeBoundary.TopRight: {
        const { newWidth: w, newHeight: h } = this.adjustDimensions(
          desiredWidth,
          desiredHeight,
          this.cropAspectRatio,
          canvas.clientWidth - x,
          y + height,
          minSize,
        );
        newRegion = {
          x,
          y: Math.max(0, y + height - h),
          width: w,
          height: h,
        };
        break;
      }
      case ResizeBoundary.BottomLeft: {
        const { newWidth: w, newHeight: h } = this.adjustDimensions(
          desiredWidth,
          desiredHeight,
          this.cropAspectRatio,
          canvas.clientWidth,
          canvas.clientHeight - y,
          minSize,
        );
        newRegion = {
          x: Math.max(0, x + width - w),
          y,
          width: w,
          height: h,
        };
        break;
      }
      case ResizeBoundary.BottomRight: {
        const { newWidth: w, newHeight: h } = this.adjustDimensions(
          desiredWidth,
          desiredHeight,
          this.cropAspectRatio,
          canvas.clientWidth - x,
          canvas.clientHeight - y,
          minSize,
        );
        newRegion = {
          ...newRegion,
          width: w,
          height: h,
        };
        break;
      }
    }

    // Constrain the region to canvas and rotated image bounds
    const boundedRegion = {
      ...newRegion,
      x: Math.max(0, Math.min(newRegion.x, canvas.clientWidth - newRegion.width)),
      y: Math.max(0, Math.min(newRegion.y, canvas.clientHeight - newRegion.height)),
    };
    this.region = this.constrainRegionToRotatedImage(boundedRegion);
    this.baseRegion = { ...this.region };

    this.draw();
  }

  resetCrop() {
    this.hasChanges = true;
    this.cropAspectRatio = 'free';
    this.baseRegion = {
      x: 0,
      y: 0,
      width: this.cropImageSize.width * this.cropImageScale,
      height: this.cropImageSize.height * this.cropImageScale,
    };
    this.region = this.constrainRegionToRotatedImage(this.baseRegion);
    this.draw();
  }

  constrainRegionToRotatedImage(
    region: Region,
    fineAngleDeg: number = this.fineRotation,
    scale: number = this.cropImageScale,
  ): Region {
    const W = this.cropImageSize.width * scale;
    const H = this.cropImageSize.height * scale;
    if (W <= 0 || H <= 0) {
      return region;
    }
    const clamped = this.constrainToBounds(region, { width: W, height: H });
    if (Math.abs(fineAngleDeg) < 1e-4) {
      return clamped;
    }

    const rad = (fineAngleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const absCos = Math.abs(cos);
    const absSin = Math.abs(sin);

    const k = Math.min(1, W / (clamped.width * absCos + clamped.height * absSin), H / (clamped.width * absSin + clamped.height * absCos));
    const w = Math.max(1, clamped.width * k);
    const h = Math.max(1, clamped.height * k);

    const cx = W / 2;
    const cy = H / 2;
    const dx = clamped.x + clamped.width / 2 - cx;
    const dy = clamped.y + clamped.height / 2 - cy;

    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;

    const maxU = Math.max(0, W / 2 - (w / 2) * absCos - (h / 2) * absSin);
    const maxV = Math.max(0, H / 2 - (w / 2) * absSin - (h / 2) * absCos);

    const clampedU = clamp(u, -maxU, maxU);
    const clampedV = clamp(v, -maxV, maxV);

    const dx2 = clampedU * cos - clampedV * sin;
    const dy2 = clampedU * sin + clampedV * cos;

    return {
      x: cx + dx2 - w / 2,
      y: cy + dy2 - h / 2,
      width: w,
      height: h,
    };
  }

  getRotatedOriginalCropRegion(): Region {
    const displayW = this.previewImageSize.width;
    const displayH = this.previewImageSize.height;
    const scaleX = this.originalImageSize.width / displayW;
    const scaleY = this.originalImageSize.height / displayH;

    const dxOrig = (this.region.x + this.region.width / 2 - displayW / 2) * scaleX;
    const dyOrig = (this.region.y + this.region.height / 2 - displayH / 2) * scaleY;
    const wOrig = this.region.width * scaleX;
    const hOrig = this.region.height * scaleY;

    let dxRot = dxOrig;
    let dyRot = dyOrig;
    let wRot = wOrig;
    let hRot = hOrig;

    switch (this.normalizedBaseRotation) {
      case 90: {
        dxRot = -dyOrig;
        dyRot = dxOrig;
        wRot = hOrig;
        hRot = wOrig;
        break;
      }
      case 180: {
        dxRot = -dxOrig;
        dyRot = -dyOrig;
        break;
      }
      case 270: {
        dxRot = dyOrig;
        dyRot = -dxOrig;
        wRot = hOrig;
        hRot = wOrig;
        break;
      }
    }

    const rad = (this.normalizedRotation * Math.PI) / 180;
    const rotW = Math.max(
      1,
      Math.round(this.originalImageSize.width * Math.abs(Math.cos(rad)) + this.originalImageSize.height * Math.abs(Math.sin(rad))),
    );
    const rotH = Math.max(
      1,
      Math.round(this.originalImageSize.width * Math.abs(Math.sin(rad)) + this.originalImageSize.height * Math.abs(Math.cos(rad))),
    );

    const width = clamp(Math.round(wRot), 1, rotW);
    const height = clamp(Math.round(hRot), 1, rotH);
    const x = clamp(Math.round(rotW / 2 + dxRot - width / 2), 0, rotW - width);
    const y = clamp(Math.round(rotH / 2 + dyRot - height / 2), 0, rotH - height);

    return { x, y, width, height };
  }

  convertRotatedCropToDisplayRegion(crop: CropParameters, scale: number): Region {
    const rad = (this.normalizedRotation * Math.PI) / 180;
    const rotW = Math.max(
      1,
      Math.round(this.originalImageSize.width * Math.abs(Math.cos(rad)) + this.originalImageSize.height * Math.abs(Math.sin(rad))),
    );
    const rotH = Math.max(
      1,
      Math.round(this.originalImageSize.width * Math.abs(Math.sin(rad)) + this.originalImageSize.height * Math.abs(Math.cos(rad))),
    );

    const dxRot = crop.x + crop.width / 2 - rotW / 2;
    const dyRot = crop.y + crop.height / 2 - rotH / 2;

    let dxOrig = dxRot;
    let dyOrig = dyRot;
    let wOrig = crop.width;
    let hOrig = crop.height;

    switch (this.normalizedBaseRotation) {
      case 90: {
        dxOrig = dyRot;
        dyOrig = -dxRot;
        wOrig = crop.height;
        hOrig = crop.width;
        break;
      }
      case 180: {
        dxOrig = -dxRot;
        dyOrig = -dyRot;
        break;
      }
      case 270: {
        dxOrig = -dyRot;
        dyOrig = dxRot;
        wOrig = crop.height;
        hOrig = crop.width;
        break;
      }
    }

    const displayW = this.cropImageSize.width * scale;
    const displayH = this.cropImageSize.height * scale;
    const scaleX = displayW / this.originalImageSize.width;
    const scaleY = displayH / this.originalImageSize.height;

    const width = wOrig * scaleX;
    const height = hOrig * scaleY;
    const x = displayW / 2 + dxOrig * scaleX - width / 2;
    const y = displayH / 2 + dyOrig * scaleY - height / 2;

    return this.constrainRegionToRotatedImage({ x, y, width, height }, this.fineRotation, scale);
  }

  rotateAspectRatio() {
    const aspectRatio = this.cropAspectRatio;
    if (aspectRatio === 'free' || aspectRatio === 'reset') {
      return;
    }

    const [widthRatio, heightRatio] = aspectRatio.split(':', 2);
    this.setAspectRatio(`${heightRatio}:${widthRatio}`);
  }

  // Coordinate conversion helpers
  convertRegion(settings: RegionConvertParams) {
    const { region, from: fromSize, to: toSize } = settings;
    const scaleX = toSize.width / fromSize.width;
    const scaleY = toSize.height / fromSize.height;

    return {
      x: Math.round(region.x * scaleX),
      y: Math.round(region.y * scaleY),
      width: Math.round(region.width * scaleX),
      height: Math.round(region.height * scaleY),
    };
  }

  getRegionInPreviewCoords(region: Region) {
    return {
      x: Math.round(region.x / this.cropImageScale),
      y: Math.round(region.y / this.cropImageScale),
      width: Math.round(region.width / this.cropImageScale),
      height: Math.round(region.height / this.cropImageScale),
    };
  }

  // Apply mirror transformation to coordinates
  applyMirrorToCoords(region: Region, imageSize: ImageDimensions): Region {
    let { x, y } = region;
    const { width, height } = region;

    if (this.mirrorHorizontal) {
      x = imageSize.width - x - width;
    }
    if (this.mirrorVertical) {
      y = imageSize.height - y - height;
    }

    return { x, y, width, height };
  }

  // Constrain region to bounds
  constrainToBounds(region: Region, bounds: ImageDimensions): Region {
    const { x, y, width, height } = region;
    return {
      x: Math.max(0, Math.min(x, bounds.width - width)),
      y: Math.max(0, Math.min(y, bounds.height - height)),
      width: Math.min(width, bounds.width - Math.max(0, x)),
      height: Math.min(height, bounds.height - Math.max(0, y)),
    };
  }
}

export const transformManager = new TransformManager();
