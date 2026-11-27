import type { TimelineManager } from '#lib/managers/timeline-manager/timeline-manager.svelte.ts';
import { test } from '#test/unit/fixtures.ts';
import { tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import Scrubber from './Scrubber.svelte';

const testState = vi.hoisted(() => ({
  pointerCoarse: true,
}));

vi.mock('#lib/stores/media-query-manager.svelte.ts', () => ({
  mediaQueryManager: {
    get pointerCoarse() {
      return testState.pointerCoarse;
    },
  },
}));

const makeTimelineManager = () =>
  ({
    scrolling: true,
    grouping: 'day',
    scrubberMonths: [{ height: 1000, assetCount: 10, year: 2024, month: 1, title: 'Jan 2024' }],
    scrubberTimelineHeight: 1000,
    getAssetOrder: () => 'desc',
    getScrubberDateAtMonthScrollPercent: vi.fn(() => ({ year: 2024, month: 1, day: 15 })),
    ensureScrubberMonthGeometry: vi.fn().mockResolvedValue(undefined),
  }) as unknown as TimelineManager;

describe('Scrubber', () => {
  test('shows the precise day while dragging on a coarse-pointer device', async () => {
    const timelineManager = makeTimelineManager();
    await render(Scrubber, { timelineManager, height: 1000 });

    const scrubber = page.getByRole('scrollbar').element() as HTMLElement;
    vi.spyOn(scrubber, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 1000,
      left: 0,
      right: 20,
      width: 20,
      height: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const segment = scrubber.querySelector('[data-id="time-segment"]') as HTMLElement;
    vi.spyOn(segment, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 1000,
      left: 0,
      right: 20,
      width: 20,
      height: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn().mockReturnValue([segment, scrubber]),
    });

    const touchStart = new Event('touchstart', { bubbles: true }) as TouchEvent;
    Object.defineProperty(touchStart, 'touches', { value: [{ clientX: 10, clientY: 500 }] });
    document.dispatchEvent(touchStart);
    await tick();

    expect(timelineManager.getScrubberDateAtMonthScrollPercent).toHaveBeenCalled();
    await expect.element(page.getByText('Jan 15, 2024')).toBeInTheDocument();
    Reflect.deleteProperty(document, 'elementsFromPoint');
  });
});
