import { librarySpaces, libraryView } from '#lib/gallery/library-view/library-view.svelte.ts';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { randomSeedManager } from '#lib/managers/random-seed-manager.svelte.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { LibraryView } from '@immich/sdk';
import { expect } from 'vitest';
import { cleanup, render } from 'vitest-browser-svelte';
import RandomSection from './RandomSection.svelte';

test.beforeEach(async () => {
  await authManager.load();
  randomSeedManager.clear();
  librarySpaces.list = undefined;
});
test.afterEach(() => {
  cleanup();
  libraryView.current = 'both';
  librarySpaces.list = undefined;
  randomSeedManager.clear();
});

test.for(['both', LibraryView.Personal, LibraryView.Spaces] as const)(
  'requests random candidates within the current %s scope and location/library/date filters',
  async (view, { api }) => {
    libraryView.current = view;
    const assets = [factory.asset()];
    api.on({ searchRandom: () => ({ json: assets }) });
    const scope = {
      libraryId: crypto.randomUUID(),
      country: 'China',
      state: 'Hubei',
      city: 'Wuhan',
      takenAfter: '2024-07-01T00:00:00.000Z',
      takenBefore: '2024-08-01T00:00:00.000Z',
    };
    await render(RandomSection, { scope, onselect: vi.fn() });
    await vi.waitFor(() => expect(api.searchRandom.calls).toHaveLength(1));
    const request = {
      body: expect.objectContaining({
        ...scope,
        withSharedSpaces: true,
        visibility: 'timeline',
        size: 24,
        ...(view !== 'both' && { libraryView: view }),
      }),
    };
    expect(api.searchRandom.calls[0]).toEqual(request);
    expect(api.searchRandom).toHaveBeenCalledWith(request);
  },
);

test('prefetches a new unique batch near the end of the Explore overlay without scrolling its sentinel', async ({
  api,
}) => {
  const first = Array.from({ length: 24 }, () => factory.asset());
  const next = Array.from({ length: 200 }, () => factory.asset());
  let requests = 0;
  api.on({ searchRandom: () => ({ json: requests++ === 0 ? first : next }) });
  const onassetschange = vi.fn();
  const view = await render(RandomSection, { onselect: vi.fn(), onassetschange });
  await vi.waitFor(() => expect(onassetschange).toHaveBeenLastCalledWith(first));
  await view.rerender({ onselect: vi.fn(), onassetschange, viewerAssetId: first[0].id });
  await vi.waitFor(() => expect(onassetschange).toHaveBeenLastCalledWith([...first, ...next]));
  expect(api.searchRandom.calls).toHaveLength(2);
  expect(api.searchRandom).toHaveBeenCalledWith({ body: expect.objectContaining({ size: 24 }) });
  expect(api.searchRandom).toHaveBeenCalledWith({ body: expect.objectContaining({ size: 200 }) });
});
