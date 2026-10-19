import { ensureAssetAddress } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import DetailPanelLocation from '$lib/components/asset-viewer/DetailPanelLocation.svelte';
import SlideshowMetadataOverlay from '$lib/components/asset-viewer/SlideshowMetadataOverlay.svelte';
import { slideshowStore } from '$lib/stores/slideshow.store';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { reactivePageMock } from '@test-data/mocks/reactive-page.mock.svelte';

vi.mock('$app/state', async () => {
  const { reactivePageMock } = await import('@test-data/mocks/reactive-page.mock.svelte');
  return { page: reactivePageMock };
});
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  ensureAssetAddress: vi.fn(),
}));

const address = '中国湖北省武汉市硚口区长丰街道解放大道22号';
const addressRemainder = '硚口区长丰街道解放大道22号';
const nanjingAddress = '中国江苏省南京市秦淮区夫子庙街道平江府路34号';
const asset = (formattedAddress: string | null = null) =>
  assetFactory.build({
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
  reactivePageMock.reset('https://gallery.test/photos/asset-1');
  vi.mocked(ensureAssetAddress).mockReset().mockResolvedValue({ formattedAddress: address });
  slideshowStore.slideshowShowMetadataOverlay.set(false);
});

afterEach(() => vi.restoreAllMocks());

it('resolves missing addresses once, renders the result and publishes it to the viewer', async () => {
  const onAddressResolved = vi.fn();
  renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: true, canFilter: true, onAddressResolved });
  expect(await screen.findByTestId('detailed-address')).toHaveTextContent(addressRemainder);
  expect(ensureAssetAddress).toHaveBeenCalledTimes(1);
  expect(onAddressResolved).toHaveBeenCalledWith(
    expect.objectContaining({ exifInfo: expect.objectContaining({ formattedAddress: address }) }),
  );
  expect(screen.getByLabelText('filter_by_location: 武汉市')).toBeInTheDocument();
});

it('reuses saved addresses and does not spend quota on shared links', async () => {
  const saved = renderWithTooltips(DetailPanelLocation, { asset: asset(address), isOwner: true });
  expect(screen.getByTestId('detailed-address')).toHaveTextContent(addressRemainder);
  expect(ensureAssetAddress).not.toHaveBeenCalled();
  saved.unmount();
  renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: false, canFilter: false });
  await waitFor(() => expect(screen.getByText('武汉市')).toBeInTheDocument());
  expect(ensureAssetAddress).not.toHaveBeenCalled();
});

it('falls back to the original location when address lookup fails', async () => {
  vi.mocked(ensureAssetAddress).mockRejectedValue(new Error('offline'));
  renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: true });
  await waitFor(() => expect(ensureAssetAddress).toHaveBeenCalledTimes(1));
  expect(screen.getByText('武汉市')).toBeInTheDocument();
});

it('slideshow consumes saved detailed addresses without resolving missing ones', async () => {
  slideshowStore.slideshowShowMetadataOverlay.set(true);
  renderWithTooltips(SlideshowMetadataOverlay, { asset: asset(address) });
  expect(await screen.findByText(address)).toBeInTheDocument();
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
])('omits only the matching location prefix for "$city"', ({ city, expected }) => {
  renderWithTooltips(DetailPanelLocation, {
    asset: assetFactory.build({
      exifInfo: { country: '中国', state: '江苏省', city, formattedAddress: nanjingAddress },
    }),
    isOwner: true,
    canFilter: true,
  });

  expect(screen.getByTestId('detailed-address').textContent).toBe(expected);
  expect(
    screen.getByLabelText(`filter_by_location: ${city.trim()}`, { normalizer: (value) => value }),
  ).toBeInTheDocument();
  expect(ensureAssetAddress).not.toHaveBeenCalled();
});

it.each([
  { country: '中国', state: '江西省', expected: '江苏省南京市秦淮区夫子庙街道平江府路34号' },
  { country: 'China', state: '江苏省', expected: nanjingAddress },
  { country: null, state: null, expected: nanjingAddress },
])('retains the differing prefix for $country / $state', ({ country, state, expected }) => {
  renderWithTooltips(DetailPanelLocation, {
    asset: assetFactory.build({
      exifInfo: { country, state, city: '南京市 秦淮区 夫子庙街道', formattedAddress: nanjingAddress },
    }),
    isOwner: false,
  });

  expect(screen.getByTestId('detailed-address').textContent).toBe(expected);
});

it('handles whitespace between matching parts of the detailed address', () => {
  renderWithTooltips(DetailPanelLocation, {
    asset: assetFactory.build({
      exifInfo: {
        country: '中国',
        state: '江苏省',
        city: '南京市 秦淮区 夫子庙街道',
        formattedAddress: ' 中国 江苏省 南京市 秦淮区 夫子庙街道 平江府路34号 ',
      },
    }),
    isOwner: false,
  });

  expect(screen.getByTestId('detailed-address').textContent).toBe('平江府路34号');
});

it.each([address, '中国湖北省武汉市'])(
  'copies the full address even when some or all of its text is omitted',
  async (fullAddress) => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderWithTooltips(DetailPanelLocation, { asset: asset(fullAddress), isOwner: true, canFilter: true });

    const copy = screen.getByRole('button', { name: 'copy_detailed_address' });
    await fireEvent.click(copy);

    expect(writeText).toHaveBeenCalledWith(fullAddress);
    expect(copy.parentElement).toBe(screen.getByLabelText('view_in_map').parentElement);
    expect(copy.className).toBe(screen.getByLabelText('edit_location').className);
    expect(screen.getByLabelText('filter_by_location: 武汉市')).toBeInTheDocument();
    if (fullAddress === '中国湖北省武汉市') {
      expect(screen.queryByTestId('detailed-address')).not.toBeInTheDocument();
    }
  },
);
