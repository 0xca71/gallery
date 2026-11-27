import type { EditActions } from '#lib/managers/edit/edit-manager.svelte.ts';
import { scaleToFit, type Size } from '#lib/utils/container-utils.ts';
import { normalizeTransformEdits } from '#lib/utils/editor.ts';
import { AssetEditAction } from '@immich/sdk';
import type { ZoomImageWheelState } from '@zoom-image/core';

export const MAX_PHOTO_ZOOM = 10;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const swapsDimensions = (rotation: number) => Math.abs(rotation % 180) === 90;

export type CropRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function rotatePoint(x: number, y: number, rotation: number) {
  const radians = (rotation * Math.PI) / 180;
  return { x: x * Math.cos(radians) - y * Math.sin(radians), y: x * Math.sin(radians) + y * Math.cos(radians) };
}

export function fittedPhoto(image: Size, viewport: Size, rotation: number) {
  const available = swapsDimensions(rotation) ? { width: viewport.height, height: viewport.width } : viewport;
  const size = scaleToFit(image, available);
  return { ...size, x: (viewport.width - size.width) / 2, y: (viewport.height - size.height) / 2 };
}

export function constrainPhotoPosition(
  axis: 'x' | 'y',
  value: number,
  zoom: number,
  rotation: number,
  image: Size,
  viewport: Size,
) {
  const photo = fittedPhoto(image, viewport, rotation);
  const center = (axis === 'x' ? viewport.width : viewport.height) / 2;
  const visibleSize = swapsDimensions(rotation)
    ? axis === 'x'
      ? viewport.height
      : viewport.width
    : axis === 'x'
      ? viewport.width
      : viewport.height;
  const photoSize = axis === 'x' ? photo.width : photo.height;
  const start = axis === 'x' ? photo.x : photo.y;
  if (photoSize * zoom <= visibleSize) {
    return center - zoom * (start + photoSize / 2);
  }
  return clamp(value, center + visibleSize / 2 - zoom * (start + photoSize), center - visibleSize / 2 - zoom * start);
}

export function zoomAt(state: ZoomImageWheelState, zoom: number, point: { x: number; y: number }) {
  const ratio = clamp(zoom, 1, MAX_PHOTO_ZOOM) / state.currentZoom;
  return {
    ...state,
    currentZoom: clamp(zoom, 1, MAX_PHOTO_ZOOM),
    currentPositionX: point.x - (point.x - state.currentPositionX) * ratio,
    currentPositionY: point.y - (point.y - state.currentPositionY) * ratio,
  };
}

// Navigator coordinates follow the displayed orientation. The library stores pan
// before rotation, so both directions use the same inverse/forward transform.
export function navigatorViewport(image: Size, viewport: Size, state: ZoomImageWheelState) {
  const photo = fittedPhoto(image, viewport, state.currentRotation);
  const swapped = swapsDimensions(state.currentRotation);
  const width = (swapped ? photo.height : photo.width) * state.currentZoom;
  const height = (swapped ? photo.width : photo.height) * state.currentZoom;
  const offset = rotatePoint(
    state.currentPositionX + ((state.currentZoom - 1) * viewport.width) / 2,
    state.currentPositionY + ((state.currentZoom - 1) * viewport.height) / 2,
    state.currentRotation,
  );
  const left = viewport.width / 2 + offset.x - width / 2;
  const top = viewport.height / 2 + offset.y - height / 2;
  const x = clamp(-left / width, 0, 1);
  const y = clamp(-top / height, 0, 1);
  return {
    x,
    y,
    width: clamp((viewport.width - left) / width, 0, 1) - x,
    height: clamp((viewport.height - top) / height, 0, 1) - y,
  };
}

/*
Converts the image portion visible in the photo viewer into source-image pixels.
Navigator coordinates are expressed in the displayed orientation, while editor
crop parameters are always expressed in the unrotated source orientation.
*/
export function visibleCropRegion(image: Size, viewport: Size, state: ZoomImageWheelState): CropRegion {
  const frame = navigatorViewport(image, viewport, state);
  const oriented = swapsDimensions(state.currentRotation) ? { width: image.height, height: image.width } : image;
  const left = frame.x * oriented.width;
  const top = frame.y * oriented.height;
  const right = (frame.x + frame.width) * oriented.width;
  const bottom = (frame.y + frame.height) * oriented.height;
  const rotation = (((Math.round(state.currentRotation / 90) * 90) % 360) + 360) % 360;

  const mapPoint = (x: number, y: number) => {
    switch (rotation) {
      case 90: {
        return { x: y, y: image.height - x };
      }
      case 180: {
        return { x: image.width - x, y: image.height - y };
      }
      case 270: {
        return { x: image.width - y, y: x };
      }
      default: {
        return { x, y };
      }
    }
  };

  const points = [mapPoint(left, top), mapPoint(right, top), mapPoint(left, bottom), mapPoint(right, bottom)];
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));

  return {
    x: clamp(x, 0, image.width),
    y: clamp(y, 0, image.height),
    width: clamp(maxX - x, 0, image.width),
    height: clamp(maxY - y, 0, image.height),
  };
}

