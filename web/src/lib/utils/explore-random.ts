import {
  AssetTypeEnum,
  searchAssetStatistics,
  searchRandom,
  type AssetResponseDto,
  type SearchFilter,
} from '@immich/sdk';
import { DateTime } from 'luxon';

export const dateRanges = ['all', 'last_year', 'years_1_3', 'years_3_5', 'years_5_10', 'older_10'] as const;
export type RandomDateRange = (typeof dateRanges)[number] | 'custom';
export const dateRangeOptions = [...dateRanges, 'custom'] satisfies RandomDateRange[];

export type RandomFilterState = {
  mediaType: 'all' | 'image' | 'video';
  albumId: string;
  dateRange: RandomDateRange;
  takenAfter: string;
  takenBefore: string;
};

export const defaultRandomFilter = (): RandomFilterState => ({
  mediaType: 'all',
  albumId: '',
  dateRange: 'all',
  takenAfter: '',
  takenBefore: '',
});

export const isSameRandomFilter = (a: RandomFilterState, b: RandomFilterState) =>
  a.mediaType === b.mediaType &&
  a.albumId === b.albumId &&
  a.dateRange === b.dateRange &&
  a.takenAfter === b.takenAfter &&
  a.takenBefore === b.takenBefore;

export function buildCustomDateRange(after: string, before: string) {
  const start = after ? DateTime.fromISO(after) : undefined;
  const end = before ? DateTime.fromISO(before) : undefined;
  const from = start?.isValid ? start : undefined;
  const to = end?.isValid ? end : undefined;
  const [lower, upper] = from && to && from > to ? [to, from] : [from, to];
  const gte = lower?.toUTC().toISO() ?? undefined;
  const lt = upper?.plus({ days: 1 }).toUTC().toISO() ?? undefined;
  if (!gte && !lt) {
    return undefined;
  }
  return { gte, lt };
}

export function buildRandomSearchFilter(
  state: RandomFilterState,
  now: DateTime<boolean> = DateTime.now(),
): SearchFilter {
  const filter: SearchFilter = {};
  if (state.mediaType !== 'all') {
    filter.type = { eq: state.mediaType === 'image' ? AssetTypeEnum.Image : AssetTypeEnum.Video };
  }
  if (state.albumId) {
    filter.albumIds = { any: [state.albumId] };
  }
  if (state.dateRange === 'custom') {
    const custom = buildCustomDateRange(state.takenAfter, state.takenBefore);
    if (custom) {
      filter.takenAt = custom;
    }
    return filter;
  }

  const ago = (years: number) => now.minus({ years }).toUTC().toISO()!;
  switch (state.dateRange) {
    case 'last_year': {
      filter.takenAt = { gte: ago(1), lt: ago(0) };
      break;
    }
    case 'years_1_3': {
      filter.takenAt = { gte: ago(3), lt: ago(1) };
      break;
    }
    case 'years_3_5': {
      filter.takenAt = { gte: ago(5), lt: ago(3) };
      break;
    }
    case 'years_5_10': {
      filter.takenAt = { gte: ago(10), lt: ago(5) };
      break;
    }
    case 'older_10': {
      filter.takenAt = { lt: ago(10) };
      break;
    }
    default: {
      break;
    }
  }
  return filter;
}

export const RANDOM_BATCH_SIZE = 200;

export function mergeUniqueAssets(assets: AssetResponseDto[], incoming: AssetResponseDto[]) {
  const seen = new Set(assets.map((asset) => asset.id));
  const added = incoming.filter((asset) => !seen.has(asset.id));
  return { assets: added.length > 0 ? [...assets, ...added] : assets, added: added.length };
}

export function loadRandomBatch(filter: SearchFilter, signal: AbortSignal, size = RANDOM_BATCH_SIZE) {
  return searchRandom({ randomSearchDto: { size, filter } }, { signal });
}

export async function loadRandomTotal(filter: SearchFilter, signal: AbortSignal) {
  const { total } = await searchAssetStatistics({ statisticsSearchDto: { filter } }, { signal });
  return total;
}

export function isRandomExhausted(loaded: number, total: number | null, added: number) {
  return added === 0 || (total !== null && loaded >= total);
}
