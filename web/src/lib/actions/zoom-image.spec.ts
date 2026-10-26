import { zoomImageAction } from '$lib/actions/zoom-image';

const { manager } = vi.hoisted(() => {
  const manager = {
    zoomState: { currentZoom: 1, currentRotation: 0, currentPositionX: 0, currentPositionY: 0, enable: true },
    get zoom(): number {
      return manager.zoomState.currentZoom;
    },
    on: vi.fn(() => vi.fn()),
    onZoomChange: vi.fn(),
    animatedZoom: vi.fn(),
    cancelZoomAnimation: vi.fn(),
  };
  return { manager };
});
vi.mock('$lib/managers/asset-viewer-manager.svelte', () => ({ assetViewerManager: manager }));

describe('unified photo double-click', () => {
  let node: HTMLDivElement;
  let action: ReturnType<typeof zoomImageAction>;
  beforeEach(() => {
    manager.zoomState = { currentZoom: 1, currentRotation: 0, currentPositionX: 0, currentPositionY: 0, enable: true };
    node = document.createElement('div');
    Object.defineProperties(node, { clientWidth: { value: 1000 }, clientHeight: { value: 800 } });
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    action = zoomImageAction(node, { zoomTarget: document.createElement('div'), image: { width: 4000, height: 3000 } });
  });
  afterEach(() => action.destroy());
  const pointer = (type: string, x = 700, id = 1, primary = true) =>
    node.dispatchEvent(
      new PointerEvent(type, { pointerType: 'touch', pointerId: id, isPrimary: primary, clientX: x, clientY: 350 }),
    );
  const tap = (x = 700) => {
    pointer('pointerdown', x);
    pointer('pointerup', x);
  };
  it('desktop double-click anchors a 2x zoom at the clicked point', () => {
    node.dispatchEvent(new MouseEvent('dblclick', { clientX: 700, clientY: 350 }));
    expect(manager.animatedZoom).toHaveBeenCalledWith(2, 300, { x: 700, y: 350 });
  });
  it('resets any non-fit desktop zoom regardless of click position', () => {
    manager.zoomState.currentZoom = 1.37;
    node.dispatchEvent(new MouseEvent('dblclick', { clientX: 50, clientY: 100 }));
    expect(manager.animatedZoom).toHaveBeenCalledWith(1, 300, { x: 50, y: 100 });
  });
  it('uses the same rule on touch and ignores the synthetic mouse double-click', () => {
    tap();
    tap();
    expect(manager.animatedZoom).toHaveBeenCalledExactlyOnceWith(2, 300, { x: 700, y: 350 });
    node.dispatchEvent(new MouseEvent('dblclick', { clientX: 700, clientY: 350 }));
    expect(manager.animatedZoom).toHaveBeenCalledTimes(1);
  });
  it('also resets an arbitrary touch zoom to fit', () => {
    manager.zoomState.currentZoom = 3.72;
    tap(50);
    tap(50);
    expect(manager.animatedZoom).toHaveBeenCalledExactlyOnceWith(1, 300, { x: 50, y: 350 });
  });
  it('does not interpret a pan or cancelled pointer as a tap', () => {
    pointer('pointerdown');
    pointer('pointermove', 750);
    pointer('pointerup', 750);
    tap(750);
    expect(manager.animatedZoom).not.toHaveBeenCalled();
    pointer('pointerdown');
    pointer('pointercancel');
    tap();
    expect(manager.animatedZoom).not.toHaveBeenCalled();
  });
  it('does not interpret a pinch as the first half of a double tap', () => {
    pointer('pointerdown');
    pointer('pointerdown', 850, 2, false);
    pointer('pointerup');
    pointer('pointerup', 850, 2, false);
    tap();
    expect(manager.animatedZoom).not.toHaveBeenCalled();
  });
});
