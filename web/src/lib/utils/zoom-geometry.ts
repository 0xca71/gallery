import type { ZoomImageWheelState } from '@zoom-image/core';
import type { Size } from '$lib/utils/container-utils';
import { scaleToFit } from '$lib/utils/container-utils';

export const MAX_PHOTO_ZOOM = 10;
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const swapsDimensions = (rotation: number) => Math.abs(rotation % 180) === 90;

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
  if (previous.width <= 0 || previous.height <= 0) {
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
