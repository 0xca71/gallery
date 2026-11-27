import { factory } from '#test/unit/factories.ts';
import { DateTime } from 'luxon';
import {
  buildRandomSearchFilter,
  buildRandomSearchQuery,
  defaultRandomFilter,
  mergeUniqueAssets,
} from './explore-random';

it('keeps a custom date interval inclusive of its final calendar day', () => {
  expect(
    buildRandomSearchFilter({
      ...defaultRandomFilter(),
      dateRange: 'custom',
      takenAfter: '2024-07-01',
      takenBefore: '2024-07-31',
    }),
  ).toEqual({
    takenAfter: DateTime.fromISO('2024-07-01').toUTC().toISO(),
    takenBefore: DateTime.fromISO('2024-08-01').toUTC().toISO(),
  });
});
it('intersects a custom random interval with the current temporal scope instead of replacing it', () => {
  const scope = {
    country: 'China',
    state: 'Hubei',
    city: 'Wuhan',
    libraryId: crypto.randomUUID(),
    takenAfter: '2024-07-15T00:00:00.000Z',
    takenBefore: '2024-07-20T00:00:00.000Z',
  };
  expect(
    buildRandomSearchQuery(
      { ...defaultRandomFilter(), dateRange: 'custom', takenAfter: '2024-07-01', takenBefore: '2024-07-31' },
      scope,
    ),
  ).toEqual(scope);
});
it('keeps the previous random order and appends each incoming asset only once', () => {
  const a = factory.asset();
  const b = factory.asset();
  expect(mergeUniqueAssets([a], [a, b, b])).toEqual({ assets: [a, b], added: 1 });
});
