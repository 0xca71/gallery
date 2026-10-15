import { ensureAssetAddress } from '@immich/sdk';
import '@testing-library/jest-dom';
import { screen, waitFor } from '@testing-library/svelte';
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

it('resolves missing addresses once, renders the result and publishes it to the viewer', async () => {
  const onAddressResolved = vi.fn();
  renderWithTooltips(DetailPanelLocation, { asset: asset(), isOwner: true, canFilter: true, onAddressResolved });
  expect(await screen.findByText(address)).toBeInTheDocument();
  expect(ensureAssetAddress).toHaveBeenCalledTimes(1);
  expect(onAddressResolved).toHaveBeenCalledWith(
    expect.objectContaining({ exifInfo: expect.objectContaining({ formattedAddress: address }) }),
  );
  expect(screen.getByLabelText('filter_by_location: 武汉市')).toBeInTheDocument();
});

it('reuses saved addresses and does not spend quota on shared links', async () => {
  const saved = renderWithTooltips(DetailPanelLocation, { asset: asset(address), isOwner: true });
  expect(screen.getByText(address)).toBeInTheDocument();
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
