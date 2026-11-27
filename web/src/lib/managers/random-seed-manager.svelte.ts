import { isSameRandomFilter, type RandomFilterState } from '#lib/utils/explore-random.ts';
import type { AssetResponseDto } from '@immich/sdk';

type RandomSeed = { assets: AssetResponseDto[]; filter: RandomFilterState; scopeKey: string };

class RandomSeedManager {
  #seed = $state<RandomSeed>();

  set(assets: AssetResponseDto[], filter: RandomFilterState, scopeKey = '') {
    this.#seed = assets.length > 0 ? { assets, filter: { ...filter }, scopeKey } : undefined;
  }

  take(filter: RandomFilterState, scopeKey = ''): AssetResponseDto[] | undefined {
    const seed = this.#seed;
    if (!seed || !isSameRandomFilter(seed.filter, filter) || seed.scopeKey !== scopeKey) {
      return undefined;
    }

    this.#seed = undefined;
    return seed.assets;
  }

  clear() {
    this.#seed = undefined;
  }
}

export const randomSeedManager = new RandomSeedManager();
