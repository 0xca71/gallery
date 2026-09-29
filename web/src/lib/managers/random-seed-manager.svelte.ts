import type { AssetResponseDto } from '@immich/sdk';
import { isSameRandomFilter, type RandomFilterState } from '$lib/utils/explore-random';

type RandomSeed = { assets: AssetResponseDto[]; filter: RandomFilterState };

class RandomSeedManager {
  #seed = $state<RandomSeed>();

  set(assets: AssetResponseDto[], filter: RandomFilterState) {
    this.#seed = assets.length > 0 ? { assets, filter: { ...filter } } : undefined;
  }

  take(filter: RandomFilterState): AssetResponseDto[] | undefined {
    const seed = this.#seed;
    if (!seed || !isSameRandomFilter(seed.filter, filter)) {
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
