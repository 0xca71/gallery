import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import Scrubber from './Scrubber.svelte';

const testState = vi.hoisted(() => ({
  pointerCoarse: true,
}));

vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: {
    get pointerCoarse() {
      return testState.pointerCoarse;
    },
  },
}));

vi.mock('$lib/stores/preferences.store', async () => {
  const { readable } = await import('svelte/store');
  return { locale: readable('en-US') };
});

vi.mock('@immich/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@immich/ui')>();
  const { default: NoopComponent } = await import('@test-data/mocks/noop-component.svelte');
  return { ...original, Icon: NoopComponent };
});

const makeTimelineManager = () =>
  ({
    scrolling: true,
    scrubberMonths: [{ height: 1000, assetCount: 10, year: 2024, month: 1, title: 'Jan 2024' }],
    scrubberTimelineHeight: 1000,
    getAssetOrder: () => 'desc',
    getScrubberDateAtMonthScrollPercent: vi.fn(() => ({ year: 2024, month: 1, day: 15 })),
    ensureScrubberMonthGeometry: vi.fn(),
  }) as unknown as TimelineManager;

describe('Scrubber', () => {
  it('shows the precise day while dragging on a coarse-pointer device', async () => {
    const timelineManager = makeTimelineManager();
    render(Scrubber, {
      props: {
        timelineManager,
        height: 1000,
      },
    });

    const scrubber = screen.getByRole('scrollbar');
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
    expect(screen.getByText('Jan 15, 2024')).toBeInTheDocument();
    Reflect.deleteProperty(document, 'elementsFromPoint');
  });
});
