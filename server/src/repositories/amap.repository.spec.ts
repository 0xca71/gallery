import type { Kysely } from 'kysely';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { DB } from 'src/schema/index.js';
import { AmapRepository } from 'src/repositories/amap.repository.js';

const { redis } = vi.hoisted(() => ({
  redis: { get: vi.fn(), set: vi.fn(), exists: vi.fn(), eval: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor() {
      return redis;
    }
  },
}));

const stored = {
  latitude: 30.602597,
  longitude: 114.186145,
  country: 'China',
  state: '湖北省',
  formattedAddress: null,
};
const payload = {
  status: '1',
  infocode: '10000',
  regeocode: {
    addressComponent: {
      country: '中国',
      province: '湖北省',
      city: '武汉市',
      district: '硚口区',
      township: '长丰街道',
      adcode: '420104',
    },
  },
};

function setup(exif: Record<string, unknown> = stored) {
  const select = {
    innerJoin: vi.fn(),
    select: vi.fn(),
    where: vi.fn(),
    executeTakeFirst: vi.fn().mockResolvedValueOnce(exif).mockResolvedValue({ admin_a3: 'CHN' }),
  };
  const update = {
    set: vi.fn(),
    where: vi.fn(),
    returning: vi.fn(),
    executeTakeFirst: vi.fn().mockResolvedValue({ formattedAddress: '中国湖北省武汉市硚口区长丰街道' }),
  };
  for (const key of ['innerJoin', 'select', 'where'] as const) select[key].mockReturnValue(select);
  for (const key of ['set', 'where', 'returning'] as const) update[key].mockReturnValue(update);
  const db = { selectFrom: vi.fn().mockReturnValue(select), updateTable: vi.fn().mockReturnValue(update) };
  const config = { getEnv: vi.fn().mockReturnValue({ redis: {} }) };
  const logger = { warn: vi.fn() };
  return {
    sut: new AmapRepository(
      config as unknown as ConfigRepository,
      logger as unknown as LoggingRepository,
      db as unknown as Kysely<DB>,
    ),
    db,
    update,
    select,
    logger,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('GALLERY_AMAP_ENABLED', 'true');
  vi.stubEnv('GALLERY_AMAP_KEY', 'test-key');
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
  redis.exists.mockResolvedValue(0);
  redis.eval.mockResolvedValue(0);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AmapRepository', () => {
  it('does no DB or network work until explicitly enabled', async () => {
    vi.stubEnv('GALLERY_AMAP_ENABLED', 'false');
    const { sut, db } = setup();
    expect(await sut.ensureAddress('asset-1', 'detail')).toBeNull();
    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reuses stored addresses and excludes overseas coordinates', async () => {
    expect(await setup({ ...stored, formattedAddress: 'existing' }).sut.ensureAddress('asset-1', 'detail')).toBe(
      'existing',
    );
    expect(await setup({ ...stored, country: 'Thailand' }).sut.ensureAddress('asset-1', 'detail')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a China boundary match before any provider call', async () => {
    const { sut, select } = setup();
    select.executeTakeFirst.mockReset().mockResolvedValueOnce(stored).mockResolvedValue(undefined);
    expect(await sut.ensureAddress('asset-1', 'metadata')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('converts the persisted GPS and conditionally writes only the address', async () => {
    const { sut, update } = setup();
    expect(await sut.ensureAddress('asset-1', 'metadata')).toBe('中国湖北省武汉市硚口区长丰街道');
    const url = vi.mocked(fetch).mock.calls[0][0] as URL;
    expect(url.searchParams.get('location')).toBe('114.191685,30.600204');
    expect(update.set).toHaveBeenCalledWith({ formattedAddress: '中国湖北省武汉市硚口区长丰街道' });
    expect(update.where).toHaveBeenCalledWith('latitude', '=', stored.latitude);
    expect(update.where).toHaveBeenCalledWith('longitude', '=', stored.longitude);
    expect(update.where).toHaveBeenCalledWith('formattedAddress', 'is', null);
  });

  it('does not display an address if the GPS changed before the conditional update', async () => {
    const { sut, update } = setup();
    update.executeTakeFirst.mockResolvedValue(undefined);
    expect(await sut.ensureAddress('asset-1', 'detail')).toBeNull();
  });

  it('stops at the shared request budget and preserves metadata on network failure', async () => {
    redis.eval.mockResolvedValue(-1);
    const first = setup();
    expect(await first.sut.ensureAddress('asset-1', 'detail')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(first.db.updateTable).not.toHaveBeenCalled();
    redis.eval.mockResolvedValue(0);
    vi.mocked(fetch).mockRejectedValue(new Error('network'));
    const second = setup();
    expect(await second.sut.ensureAddress('asset-1', 'metadata')).toBeNull();
    expect(second.db.updateTable).not.toHaveBeenCalled();
  });
});
