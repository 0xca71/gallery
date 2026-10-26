import { createZoomImageWheel } from '@zoom-image/core';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import type { Size } from '$lib/utils/container-utils';
import { constrainPhotoPosition, rotatePoint } from '$lib/utils/zoom-geometry';

type ZoomOptions = { zoomTarget?: HTMLElement; image?: Size };

// Minimal touch shape — avoids importing DOM TouchEvent which isn't available in all TS targets.
type TouchEventLike = {
  touches: Iterable<{ clientX: number; clientY: number }> & { length: number };
  targetTouches: ArrayLike<unknown>;
};
const asTouchEvent = (event: Event) => event as unknown as TouchEventLike;

export const zoomImageAction = (node: HTMLElement, options?: ZoomOptions) => {
  const zoomInstance = createZoomImageWheel(node, {
    maxZoom: 10,
    shouldZoomOnDoubleTap: false,
    constrainPosition: (axis, value, zoom, rotation) =>
      constrainPhotoPosition(axis, value, zoom, rotation, options?.image ?? { width: 1, height: 1 }, {
        width: node.clientWidth,
        height: node.clientHeight,
      }),
    initialState: assetViewerManager.zoomState,
    zoomTarget: options?.zoomTarget,
  });

  const unsubscribes = [
    assetViewerManager.on({ ZoomChange: (state) => zoomInstance.setState(state) }),
    zoomInstance.subscribe(({ state }) => assetViewerManager.onZoomChange(state)),
  ];

  const controller = new AbortController();
  const { signal } = controller;

  node.addEventListener('pointerdown', () => assetViewerManager.cancelZoomAnimation(), { capture: true, signal });

  // Intercept events in capture phase to prevent zoom-image from seeing interactions on
  // overlay elements (e.g. OCR text boxes), preserving browser defaults like text selection.
  const isOverlayEvent = (event: Event) => !!(event.target as HTMLElement).closest('[data-overlay-interactive]');
  const isOverlayAtPoint = (x: number, y: number) =>
    !!document.elementFromPoint(x, y)?.closest('[data-overlay-interactive]');

  // Pointer event interception: track pointers that start on overlays and intercept the entire gesture.
  const overlayPointers = new Set<number>();
  const interceptedPointers = new Set<number>();
  const interceptOverlayPointerDown = (event: PointerEvent) => {
    if (isOverlayEvent(event) || isOverlayAtPoint(event.clientX, event.clientY)) {
      overlayPointers.add(event.pointerId);
      interceptedPointers.add(event.pointerId);
      event.stopPropagation();
    } else if (overlayPointers.size > 0) {
      // Split gesture (e.g. pinch with one finger on overlay) — intercept entirely.
      interceptedPointers.add(event.pointerId);
      event.stopPropagation();
    }
  };
  const interceptOverlayPointerEvent = (event: PointerEvent) => {
    if (interceptedPointers.has(event.pointerId)) {
      event.stopPropagation();
    }
  };
  const interceptOverlayPointerEnd = (event: PointerEvent) => {
    overlayPointers.delete(event.pointerId);
    if (interceptedPointers.delete(event.pointerId)) {
      event.stopPropagation();
    }
  };
  node.addEventListener('pointerdown', interceptOverlayPointerDown, { capture: true, signal });
  node.addEventListener('pointermove', interceptOverlayPointerEvent, { capture: true, signal });
  node.addEventListener('pointerup', interceptOverlayPointerEnd, { capture: true, signal });
  node.addEventListener('pointerleave', interceptOverlayPointerEnd, { capture: true, signal });
  node.addEventListener('pointercancel', interceptOverlayPointerEnd, { capture: true, signal });

  // Touch event interception for overlay touches or split gestures (pinch across container boundary).
  // Once intercepted, stays intercepted until all fingers are lifted.
  let touchGestureIntercepted = false;
  const interceptOverlayTouchEvent = (event: Event) => {
    if (touchGestureIntercepted) {
      event.stopPropagation();
      return;
    }
    const { touches, targetTouches } = asTouchEvent(event);
    if (touches && targetTouches) {
      if (touches.length > targetTouches.length) {
        touchGestureIntercepted = true;
        event.stopPropagation();
        return;
      }
      for (const touch of touches) {
        if (isOverlayAtPoint(touch.clientX, touch.clientY)) {
          touchGestureIntercepted = true;
          event.stopPropagation();
          return;
        }
      }
    } else if (isOverlayEvent(event)) {
      event.stopPropagation();
    }
  };
  const resetTouchGesture = (event: Event) => {
    const { touches } = asTouchEvent(event);
    if (touches.length === 0) {
      touchGestureIntercepted = false;
    }
  };
  node.addEventListener('touchstart', interceptOverlayTouchEvent, { capture: true, signal });
  node.addEventListener('touchmove', interceptOverlayTouchEvent, { capture: true, signal });
  node.addEventListener('touchend', resetTouchGesture, { capture: true, signal });
  node.addEventListener('touchcancel', resetTouchGesture, { capture: true, signal });

  // Wheel and dblclick interception on overlay elements.
  // Dblclick also intercepted for all touch double-taps (Safari fires synthetic dblclick
  // on double-tap, which conflicts with zoom-image's touch zoom handler).
  const toggleAt = (x: number, y: number) => {
    if (!assetViewerManager.zoomState.enable) {
      return;
    }
    const bounds = node.getBoundingClientRect();
    const offset = rotatePoint(
      x - (bounds.left + bounds.width / 2),
      y - (bounds.top + bounds.height / 2),
      -assetViewerManager.zoomState.currentRotation,
    );
    assetViewerManager.animatedZoom(assetViewerManager.zoom > 1 ? 1 : 2, 300, {
      x: node.clientWidth / 2 + offset.x,
      y: node.clientHeight / 2 + offset.y,
    });
  };
  let lastTap: { x: number; y: number; time: number } | undefined;
  let tapStart: { x: number; y: number; time: number; pointerId: number } | undefined;
  node.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType !== 'touch' || isOverlayEvent(event)) {
        return;
      }
      if (!event.isPrimary || tapStart) {
        tapStart = undefined;
        lastTap = undefined;
        return;
      }
      tapStart = { x: event.clientX, y: event.clientY, time: performance.now(), pointerId: event.pointerId };
    },
    { capture: true, signal },
  );
  node.addEventListener(
    'pointermove',
    (event) => {
      if (!(
        tapStart?.pointerId === event.pointerId &&
        Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) > 12
      )) {
        return;
      }

      tapStart = undefined;
      lastTap = undefined;
    },
    { capture: true, signal },
  );
  node.addEventListener(
    'pointerup',
    (event) => {
      if (!tapStart || tapStart.pointerId !== event.pointerId) {
        return;
      }
      const now = performance.now();
      const valid = now - tapStart.time < 300;
      tapStart = undefined;
      if (
        valid &&
        lastTap &&
        now - lastTap.time < 300 &&
        Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 24
      ) {
        lastTap = undefined;
        toggleAt(event.clientX, event.clientY);
      } else {
        lastTap = valid ? { x: event.clientX, y: event.clientY, time: now } : undefined;
      }
    },
    { capture: true, signal },
  );
  node.addEventListener(
    'pointercancel',
    () => {
      tapStart = undefined;
      lastTap = undefined;
    },
    { capture: true, signal },
  );
  let lastPointerWasTouch = false;
  node.addEventListener('pointerdown', (event) => (lastPointerWasTouch = event.pointerType === 'touch'), {
    capture: true,
    signal,
  });
  node.addEventListener(
    'wheel',
    (event) => {
      if (isOverlayEvent(event)) {
        event.stopPropagation();
      }
    },
    { capture: true, signal },
  );
  node.addEventListener(
    'dblclick',
    (event) => {
      event.stopImmediatePropagation();
      if (!lastPointerWasTouch && !isOverlayEvent(event)) {
        event.preventDefault();
        toggleAt(event.clientX, event.clientY);
      }
    },
    { capture: true, signal },
  );

  node.style.overflow = 'visible';
  node.style.touchAction = 'none';
  return {
    update(newOptions?: ZoomOptions) {
      options = newOptions;
      if (newOptions?.zoomTarget !== undefined) {
        zoomInstance.setState({ ...assetViewerManager.zoomState, zoomTarget: newOptions.zoomTarget });
      }
    },
    destroy() {
      controller.abort();
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      zoomInstance.cleanup();
    },
  };
};
