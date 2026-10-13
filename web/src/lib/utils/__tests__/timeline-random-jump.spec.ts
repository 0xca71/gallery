import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { pickRandomTimelineAsset } from '$lib/utils/timeline-random-jump';

describe('pickRandomTimelineAsset', () => {
  const assets = ['first', 'middle', 'last'].map((id) => ({ id }) as TimelineAsset);

  afterEach(() => vi.restoreAllMocks());

  it('samples by the total filtered count, including assets outside the viewport', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const getRandomAsset = vi.fn((index = 0) => Promise.resolve(assets[index]));

    expect(await pickRandomTimelineAsset({ assetCount: 3, getRandomAsset }, null, () => true)).toEqual(assets[2]);
    expect(getRandomAsset).toHaveBeenCalledWith(2);
  });

  it('samples another index when the first draw repeats the previous target', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.5).mockReturnValueOnce(0.9);
    const getRandomAsset = vi.fn((index = 0) => Promise.resolve(assets[index]));

    expect(await pickRandomTimelineAsset({ assetCount: 3, getRandomAsset }, 'middle', () => true)).toEqual(assets[2]);
    expect(getRandomAsset.mock.calls).toEqual([[1], [2]]);
  });

  it('can choose an earlier index when avoiding the previous target', async () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.99).mockReturnValueOnce(0);
    const getRandomAsset = vi.fn((index = 0) => Promise.resolve(assets[index]));

    expect(await pickRandomTimelineAsset({ assetCount: 3, getRandomAsset }, 'last', () => true)).toEqual(assets[0]);
    expect(getRandomAsset.mock.calls).toEqual([[2], [0]]);
  });

  it('allows a single matching asset to be selected again', async () => {
    const getRandomAsset = vi.fn().mockResolvedValue(assets[0]);

    expect(await pickRandomTimelineAsset({ assetCount: 1, getRandomAsset }, 'first', () => true)).toEqual(assets[0]);
    expect(getRandomAsset).toHaveBeenCalledOnce();
  });

  it('does not load a bucket for empty results', async () => {
    const getRandomAsset = vi.fn();

    expect(await pickRandomTimelineAsset({ assetCount: 0, getRandomAsset }, null, () => true)).toBeUndefined();
    expect(getRandomAsset).not.toHaveBeenCalled();
  });

  it('discards an old result before sampling another bucket', async () => {
    const getRandomAsset = vi.fn().mockResolvedValue(assets[0]);
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    expect(await pickRandomTimelineAsset({ assetCount: 3, getRandomAsset }, 'first', isCurrent)).toBeUndefined();
    expect(getRandomAsset).toHaveBeenCalledOnce();
  });
});
