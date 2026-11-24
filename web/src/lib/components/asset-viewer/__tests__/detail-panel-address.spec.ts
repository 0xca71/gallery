import { reactivePageMock } from '#lib/gallery/__mocks__/reactive-page.mock.svelte.ts';
import { slideshowStore } from '#lib/stores/slideshow.store.ts';
import { factory } from '#test/unit/factories.ts';
import { renderWithTooltips } from '#test/unit/helpers.ts';
import { ensureAssetAddress, updateAsset, type AssetResponseDto } from '@immich/sdk';
import type * as SDK from '@immich/sdk';
import { modalManager } from '@immich/ui';
import type * as UI from '@immich/ui';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import DetailPanelLocation from '../DetailPanelLocation.svelte';
import SlideshowMetadataOverlay from '../SlideshowMetadataOverlay.svelte';

// Hoisted mocks must load their modules lazily, after Vitest registers the mock factories.
vi.mock('$app/state', async () => {
  const { reactivePageMock } = await import('#lib/gallery/__mocks__/reactive-page.mock.svelte.ts');
  return { page: reactivePageMock };
});
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof SDK>()),
  ensureAssetAddress: vi.fn(),
  updateAsset: vi.fn(),
}));
vi.mock('@immich/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof UI>()),
  modalManager: { show: vi.fn().mockResolvedValue(undefined) },
}));

const address = '中国湖北省武汉市硚口区长丰街道解放大道22号';
const nanjingAddress = '中国江苏省南京市秦淮区夫子庙街道平江府路34号';
const asset = (formattedAddress: string | null = null): AssetResponseDto =>
  factory.asset({
    id: 'asset-1',
    exifInfo: {
      latitude: 30.602597,
      longitude: 114.186145,
      country: '中国',
      state: '湖北省',
      city: '武汉市',
      formattedAddress,
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  reactivePageMock.reset('https://gallery.test/photos/asset-1');
  vi.mocked(ensureAssetAddress).mockReset().mockResolvedValue({ formattedAddress: address });
  vi.mocked(modalManager.show).mockResolvedValue(undefined as never);
  slideshowStore.slideshowShowMetadataOverlay.set(false);
});
afterEach(() => vi.restoreAllMocks());

it('resolves a missing address once and publishes the complete asset to its consumer', async () => {
  const onAddressResolved = vi.fn();
  await renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: true, canFilter: true, onAddressResolved });
  await expect.element(page.getByTestId('detailed-address')).toHaveTextContent('硚口区长丰街道解放大道22号');
  expect(ensureAssetAddress).toHaveBeenCalledTimes(1);
  expect(ensureAssetAddress).toHaveBeenCalledWith({ id: 'asset-1' });
  expect(onAddressResolved).toHaveBeenCalledWith(
    expect.objectContaining({ exifInfo: expect.objectContaining({ formattedAddress: address }) }),
  );
  await expect.element(page.getByLabelText('filter_by_location: 武汉市')).toBeInTheDocument();
});

it('displays a persisted address without another lookup', async () => {
  await renderWithTooltips(DetailPanelLocation, { asset: asset(address), isOwner: true });
  await expect.element(page.getByTestId('detailed-address')).toHaveTextContent('硚口区长丰街道解放大道22号');
  expect(ensureAssetAddress).not.toHaveBeenCalled();
});

it('does not spend provider quota on shared links', async () => {
  await renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: false, canFilter: false });
  await expect.element(page.getByText('武汉市')).toBeInTheDocument();
  expect(ensureAssetAddress).not.toHaveBeenCalled();
});

it('allows a space viewer to resolve an address without a location-edit affordance', async () => {
  await renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: false, canFilter: true });
  await expect.element(page.getByTestId('detailed-address')).toHaveTextContent('硚口区长丰街道解放大道22号');
  await expect.element(page.getByLabelText('edit_location')).not.toBeInTheDocument();
});

it('retains the original location when the provider is unavailable', async () => {
  vi.mocked(ensureAssetAddress).mockRejectedValue(new Error('offline'));
  await renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: true });
  await expect.poll(() => vi.mocked(ensureAssetAddress).mock.calls.length).toBe(1);
  await expect.element(page.getByText('武汉市')).toBeInTheDocument();
  await expect.element(page.getByTestId('detailed-address')).not.toBeInTheDocument();
});

