import {
  AssetTypeEnum,
  searchAssetStatistics,
  searchRandom,
  type AssetResponseDto,
  type RandomSearchDto,
  type StatisticsSearchDto,
} from '@immich/sdk';
import { DateTime } from 'luxon';

export const dateRanges = ['all', 'last_year', 'years_1_3', 'years_3_5', 'years_5_10', 'older_10'] as const;
export type RandomDateRange = (typeof dateRanges)[number] | 'custom';
export const dateRangeOptions = [...dateRanges, 'custom'] satisfies RandomDateRange[];

type RandomSearchQuery = Pick<RandomSearchDto, 'albumIds' | 'takenAfter' | 'takenBefore' | 'type'>;

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
): RandomSearchQuery {
  const query: RandomSearchQuery = {};
  if (state.mediaType !== 'all') {
    query.type = state.mediaType === 'image' ? AssetTypeEnum.Image : AssetTypeEnum.Video;
  }
  if (state.albumId) {
    query.albumIds = [state.albumId];
  }
  if (state.dateRange === 'custom') {
    const custom = buildCustomDateRange(state.takenAfter, state.takenBefore);
    if (custom) {
      query.takenAfter = custom.gte;
      query.takenBefore = custom.lt;
    }
    return query;
  }

  const ago = (years: number) => now.minus({ years }).toUTC().toISO()!;
  switch (state.dateRange) {
    case 'last_year': {
      query.takenAfter = ago(1);
      query.takenBefore = ago(0);
      break;
    }
    case 'years_1_3': {
      query.takenAfter = ago(3);
      query.takenBefore = ago(1);
      break;
    }
    case 'years_3_5': {
      query.takenAfter = ago(5);
      query.takenBefore = ago(3);
      break;
    }
    case 'years_5_10': {
      query.takenAfter = ago(10);
      query.takenBefore = ago(5);
      break;
    }
    case 'older_10': {
      query.takenBefore = ago(10);
      break;
    }
    default: {
      break;
    }
  }
  return query;
}

export const RANDOM_BATCH_SIZE = 200;

export function mergeUniqueAssets(assets: AssetResponseDto[], incoming: AssetResponseDto[]) {
  const seen = new Set(assets.map((asset) => asset.id));
  const added = incoming.filter((asset) => !seen.has(asset.id));
  return { assets: added.length > 0 ? [...assets, ...added] : assets, added: added.length };
}

export function loadRandomBatch(query: RandomSearchQuery, signal: AbortSignal, size = RANDOM_BATCH_SIZE) {
  return searchRandom({ randomSearchDto: { ...query, size } }, { signal });
}

export async function loadRandomTotal(query: RandomSearchQuery, signal: AbortSignal) {
  const statisticsQuery: Pick<StatisticsSearchDto, keyof RandomSearchQuery> = query;
  const { total } = await searchAssetStatistics({ statisticsSearchDto: statisticsQuery }, { signal });
  return total;
}

export function isRandomExhausted(loaded: number, total: number | null, added: number) {
  return added === 0 || (total !== null && loaded >= total);
}
