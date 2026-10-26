import { createZoomImageWheel, type ZoomImageWheelState } from '@zoom-image/core';
import { createRequire } from 'node:module';
import {
  constrainPhotoPosition,
  navigatorViewport,
  panToNavigatorPoint,
  resizePhotoViewport,
  zoomAt,
} from '$lib/utils/zoom-geometry';

const { createZoomImageWheel: createCommonJsWheel } = createRequire(import.meta.url)(
  '@zoom-image/core',
) as typeof import('@zoom-image/core');

const base: ZoomImageWheelState = {
  currentZoom: 1,
  currentPositionX: 0,
  currentPositionY: 0,
  currentRotation: 0,
  enable: true,
};
const viewport = { width: 1000, height: 800 };

describe('photo zoom geometry and patched engine', () => {
  it('keeps the same image point centered when a sidebar changes the viewport aspect ratio', () => {
    const image = { width: 4000, height: 3000 };
    const state = panToNavigatorPoint(image, viewport, { ...base, currentZoom: 4 }, 0.65, 0.4);
    const nextViewport = { width: 600, height: 800 };
    const resized = resizePhotoViewport(image, viewport, nextViewport, state);
    const frame = navigatorViewport(image, nextViewport, resized);
    expect(frame.x + frame.width / 2).toBeCloseTo(0.65);
    expect(frame.y + frame.height / 2).toBeCloseTo(0.4);
  });

  it('zooms around the clicked point without moving it to the center', () => {
    expect(zoomAt(base, 2, { x: 700, y: 350 })).toMatchObject({
      currentZoom: 2,
      currentPositionX: -700,
      currentPositionY: -350,
    });
    expect(zoomAt(zoomAt(base, 2, { x: 700, y: 350 }), 1, { x: 50, y: 50 }).currentZoom).toBe(1);
  });
  it('uses image letterboxing when computing the visible area', () => {
    const image = { width: 4000, height: 1000 };
    const state = zoomAt(base, 2, { x: 500, y: 400 });
    expect(navigatorViewport(image, viewport, state)).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(constrainPhotoPosition('y', -10_000, 2, 0, image, viewport)).toBe(-400);
    expect(constrainPhotoPosition('x', -10_000, 2, 0, image, viewport)).toBe(-1000);
  });
  it.each([0, 90, 180, 270])('maps navigation to the same visible point at %i degrees', (rotation) => {
    const image = { width: 4000, height: 3000 };
    const state = panToNavigatorPoint(
      image,
      viewport,
      { ...base, currentZoom: 4, currentRotation: rotation },
      0.6,
      0.4,
    );
    const frame = navigatorViewport(image, viewport, state);
    expect(frame.x + frame.width / 2).toBeCloseTo(0.6);
    expect(frame.y + frame.height / 2).toBeCloseTo(0.4);
  });
  it.each([0, 90, 180, 270])('constrains the actual image and resets pan at %i degrees', (rotation) => {
    const image = { width: 1000, height: 4000 };
    const state = { ...base, currentRotation: rotation };
    expect(constrainPhotoPosition('x', 10_000, 1, rotation, image, viewport)).toBe(0);
    expect(constrainPhotoPosition('y', -10_000, 1, rotation, image, viewport)).toBe(0);
    expect(navigatorViewport(image, viewport, state)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  it.each([
    ['ESM', createZoomImageWheel],
    ['CommonJS', createCommonJsWheel],
  ] as const)('%s navigation updates the library store and the next drag continues from it', (_, createEngine) => {
    const node = document.createElement('div');
    Object.defineProperties(node, { clientWidth: { value: 1000 }, clientHeight: { value: 800 } });
    const target = document.createElement('div');
    const engine = createEngine(node, { zoomTarget: target, maxZoom: 10 });
    engine.setState({ currentZoom: 2, currentPositionX: -700, currentPositionY: -300 });
    expect(engine.getState()).toMatchObject({ currentPositionX: -700, currentPositionY: -300 });
    node.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 500, clientY: 400 }));
    engine.setState({ currentPositionX: -600, currentPositionY: -200 });
    node.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 520, clientY: 410 }));
    expect(engine.getState()).toMatchObject({ currentPositionX: -580, currentPositionY: -190 });
    node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    node.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 600, clientY: 500 }));
    expect(engine.getState().currentPositionX).toBe(-580);
    engine.cleanup();
  });
});
