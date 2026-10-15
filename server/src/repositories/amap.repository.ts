import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import {
  ADDRESS_FORMAT_VERSION,
  amapLocation,
  formatAmapAddress,
  isMainlandCandidate,
  readAmapConfig,
} from 'src/gallery/amap-address.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';

// Reserve a request and enforce a shared rate across API and metadata worker processes.
const RESERVE = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
if tonumber(redis.call('GET', KEYS[1]) or '0') >= tonumber(ARGV[1]) then return -1 end
local wait = tonumber(redis.call('GET', KEYS[2]) or '0') - now
if wait > 0 then return wait end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], 3888000)
redis.call('SET', KEYS[2], now + tonumber(ARGV[2]), 'PX', 60000)
return 0`;
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

@Injectable()
export class AmapRepository implements OnModuleDestroy {
  private config = readAmapConfig(process.env);
  private redis?: Redis;

  constructor(
    private configRepository: ConfigRepository,
    private logger: LoggingRepository,
    @InjectKysely() private db: Kysely<DB>,
  ) {}

  onModuleDestroy() {
    this.redis?.disconnect();
  }

  async ensureAddress(assetId: string, source: 'metadata' | 'detail'): Promise<string | null> {
    const config = this.config;
    if (!config.enabled || !config.key || !(source === 'metadata' ? config.metadataEnabled : config.onDemandEnabled)) {
      return null;
    }
    try {
      const exif = await this.db
        .selectFrom('asset_exif')
        .innerJoin('asset', 'asset.id', 'asset_exif.assetId')
        .select([
          'asset_exif.latitude',
          'asset_exif.longitude',
          'asset_exif.country',
          'asset_exif.state',
          'asset_exif.formattedAddress',
        ])
        .where('asset.id', '=', assetId)
        .where('asset.deletedAt', 'is', null)
        .executeTakeFirst();
      if (!exif || exif.latitude === null || exif.longitude === null) return null;
      if (exif.formattedAddress) return exif.formattedAddress;
      const point = { latitude: exif.latitude, longitude: exif.longitude };
      if (!isMainlandCandidate(point, exif.country, exif.state)) return null;
      // GeoNames nearest-place country labels alone cannot prove that a point is in mainland China.
      const country = await this.db
        .selectFrom('naturalearth_countries')
        .select('admin_a3')
        .where('admin_a3', '=', 'CHN')
        .where('coordinates', '@>', sql<string>`point(${point.longitude}, ${point.latitude})`)
        .executeTakeFirst();
      if (!country) return null;
      const address = await this.resolve(point);
      if (!address) return null;
      const written = await this.db
        .updateTable('asset_exif')
        .set({ formattedAddress: address })
        .where('assetId', '=', assetId)
        .where('latitude', '=', point.latitude)
        .where('longitude', '=', point.longitude)
        .where('formattedAddress', 'is', null)
        .where((eb) =>
          eb.exists(eb.selectFrom('asset').select('id').where('id', '=', assetId).where('deletedAt', 'is', null)),
        )
        .returning('formattedAddress')
        .executeTakeFirst();
      return written?.formattedAddress ?? null;
    } catch {
      // Do not log fetch URLs/errors, which can contain the provider key and GPS.
      this.logger.warn('Detailed address lookup unavailable; keeping existing location metadata');
      return null;
    }
  }

  private async resolve(point: { latitude: number; longitude: number }): Promise<string | null> {
    const config = this.config;
    if (!this.redis) {
      this.redis = new Redis({
        ...this.configRepository.getEnv().redis,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 1000,
        commandTimeout: 1000,
        retryStrategy: () => null,
      });
      this.redis.on('error', () => {
        /* Fail closed without logging the connection URI. */
      });
    }
    const redis = this.redis;
    const prefix = `gallery:amap:${createHash('sha256').update(config.key).digest('hex').slice(0, 16)}`;
    const month = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    }).format(new Date());
    const location = amapLocation(point);
    const queryKey = createHash('sha256')
      .update(`${ADDRESS_FORMAT_VERSION}:${config.maxStreetNumberDistance}:${location}`)
      .digest('hex');
    const lockKey = `${prefix}:lock:${queryKey}`;
    const cooldownKey = `${prefix}:cooldown:${queryKey}`;
    const resultKey = `${prefix}:result:${queryKey}`;
    const blockedKey = `${prefix}:blocked:${month}`;
    const cached = await redis.get(resultKey);
    if (cached) return cached;
    if (await redis.exists(cooldownKey, blockedKey)) return null;
    const token = randomUUID();
    if (!(await redis.set(lockKey, token, 'PX', config.timeoutMs + 10_000, 'NX'))) {
      const deadline = Date.now() + config.timeoutMs + 5000;
      while (Date.now() < deadline) {
        await setTimeout(100);
        const result = await redis.get(resultKey);
        if (result) return result;
        if (!(await redis.exists(lockKey))) break;
      }
      return null;
    }
    try {
      const deadline = Date.now() + 5000;
      while (true) {
        const wait = Number(
          await redis.eval(
            RESERVE,
            2,
            `${prefix}:used:${month}`,
            `${prefix}:next`,
            config.monthlyBudget,
            Math.ceil(1000 / config.qps),
          ),
        );
        if (wait < 0 || Date.now() + wait > deadline) return null;
        if (wait === 0) break;
        await setTimeout(wait);
      }
      const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
      url.search = new URLSearchParams({ key: config.key, location, extensions: 'base', output: 'JSON' }).toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(config.timeoutMs) });
      if (!response.ok) throw new Error('Provider HTTP failure');
      const payload = (await response.json()) as { infocode?: string };
      if (['10003', '10009', '10044'].includes(payload.infocode ?? '')) {
        await redis.set(blockedKey, '1', 'EX', 3_888_000);
      }
      if (['10001', '10002', '10005', '10007', '10013'].includes(payload.infocode ?? '')) {
        await redis.set(blockedKey, '1', 'EX', 3600);
      }
      const address = formatAmapAddress(payload, config.maxStreetNumberDistance);
      if (address) {
        await redis.set(resultKey, address, 'EX', 60);
      } else {
        await redis.set(cooldownKey, '1', 'EX', 3600);
      }
      return address;
    } catch {
      await redis.set(cooldownKey, '1', 'EX', 300);
      return null;
    } finally {
      await redis.eval(UNLOCK, 1, lockKey, token);
    }
  }
}
