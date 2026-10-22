import { searchAssetStatistics, searchRandom, type AssetResponseDto } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { randomSeedManager } from '$lib/managers/random-seed-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import RandomSection from './RandomSection.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, searchRandom: vi.fn(), searchAssetStatistics: vi.fn() };
});
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const createBatch = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => assetFactory.build({ id: `${prefix}-${index}` }));

const deferredBatch = () => {
  let resolve!: (assets: AssetResponseDto[]) => void;
  const promise = new Promise<AssetResponseDto[]>((done) => (resolve = done));
  return { promise, resolve };
};

const renderSection = (props: ComponentProps<typeof RandomSection>) => {
  const { rerender, ...result } = renderWithTooltips(RandomSection, props);
  return {
    ...result,
    rerender: (componentProps: ComponentProps<typeof RandomSection>) =>
      rerender({ component: RandomSection, componentProps } as never),
  };
};

describe('RandomSection viewer prefetch', () => {
  beforeEach(() => {
    randomSeedManager.clear();
    vi.mocked(searchRandom).mockReset();
    vi.mocked(searchAssetStatistics).mockResolvedValue({ total: 1000 });
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });

  afterEach(() => {
    randomSeedManager.clear();
    vi.unstubAllGlobals();
  });

  it('keeps Explore at its initial preview until a viewer is opened', async () => {
    const initial = createBatch(24, 'initial');
    vi.mocked(searchRandom).mockResolvedValueOnce(initial);
    const onselect = vi.fn();
    const { getAllByRole } = renderSection({ onselect });

    await waitFor(() => expect(getAllByRole('img')).toHaveLength(24));
    expect(searchRandom).toHaveBeenCalledTimes(1);
    expect(searchRandom).toHaveBeenCalledWith({ randomSearchDto: { size: 24 } }, { signal: expect.any(AbortSignal) });
    await fireEvent.click(getAllByRole('button')[0]!);
    expect(onselect).toHaveBeenCalledWith(initial, initial[0]);
  });

  it('appends unique assets for the Explore viewer while keeping the preview short', async () => {
    const initial = createBatch(24, 'initial');
    const next = createBatch(200, 'next');
    const pending = deferredBatch();
    vi.mocked(searchRandom).mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
    const onselect = vi.fn();
    const onassetschange = vi.fn();
    const { getAllByRole, rerender } = renderSection({ onselect, onassetschange });
    await waitFor(() => expect(getAllByRole('img')).toHaveLength(24));

    await rerender({ onselect, onassetschange, viewerAssetId: initial[0].id });
    await waitFor(() => expect(searchRandom).toHaveBeenCalledTimes(2));
    // Moving through multiple photos while the fetch is pending must reuse that request.
    await rerender({ onselect, onassetschange, viewerAssetId: initial[10].id });
    expect(searchRandom).toHaveBeenCalledTimes(2);
    pending.resolve([initial[0], next[0], next[0], ...next.slice(1)]);

    await waitFor(() => expect(onassetschange).toHaveBeenCalledExactlyOnceWith([...initial, ...next]));
    expect(getAllByRole('img')).toHaveLength(24);
    await fireEvent.click(getAllByRole('button')[0]!);
    expect(onselect).toHaveBeenLastCalledWith([...initial, ...next], initial[0]);
  });

  it('prefetches on the full Random page at 72 remaining assets without a visible sentinel', async () => {
    const initial = createBatch(200, 'initial');
    const next = createBatch(200, 'next');
    vi.mocked(searchRandom).mockResolvedValueOnce(initial).mockResolvedValueOnce(next);
    const onselect = vi.fn();
    const onassetschange = vi.fn();
    const { getAllByRole, rerender } = renderSection({ full: true, onselect, onassetschange });
    await waitFor(() => expect(getAllByRole('img')).toHaveLength(200));

    await rerender({ full: true, onselect, onassetschange, viewerAssetId: initial[126].id });
    expect(searchRandom).toHaveBeenCalledTimes(1);
    await rerender({ full: true, onselect, onassetschange, viewerAssetId: initial[127].id });
    await waitFor(() => expect(onassetschange).toHaveBeenCalledExactlyOnceWith([...initial, ...next]));
    expect(searchRandom).toHaveBeenCalledTimes(2);
  });

  it('stops when a random batch contains no unseen assets', async () => {
    const initial = createBatch(24, 'initial');
    vi.mocked(searchRandom).mockResolvedValueOnce(initial).mockResolvedValueOnce(initial);
    const onselect = vi.fn();
    const onassetschange = vi.fn();
    const { getAllByRole, rerender } = renderSection({ onselect, onassetschange });
    await waitFor(() => expect(getAllByRole('img')).toHaveLength(24));
    await rerender({ onselect, onassetschange, viewerAssetId: initial[20].id });
    await waitFor(() => expect(onassetschange).toHaveBeenCalledWith(initial));
    await rerender({ onselect, onassetschange, viewerAssetId: initial[23].id });
    expect(searchRandom).toHaveBeenCalledTimes(2);
  });

  it('avoids an error retry loop but allows retry after navigating to another photo', async () => {
    const initial = createBatch(24, 'initial');
    const next = createBatch(200, 'next');
    vi.mocked(searchRandom)
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(next);
    const onselect = vi.fn();
    const onassetschange = vi.fn();
    const { getAllByRole, rerender } = renderSection({ onselect, onassetschange });
    await waitFor(() => expect(getAllByRole('img')).toHaveLength(24));
    await rerender({ onselect, onassetschange, viewerAssetId: initial[20].id });
    await waitFor(() => expect(searchRandom).toHaveBeenCalledTimes(2));
    await rerender({ onselect, onassetschange, viewerAssetId: initial[20].id });
    expect(searchRandom).toHaveBeenCalledTimes(2);
    await rerender({ onselect, onassetschange, viewerAssetId: initial[21].id });
    await waitFor(() => expect(onassetschange).toHaveBeenCalledExactlyOnceWith([...initial, ...next]));
    expect(searchRandom).toHaveBeenCalledTimes(3);
  });

  it('does not publish an in-flight batch after the section is unmounted', async () => {
    const initial = createBatch(24, 'initial');
    const pending = deferredBatch();
    vi.mocked(searchRandom).mockResolvedValueOnce(initial).mockReturnValueOnce(pending.promise);
    const onselect = vi.fn();
    const onassetschange = vi.fn();
    const { getAllByRole, rerender, unmount } = renderSection({ onselect, onassetschange });
    await waitFor(() => expect(getAllByRole('img')).toHaveLength(24));
    await rerender({ onselect, onassetschange, viewerAssetId: initial[20].id });
    await waitFor(() => expect(searchRandom).toHaveBeenCalledTimes(2));
    unmount();
    pending.resolve(createBatch(200, 'next'));
    await pending.promise;
    expect(onassetschange).not.toHaveBeenCalled();
  });
});