it('ignores a lookup completed after the user changes GPS and publishes the new location', async () => {
  const { promise, resolve: resolveOld } = Promise.withResolvers<{ formattedAddress: string | null }>();
  vi.mocked(ensureAssetAddress).mockImplementationOnce(() => promise);
  vi.mocked(ensureAssetAddress).mockResolvedValue({ formattedAddress: nanjingAddress });
  vi.mocked(modalManager.show).mockResolvedValue({ lat: 32.02, lng: 118.78 } as never);
  vi.mocked(updateAsset).mockResolvedValue(
    factory.asset({
      id: 'asset-1',
      exifInfo: {
        latitude: 32.02,
        longitude: 118.78,
        country: '中国',
        state: '江苏省',
        city: '南京市',
        formattedAddress: null,
      },
    }),
  );
  const onAddressResolved = vi.fn();
  await renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: true, onAddressResolved });
  await expect.poll(() => vi.mocked(ensureAssetAddress).mock.calls.length).toBe(1);
  await page.getByLabelText('edit_location').click();
  await expect.element(page.getByTestId('detailed-address')).toHaveTextContent('秦淮区夫子庙街道平江府路34号');
  resolveOld({ formattedAddress: address });
  await expect.poll(() => onAddressResolved.mock.calls.length).toBe(2);
  expect(onAddressResolved).toHaveBeenLastCalledWith(
    expect.objectContaining({
      exifInfo: expect.objectContaining({ latitude: 32.02, formattedAddress: nanjingAddress }),
    }),
  );
});

it('slideshow renders saved detailed addresses without looking up missing ones', async () => {
  slideshowStore.slideshowShowMetadataOverlay.set(true);
  await renderWithTooltips(SlideshowMetadataOverlay, { asset: asset(address) });
  await expect.element(page.getByText(address)).toBeInTheDocument();
  expect(ensureAssetAddress).not.toHaveBeenCalled();
});

it.each([
  { city: '南京市 秦淮区 夫子庙街道', expected: '平江府路34号' },
  { city: '南京市 秦淮区 新街口街道', expected: '夫子庙街道平江府路34号' },
  { city: '南京市 秦虹区 夫子庙街道', expected: '秦淮区夫子庙街道平江府路34号' },
  { city: '南京市 秦淮区 夫子庙镇', expected: '夫子庙街道平江府路34号' },
  { city: '南昌市 秦淮区 夫子庙街道', expected: '南京市秦淮区夫子庙街道平江府路34号' },
  { city: '南京市秦淮区夫子庙街道', expected: '平江府路34号' },
  { city: ' 南京市\u{3000}秦淮区  夫子庙街道 ', expected: '平江府路34号' },
])('omits only the matching location prefix for "$city"', async ({ city, expected }) => {
  await renderWithTooltips(DetailPanelLocation, {
    asset: factory.asset({ exifInfo: { country: '中国', state: '江苏省', city, formattedAddress: nanjingAddress } }),
    isOwner: true,
    canFilter: true,
  });
  await expect.poll(() => page.getByTestId('detailed-address').element().textContent).toBe(expected);
  await expect.element(page.getByLabelText(`filter_by_location: ${city.trim()}`)).toBeInTheDocument();
  expect(ensureAssetAddress).not.toHaveBeenCalled();
});

it.each([
  { country: '中国', state: '江西省', expected: '江苏省南京市秦淮区夫子庙街道平江府路34号' },
  { country: 'China', state: '江苏省', expected: nanjingAddress },
  { country: null, state: null, expected: nanjingAddress },
])('retains a differing prefix for $country / $state', async ({ country, state, expected }) => {
  await renderWithTooltips(DetailPanelLocation, {
    asset: factory.asset({
      exifInfo: { country, state, city: '南京市 秦淮区 夫子庙街道', formattedAddress: nanjingAddress },
    }),
    isOwner: false,
  });
  await expect.poll(() => page.getByTestId('detailed-address').element().textContent).toBe(expected);
});

it('handles whitespace between matching administrative address parts', async () => {
  await renderWithTooltips(DetailPanelLocation, {
    asset: factory.asset({
      exifInfo: {
        country: '中国',
        state: '江苏省',
        city: '南京市 秦淮区 夫子庙街道',
        formattedAddress: ' 中国 江苏省 南京市 秦淮区 夫子庙街道 平江府路34号 ',
      },
    }),
    isOwner: false,
  });
  await expect.element(page.getByTestId('detailed-address')).toHaveTextContent('平江府路34号');
});

it.each([address, '中国湖北省武汉市'])(
  'copies the full address even when its prefix is omitted: %s',
  async (fullAddress) => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await renderWithTooltips(DetailPanelLocation, { asset: asset(fullAddress), isOwner: true, canFilter: true });
    await page.getByRole('button', { name: 'copy_detailed_address' }).click();
    expect(writeText).toHaveBeenCalledWith(fullAddress);
    await expect.element(page.getByLabelText('filter_by_location: 武汉市')).toBeInTheDocument();
    if (fullAddress === '中国湖北省武汉市') {
      await expect.element(page.getByTestId('detailed-address')).not.toBeInTheDocument();
    }
  },
);
