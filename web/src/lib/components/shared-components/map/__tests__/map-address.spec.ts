import { queryClient } from '#lib/queries/client.ts';
import { getPublicConfigQuery } from '#lib/queries/config-public.query.ts';
import { defaultPublicConfig } from '#test/unit/gallery-config-defaults.ts';
import { beforeEach, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import '../../../../../app.css';
import MapAddressTest from './MapAddressTest.svelte';

const address = '中国湖北省武汉市硚口区长丰街道解放大道22号';
const marker = {
  id: '3c3f9cd0-8ac4-4f2c-9bd0-357d0dfe3c9a',
  lat: 30.6,
  lon: 114.18,
  country: '中国',
  state: '湖北省',
  city: '武汉市',
  formattedAddress: address,
};

beforeEach(() => {
  // A complete local style exercises the real MapLibre component without remote map tiles.
  const style = `data:application/json,${encodeURIComponent(JSON.stringify({ version: 8, sources: {}, layers: [] }))}`;
  queryClient.setQueryData(getPublicConfigQuery().queryKey, {
    ...defaultPublicConfig,
    map: { enabled: true, lightStyle: style, darkStyle: style },
  });
});

it('renders a saved detailed address on marker hover without a custom popup', async () => {
  await render(MapAddressTest, { marker });
  await expect.poll(() => page.getByTestId('map-location-marker').elements()).toHaveLength(1);
  await page.getByTestId('map-location-marker').hover();
  await expect.element(page.getByText(address, { exact: true })).toBeInTheDocument();
});

it('retains the address and unmodified GPS through GeoJSON into a caller popup', async () => {
  await render(MapAddressTest, { marker, customPopup: true });
  await expect.poll(() => page.getByTestId('map-location-marker').elements()).toHaveLength(1);
  await page.getByTestId('map-location-marker').click();
  await expect.element(page.getByTestId('custom-address-popup')).toHaveTextContent(address);
  await expect.element(page.getByTestId('custom-address-point')).toHaveTextContent('30.6,114.18');
});
