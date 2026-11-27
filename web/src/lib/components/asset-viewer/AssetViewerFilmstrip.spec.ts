import { factory } from '#test/unit/factories.ts';
import type { ComponentProps } from 'svelte';
import { render } from 'vitest-browser-svelte';
import AssetViewerFilmstrip from './AssetViewerFilmstrip.svelte';

vi.mock('#lib/components/assets/thumbnail/Thumbnail.svelte', async () => {
  const { default: MockThumbnail } = await import('#test/unit/mocks/FilmstripThumbnail.svelte');
  return { default: MockThumbnail };
});

const renderStrip = async (props: ComponentProps<typeof AssetViewerFilmstrip>) => {
  const screen = await render(AssetViewerFilmstrip, props);
  return {
    ...screen,
    getByRole: (role: 'listbox' | 'option') => screen.getByRole(role).element(),
    getAllByRole: (role: 'option') => screen.getByRole(role).elements(),
    getByTestId: (id: string) => screen.getByTestId(id).element(),
  };
};

describe('AssetViewerFilmstrip', () => {
  it('renders the current asset and adjacent thumbnails', async () => {
    const assets = Array.from({ length: 3 }, () => factory.asset());
    const { getByRole, getByTestId, getAllByRole } = await renderStrip({
      assets,
      currentAssetId: assets[1].id,
      onAssetSelect: vi.fn(),
    });

    await expect.element(getByRole('listbox')).toBeInTheDocument();
    await expect.element(getByTestId(`filmstrip-thumbnail-${assets[0].id}`)).toBeInTheDocument();
    await expect.element(getByTestId(`filmstrip-thumbnail-${assets[1].id}`)).toBeInTheDocument();
    expect(getAllByRole('option')).toHaveLength(3);
    await expect.element(getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await expect.element(getAllByRole('option')[1]).toHaveClass('relative', 'size-14', 'overflow-hidden');
  });

  it('preloads a bounded window around the current asset', async () => {
    const assets = Array.from({ length: 30 }, () => factory.asset());
    const { getByTestId } = await renderStrip({
      assets,
      currentAssetId: assets[15].id,
      onAssetSelect: vi.fn(),
    });

    await expect.element(getByTestId(`filmstrip-thumbnail-${assets[3].id}`)).toHaveAttribute('data-preload', 'true');
    await expect.element(getByTestId(`filmstrip-thumbnail-${assets[2].id}`)).toHaveAttribute('data-preload', 'false');
    await expect.element(getByTestId(`filmstrip-thumbnail-${assets[15].id}`)).toHaveAttribute('data-preload', 'true');
  });

  it('selects a thumbnail when it is tapped', async () => {
    const assets = Array.from({ length: 2 }, () => factory.asset());
    const onAssetSelect = vi.fn();
    const { getByTestId } = await renderStrip({
      assets,
      currentAssetId: assets[0].id,
      onAssetSelect,
    });

    getByTestId(`filmstrip-thumbnail-${assets[1].id}`).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onAssetSelect).toHaveBeenCalledWith(assets[1]);
  });

  it('waits for scrolling to settle before selecting the centered asset', async () => {
    const assets = Array.from({ length: 3 }, () => factory.asset());
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole } = await renderStrip({
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

    scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    expect(onAssetSelect).not.toHaveBeenCalled();

    scroller.dispatchEvent(new Event('scrollend'));
    expect(onAssetSelect).toHaveBeenCalledWith(assets[1]);
  });

  it('does not recenter after scrolling and updating the current asset', async () => {
    const assets = Array.from({ length: 3 }, () => factory.asset());
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole, rerender } = await renderStrip({
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

    scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    scroller.dispatchEvent(new Event('scrollend'));
    await rerender({ assets, currentAssetId: assets[1].id, onAssetSelect });

    expect(onAssetSelect).toHaveBeenCalledExactlyOnceWith(assets[1]);
    expect(recenter).not.toHaveBeenCalled();

    scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    scroller.dispatchEvent(new Event('scrollend'));
    expect(recenter).not.toHaveBeenCalled();
    expect(onAssetSelect).toHaveBeenCalledTimes(1);
  });

  it('positions a refreshed timeline window immediately without smooth scrolling', async () => {
    const assets = Array.from({ length: 4 }, () => factory.asset());
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole, rerender } = await renderStrip({
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
    const assets = Array.from({ length: 3 }, () => factory.asset());
    const onAssetSelect = vi.fn();
    const { getByRole, getAllByRole, rerender } = await renderStrip({
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

    scroller.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    scroller.dispatchEvent(new Event('scroll'));
    scroller.dispatchEvent(new Event('scrollend'));
    expect(onAssetSelect).toHaveBeenCalledExactlyOnceWith(assets[1]);

    await rerender({ assets: [...assets], currentAssetId: assets[0].id, onAssetSelect });

    expect(recenterOldAsset).not.toHaveBeenCalled();
    await expect.element(getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });
});
