import { init, register, waitLocale } from 'svelte-i18n';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import LocationFilter from '../location-filter.svelte';

beforeAll(async () => {
  register('en-US', () => import('#i18n/en.json'));
  await init({ fallbackLocale: 'en-US', initialLocale: 'en-US' });
  await waitLocale('en-US');
});

it('expands a single country without selecting it and lazily browses state cities', async () => {
  const onSelectionChange = vi.fn();
  const onStateFetch = vi.fn(() => Promise.resolve(['Hubei', 'Zhejiang']));
  const onCityFetch = vi.fn((_country: string, context?: { state?: string }) =>
    Promise.resolve(context?.state === 'Hubei' ? ['Wuhan'] : ['Hangzhou']),
  );
  await render(LocationFilter, { countries: ['China'], onStateFetch, onCityFetch, onSelectionChange });
  await expect.element(page.getByTestId('location-state-Hubei')).toBeInTheDocument();
  expect(onSelectionChange).not.toHaveBeenCalled();
  expect(onCityFetch).not.toHaveBeenCalled();
  await userEvent.click(page.getByTestId('location-expand-state-China-Hubei'));
  await expect.element(page.getByTestId('location-city-China-Hubei-Wuhan')).toBeInTheDocument();
  expect(onCityFetch).toHaveBeenCalledWith('China', { state: 'Hubei' });
  await userEvent.click(page.getByTestId('location-city-China-Hubei-Wuhan'));
  expect(onSelectionChange).toHaveBeenCalledWith('China', 'Wuhan', 'Hubei');
});

it('keeps country-wide cities reachable when the scoped state list is empty', async () => {
  await render(LocationFilter, {
    countries: ['China'],
    onStateFetch: () => Promise.resolve([]),
    onCityFetch: () => Promise.resolve(['Wuhan']),
    onSelectionChange: vi.fn(),
  });
  await expect.element(page.getByTestId('location-city-Wuhan')).toBeInTheDocument();
});

it('discards an in-flight city list when its query scope changes', async () => {
  const { promise, resolve: finish } = Promise.withResolvers<string[]>();
  const onCityFetch = vi
    .fn()
    .mockImplementationOnce(() => promise)
    .mockResolvedValue(['New city']);
  const view = await render(LocationFilter, {
    countries: ['China'],
    onCityFetch,
    scopeKey: 'first',
    onSelectionChange: vi.fn(),
  });
  await vi.waitFor(() => expect(onCityFetch).toHaveBeenCalledTimes(1));
  await view.rerender({ countries: ['China'], onCityFetch, scopeKey: 'second', onSelectionChange: vi.fn() });
  await expect.element(page.getByTestId('location-city-New city')).toBeInTheDocument();
  finish(['Old city']);
  await vi.waitFor(() => expect(page.getByTestId('location-city-Old city').query()).toBeNull());
});
