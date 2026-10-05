import { fireEvent, render } from '@testing-library/svelte';
import { timelineAssetFactory } from '@test-data/factories/asset-factory';
import AssetViewerFilmstrip from './AssetViewerFilmstrip.svelte';

vi.mock('$lib/components/assets/thumbnail/Thumbnail.svelte', async () => {
  const { default: MockThumbnail } = await import('@test-data/mocks/filmstrip-thumbnail.stub.svelte');
  return { default: MockThumbnail };
});

describe('AssetViewerFilmstrip', () => {
  it('renders the current asset and adjacent thumbnails', () => {
    const assets = timelineAssetFactory.buildList(3);
    const { getByRole, getByTestId, getAllByRole } = render(AssetViewerFilmstrip, {
      assets,
      currentAssetId: assets[1].id,
      onAssetSelect: vi.fn(),
    });

    expect(getByRole('listbox')).toBeInTheDocument();
    expect(getByTestId(`filmstrip-thumbnail-${assets[0].id}`)).toBeInTheDocument();
    expect(getByTestId(`filmstrip-thumbnail-${assets[1].id}`)).toBeInTheDocument();
    expect(getAllByRole('option')).toHaveLength(3);
    expect(getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    expect(getAllByRole('option')[1]).toHaveClass('relative', 'size-14', 'overflow-hidden');
    expect(getAllByRole('option')[1]).not.toHaveStyle('content-visibility: auto');
  });

  it('preloads a bounded window around the current asset', () => {
    const assets = timelineAssetFactory.buildList(30);
    const { getByTestId } = render(AssetViewerFilmstrip, {
      assets,
      currentAssetId: assets[15].id,
      onAssetSelect: vi.fn(),
    });

    expect(getByTestId(`filmstrip-thumbnail-${assets[3].id}`)).toHaveAttribute('data-preload', 'true');
    expect(getByTestId(`filmstrip-thumbnail-${assets[2].id}`)).toHaveAttribute('data-preload', 'false');
    expect(getByTestId(`filmstrip-thumbnail-${assets[15].id}`)).toHaveAttribute('data-preload', 'true');
  });

  it('selects a thumbnail when it is tapped', async () => {
    const assets = timelineAssetFactory.buildList(2);
    const onAssetSelect = vi.fn();
    const { getByTestId } = render(AssetViewerFilmstrip, {
      assets,
      currentAssetId: assets[0].id,
      onAssetSelect,
    });

    await fireEvent.click(getByTestId(`filmstrip-thumbnail-${assets[1].id}`));

    expect(onAssetSelect).toHaveBeenCalledWith(assets[1]);
  });

  it('waits for scrolling to settle before selecting the centered asset', async () => {
    const assets = timelineAssetFactory.buildList(3);
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole } = render(AssetViewerFilmstrip, {
      assets,
      currentAssetId: assets[0].id,
      onAssetSelect,
    });
    const scroller = getByRole('listbox');
    const options = getAllByRole('option');

    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({
      bottom: 56,
      height: 56,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(options[0]!, 'getBoundingClientRect').mockReturnValue({ left: -100, width: 56 } as DOMRect);
    vi.spyOn(options[1]!, 'getBoundingClientRect').mockReturnValue({ left: 72, width: 56 } as DOMRect);
    vi.spyOn(options[2]!, 'getBoundingClientRect').mockReturnValue({ left: 244, width: 56 } as DOMRect);

    await fireEvent.pointerDown(scroller);
    await fireEvent.scroll(scroller);
    expect(onAssetSelect).not.toHaveBeenCalled();

    scroller.dispatchEvent(new Event('scrollend'));
    expect(onAssetSelect).toHaveBeenCalledWith(assets[1]);
  });

  it('does not recenter after scrolling and updating the current asset', async () => {
    const assets = timelineAssetFactory.buildList(3);
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole, rerender } = render(AssetViewerFilmstrip, {
      assets,
      currentAssetId: assets[0].id,
      onAssetSelect,
    });
    const scroller = getByRole('listbox');
    const options = getAllByRole('option');
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect);
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(options[0]!, 'getBoundingClientRect').mockReturnValue({ left: 12, width: 56 } as DOMRect);
    vi.spyOn(options[1]!, 'getBoundingClientRect').mockReturnValue({ left: 72, width: 56 } as DOMRect);
    vi.spyOn(options[2]!, 'getBoundingClientRect').mockReturnValue({ left: 132, width: 56 } as DOMRect);
    const recenter = vi.spyOn(options[1]!, 'scrollIntoView');

    await fireEvent.pointerDown(scroller);
    await fireEvent.scroll(scroller);
    scroller.dispatchEvent(new Event('scrollend'));
    await rerender({ assets, currentAssetId: assets[1].id, onAssetSelect });

    expect(onAssetSelect).toHaveBeenCalledExactlyOnceWith(assets[1]);
    expect(recenter).not.toHaveBeenCalled();

    await fireEvent.pointerDown(scroller);
    await fireEvent.scroll(scroller);
    scroller.dispatchEvent(new Event('scrollend'));
    expect(recenter).not.toHaveBeenCalled();
    expect(onAssetSelect).toHaveBeenCalledTimes(1);
  });

  it('positions a refreshed timeline window immediately without smooth scrolling', async () => {
    const assets = timelineAssetFactory.buildList(4);
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole, rerender } = render(AssetViewerFilmstrip, {
      assets: assets.slice(0, 3),
      currentAssetId: assets[1].id,
      onAssetSelect,
    });
    const scroller = getByRole('listbox');
    const currentOption = getAllByRole('option')[1]!;
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect);
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(currentOption, 'getBoundingClientRect').mockReturnValue({ left: 12, width: 56 } as DOMRect);
    const recenter = vi.spyOn(currentOption, 'scrollIntoView');

    await rerender({ assets: assets.slice(1), currentAssetId: assets[1].id, onAssetSelect });

    expect(recenter).toHaveBeenCalledExactlyOnceWith({
      behavior: 'instant',
      block: 'nearest',
      inline: 'center',
    });
    expect(onAssetSelect).not.toHaveBeenCalled();
  });

  it('keeps the settled target while the main asset update is still pending', async () => {
    const assets = timelineAssetFactory.buildList(3);
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole, rerender } = render(AssetViewerFilmstrip, {
      assets,
      currentAssetId: assets[0].id,
      onAssetSelect,
    });
    const scroller = getByRole('listbox');
    const options = getAllByRole('option');

    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ left: 0 } as DOMRect);
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 });
    vi.spyOn(options[0]!, 'getBoundingClientRect').mockReturnValue({ left: -100, width: 56 } as DOMRect);
    vi.spyOn(options[1]!, 'getBoundingClientRect').mockReturnValue({ left: 120, width: 56 } as DOMRect);
    vi.spyOn(options[2]!, 'getBoundingClientRect').mockReturnValue({ left: 244, width: 56 } as DOMRect);
    const recenterOldAsset = vi.spyOn(options[0]!, 'scrollIntoView');

    await fireEvent.pointerDown(scroller);
    await fireEvent.scroll(scroller);
    scroller.dispatchEvent(new Event('scrollend'));
    expect(onAssetSelect).toHaveBeenCalledExactlyOnceWith(assets[1]);

    await rerender({ assets: [...assets], currentAssetId: assets[0].id, onAssetSelect });

    expect(recenterOldAsset).not.toHaveBeenCalled();
    expect(getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });
});