export function panToNavigatorPoint(image: Size, viewport: Size, state: ZoomImageWheelState, x: number, y: number) {
  const photo = fittedPhoto(image, viewport, state.currentRotation);
  const swapped = swapsDimensions(state.currentRotation);
  const offset = rotatePoint(
    (x - 0.5) * (swapped ? photo.height : photo.width),
    (y - 0.5) * (swapped ? photo.width : photo.height),
    -state.currentRotation,
  );
  return {
    ...state,
    currentPositionX: viewport.width / 2 - state.currentZoom * (viewport.width / 2 + offset.x),
    currentPositionY: viewport.height / 2 - state.currentZoom * (viewport.height / 2 + offset.y),
  };
}

export function resizePhotoViewport(image: Size, previous: Size, viewport: Size, state: ZoomImageWheelState) {
  if (previous.width <= 0 || previous.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return state;
  }
  const before = fittedPhoto(image, previous, state.currentRotation);
  const after = fittedPhoto(image, viewport, state.currentRotation);
  const x = ((previous.width / 2 - state.currentPositionX) / state.currentZoom - before.x) / before.width;
  const y = ((previous.height / 2 - state.currentPositionY) / state.currentZoom - before.y) / before.height;
  return {
    ...state,
    currentPositionX: viewport.width / 2 - state.currentZoom * (after.x + x * after.width),
    currentPositionY: viewport.height / 2 - state.currentZoom * (after.y + y * after.height),
  };
}

/** Compose a crop of the displayed edited image with existing geometry without duplicating crop actions. */
export function composeViewerCrop(edits: EditActions, crop: CropRegion, source: Size, displayed: Size): EditActions {
  const existingCrop = edits.find((edit) => edit.action === 'crop')?.parameters as CropRegion | undefined;
  const transform = normalizeTransformEdits(edits);
  const arbitrary = Math.abs(transform.rotation % 90) > 0.001;
  let region: CropRegion;
  if (arbitrary) {
    const radians = (transform.rotation * Math.PI) / 180;
    const rotated = {
      width: Math.round(source.width * Math.abs(Math.cos(radians)) + source.height * Math.abs(Math.sin(radians))),
      height: Math.round(source.width * Math.abs(Math.sin(radians)) + source.height * Math.abs(Math.cos(radians))),
    };
    const bounds = existingCrop ?? { x: 0, y: 0, ...rotated };
    region = {
      x: bounds.x + (crop.x * bounds.width) / displayed.width,
      y: bounds.y + (crop.y * bounds.height) / displayed.height,
      width: (crop.width * bounds.width) / displayed.width,
      height: (crop.height * bounds.height) / displayed.height,
    };
  } else {
    const bounds = existingCrop ?? { x: 0, y: 0, ...source };
    const output = swapsDimensions(transform.rotation) ? { width: bounds.height, height: bounds.width } : bounds;
    const map = (x: number, y: number) => {
      const point = rotatePoint(
        (x * output.width) / displayed.width - output.width / 2,
        (y * output.height) / displayed.height - output.height / 2,
        -transform.rotation,
      );
      return {
        x: bounds.x + bounds.width / 2 + (transform.mirrorHorizontal ? -point.x : point.x),
        y: bounds.y + bounds.height / 2 + (transform.mirrorVertical ? -point.y : point.y),
      };
    };
    const topLeft = map(crop.x, crop.y);
    const bottomRight = map(crop.x + crop.width, crop.y + crop.height);
    region = {
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.abs(bottomRight.x - topLeft.x),
      height: Math.abs(bottomRight.y - topLeft.y),
    };
  }
  const x = Math.max(0, Math.round(region.x));
  const y = Math.max(0, Math.round(region.y));
  return [
    {
      action: AssetEditAction.Crop,
      parameters: {
        x,
        y,
        width: Math.max(1, Math.round(region.x + region.width) - x),
        height: Math.max(1, Math.round(region.y + region.height) - y),
      },
    },
    ...edits.filter((edit) => edit.action !== 'crop'),
  ];
}
