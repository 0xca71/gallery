import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { AssetEditAction, type AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { AssetType, CacheControl, Colorspace, ImageFormat, RawExtractedFormat } from 'src/enum.js';
import {
  OnDemandFullsizeCache,
  OnDemandFullsizeDependencies,
  buildOnDemandFullsizeCacheKey,
  generateOnDemandFullsizeResponse,
} from 'src/gallery/utils/on-demand-fullsize.js';
import { ImmichStreamResponse } from 'src/utils/file.js';

async function readStreamText(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString();
}

function createDeps(): OnDemandFullsizeDependencies {
  return {
    galleryAssetRepository: {
      getForOnDemandFullsize: vi.fn(),
    } as any,
    imageAdjustRepository: {
      getForRender: vi.fn().mockResolvedValue(undefined),
    } as any,
    mediaRepository: {
      extract: vi.fn().mockResolvedValue(null),
      getImageMetadata: vi.fn(),
      writeExif: vi.fn().mockResolvedValue(true),
      decodeImage: vi.fn().mockResolvedValue({ data: Buffer.from('raw'), info: { width: 4032, height: 3024 } }),
      generateThumbnail: vi.fn(async (_decoded, _options, outputPath: string) => {
        await fs.writeFile(outputPath, Buffer.from('generated-jpeg'));
      }),
      copyTagGroup: vi.fn().mockResolvedValue(true),
    } as any,
    backendMedia: {
      ensureLocalFile: vi.fn((filePath: string) =>
        Promise.resolve({
          localPath: filePath,
          cleanup: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
        }),
      ),
    } as any,
    logger: {
      warn: vi.fn(),
    } as any,
    getConfig: vi.fn().mockResolvedValue({
      image: {
        colorspace: Colorspace.P3,
        extractEmbedded: false,
        preview: { size: 1440 },
        fullsize: { enabled: false, format: ImageFormat.Jpeg, quality: 80, progressive: false },
      },
    } as unknown as SystemConfig),
  };
}

describe('on-demand-fullsize', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await fs.mkdtemp(join(tmpdir(), 'gallery-on-demand-fullsize-test-'));
  });

  afterEach(async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  describe('buildOnDemandFullsizeCacheKey', () => {
    const baseParams = {
      assetId: 'asset-1',
      fileModifiedAt: new Date('2026-10-30T10:00:00.000Z'),
      format: ImageFormat.Jpeg,
      quality: 80,
      progressive: false,
      colorspace: Colorspace.Srgb,
      extractEmbedded: false,
      useEdits: false,
      edits: [],
    };

    it('produces distinct keys when fileModifiedAt or quality changes', () => {
      const k1 = buildOnDemandFullsizeCacheKey(baseParams);
      const k2 = buildOnDemandFullsizeCacheKey({
        ...baseParams,
        fileModifiedAt: new Date('2026-10-31T10:00:00.000Z'),
      });
      const k3 = buildOnDemandFullsizeCacheKey({ ...baseParams, quality: 70 });

      expect(k1).not.toBe(k2);
      expect(k1).not.toBe(k3);
      expect(k2).not.toBe(k3);
    });

    it('ignores edits when useEdits is false and includes them when useEdits is true', () => {
      const edits: AssetEditActionItem[] = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];
      const withoutUseEdits = buildOnDemandFullsizeCacheKey({ ...baseParams, useEdits: false, edits });
      const baseline = buildOnDemandFullsizeCacheKey(baseParams);
      const withUseEdits = buildOnDemandFullsizeCacheKey({ ...baseParams, useEdits: true, edits });

      expect(withoutUseEdits).toBe(baseline);
      expect(withUseEdits).not.toBe(baseline);
    });
  });

  describe(OnDemandFullsizeCache.name, () => {
    it('caches generated files across requests and reuses them without regenerating', async () => {
      const cache = new OnDemandFullsizeCache({ cacheDir });
      const generate = vi.fn(async (tempPath: string) => {
        await fs.writeFile(tempPath, Buffer.from('jpeg-bytes-1'));
      });

      const first = await cache.openOrGenerate('key-1', 'asset-1.jpeg', generate);
      const firstText = await readStreamText(first.handle.createReadStream({ autoClose: true }));

      const second = await cache.openOrGenerate('key-1', 'asset-1.jpeg', generate);
      const secondText = await readStreamText(second.handle.createReadStream({ autoClose: true }));

      expect(generate).toHaveBeenCalledTimes(1);
      expect(firstText).toBe('jpeg-bytes-1');
      expect(secondText).toBe('jpeg-bytes-1');
      expect(first.size).toBe(12);
      expect(cache.getStats()).toEqual({ entries: 1, totalBytes: 12, inFlight: 0 });
    });

    it('deduplicates concurrent requests for the same cache key', async () => {
      const cache = new OnDemandFullsizeCache({ cacheDir });
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const generate = vi.fn(async (tempPath: string) => {
        await gate;
        await fs.writeFile(tempPath, Buffer.from('shared-fullsize'));
      });

      const p1 = cache.openOrGenerate('same-key', 'same.jpeg', generate);
      const p2 = cache.openOrGenerate('same-key', 'same.jpeg', generate);
      const p3 = cache.openOrGenerate('same-key', 'same.jpeg', generate);

      // Give all callers a tick to join the in-flight promise.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cache.getStats().inFlight).toBe(1);

      release();
      const results = await Promise.all([p1, p2, p3]);
      const payloads = await Promise.all(
        results.map(({ handle }) => readStreamText(handle.createReadStream({ autoClose: true }))),
      );

      expect(generate).toHaveBeenCalledTimes(1);
      expect(payloads).toEqual(['shared-fullsize', 'shared-fullsize', 'shared-fullsize']);
      expect(cache.getStats().inFlight).toBe(0);
    });

    it('evicts least-recently-used entries when maxEntries or maxBytes is exceeded while keeping open handles readable', async () => {
      const cache = new OnDemandFullsizeCache({ cacheDir, maxEntries: 2, maxBytes: 20 });

      const a = await cache.openOrGenerate('k-a', 'a.jpeg', async (p) => fs.writeFile(p, 'aaaaaaaaaa')); // 10B
      // Keep handle `a` open while it gets evicted to prove POSIX open-fd safety.
      const b = await cache.openOrGenerate('k-b', 'b.jpeg', async (p) => fs.writeFile(p, 'bbbbbbbbbb')); // 10B
      await b.handle.close();

      // Touch k-b so k-a remains the least recently used entry, then insert k-c.
      const bHit = await cache.openOrGenerate('k-b', 'b.jpeg', vi.fn());
      await bHit.handle.close();

      const c = await cache.openOrGenerate('k-c', 'c.jpeg', async (p) => fs.writeFile(p, 'cccccccccc')); // 10B
      await c.handle.close();

      expect(cache.getStats()).toEqual({ entries: 2, totalBytes: 20, inFlight: 0 });
      await expect(fs.access(join(cacheDir, 'a.jpeg'))).rejects.toThrow();

      // Even though a.jpeg was unlinked, the already-opened handle must still stream completely.
      const aText = await readStreamText(a.handle.createReadStream({ autoClose: true }));
      expect(aText).toBe('aaaaaaaaaa');
    });

    it('expires cached entries after ttlMs and regenerates them', async () => {
      let currentTime = 1_000_000;
      const cache = new OnDemandFullsizeCache({ cacheDir, ttlMs: 5000, now: () => currentTime });
      let version = 0;

      const first = await cache.openOrGenerate('ttl-key', 'ttl.jpeg', async (p) => {
        version += 1;
        await fs.writeFile(p, `v${version}`);
      });
      const firstText = await readStreamText(first.handle.createReadStream({ autoClose: true }));
      expect(firstText).toBe('v1');

      currentTime += 6000;

      const second = await cache.openOrGenerate('ttl-key', 'ttl.jpeg', async (p) => {
        version += 1;
        await fs.writeFile(p, `v${version}`);
      });
      const secondText = await readStreamText(second.handle.createReadStream({ autoClose: true }));
      expect(secondText).toBe('v2');
      expect(version).toBe(2);
    });

    it('recovers when a cached file is deleted externally and cleans up temp files on failure', async () => {
      const cache = new OnDemandFullsizeCache({ cacheDir });
      const first = await cache.openOrGenerate('ext-key', 'ext.jpeg', async (p) => fs.writeFile(p, 'first'));
      await first.handle.close();

      // Simulate external /tmp cleanup.
      await fs.unlink(join(cacheDir, 'ext.jpeg'));

      const second = await cache.openOrGenerate('ext-key', 'ext.jpeg', async (p) => fs.writeFile(p, 'regenerated'));
      const secondText = await readStreamText(second.handle.createReadStream({ autoClose: true }));
      expect(secondText).toBe('regenerated');

      // Failed generation must remove temp file and allow retries.
      await expect(
        cache.openOrGenerate('fail-key', 'fail.jpeg', async (p) => {
          await fs.writeFile(p, 'partial');
          throw new Error('decode error');
        }),
      ).rejects.toThrow('decode error');

      const files = await fs.readdir(cacheDir);
      expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(cache.getStats().inFlight).toBe(0);
    });

    it('cleans leftover cache files on startup initialization', async () => {
      await fs.writeFile(join(cacheDir, 'stale-from-previous-run.jpeg'), 'stale');
      const cache = new OnDemandFullsizeCache({ cacheDir });

      const result = await cache.openOrGenerate('fresh', 'fresh.jpeg', async (p) => fs.writeFile(p, 'fresh'));
      await result.handle.close();

      const files = await fs.readdir(cacheDir);
      expect(files).toEqual(['fresh.jpeg']);
    });
  });

  describe('generateOnDemandFullsizeResponse', () => {
    it('generates fullsize JPEG for a HEIC image, caches by assetId + fileModifiedAt + quality, and serves as stream', async () => {
      const deps = createDeps();
      const cache = new OnDemandFullsizeCache({ cacheDir });
      (deps.galleryAssetRepository.getForOnDemandFullsize as any).mockResolvedValue({
        id: 'asset-heic',
        type: AssetType.Image,
        originalPath: '/data/library/photo.heic',
        originalFileName: 'photo.heic',
        fileModifiedAt: new Date('2026-10-30T10:00:00.000Z'),
        orientation: '1',
        colorspace: 'sRGB',
        profileDescription: null,
        bitsPerSample: 8,
        projectionType: null,
        edits: [],
      });

      const response1 = await generateOnDemandFullsizeResponse(deps, cache, {
        assetId: 'asset-heic',
        edited: true,
        fileNameBase: 'photo',
      });
      expect(response1).toBeInstanceOf(ImmichStreamResponse);
      expect(response1?.contentType).toBe('image/jpeg');
      expect(response1?.cacheControl).toBe(CacheControl.PrivateWithCache);
      expect(response1?.fileName).toBe('photo_fullsize.jpeg');
      expect(response1?.length).toBe(14);
      const firstBody = await readStreamText(response1!.stream);
      expect(firstBody).toBe('generated-jpeg');

      // Second request hits cache without decoding again.
      const response2 = await generateOnDemandFullsizeResponse(deps, cache, {
        assetId: 'asset-heic',
        edited: true,
        fileNameBase: 'photo',
      });
      const secondBody = await readStreamText(response2!.stream);
      expect(secondBody).toBe('generated-jpeg');
      expect(deps.mediaRepository.decodeImage).toHaveBeenCalledTimes(1);
      expect(deps.mediaRepository.generateThumbnail).toHaveBeenCalledTimes(1);
      expect(deps.mediaRepository.generateThumbnail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          format: ImageFormat.Jpeg,
          quality: 80,
          colorspace: Colorspace.Srgb,
          progressive: false,
          decodingTier: 0,
        }),
        expect.any(String),
      );
    });

    it('regenerates when fullsize quality config or fileModifiedAt changes', async () => {
      const deps = createDeps();
      const cache = new OnDemandFullsizeCache({ cacheDir });
      const baseAsset = {
        id: 'asset-heic',
        type: AssetType.Image,
        originalPath: '/data/library/photo.heic',
        originalFileName: 'photo.heic',
        fileModifiedAt: new Date('2026-10-30T10:00:00.000Z'),
        orientation: null,
        colorspace: null,
        profileDescription: null,
        bitsPerSample: 8,
        projectionType: null,
        edits: [],
      };
      (deps.galleryAssetRepository.getForOnDemandFullsize as any).mockResolvedValue(baseAsset);

      const r1 = await generateOnDemandFullsizeResponse(deps, cache, {
        assetId: 'asset-heic',
        edited: true,
        fileNameBase: 'photo',
      });
      r1?.stream.destroy();

      // Change quality to 70 -> cache miss & regenerate with quality 70.
      (deps.getConfig as any).mockResolvedValue({
        image: {
          colorspace: Colorspace.P3,
          extractEmbedded: false,
          preview: { size: 1440 },
          fullsize: { enabled: false, format: ImageFormat.Jpeg, quality: 70, progressive: false },
        },
      });
      const r2 = await generateOnDemandFullsizeResponse(deps, cache, {
        assetId: 'asset-heic',
        edited: true,
        fileNameBase: 'photo',
      });
      r2?.stream.destroy();

      // Change fileModifiedAt -> cache miss & regenerate.
      (deps.galleryAssetRepository.getForOnDemandFullsize as any).mockResolvedValue({
        ...baseAsset,
        fileModifiedAt: new Date('2026-11-01T10:00:00.000Z'),
      });
      const r3 = await generateOnDemandFullsizeResponse(deps, cache, {
        assetId: 'asset-heic',
        edited: true,
        fileNameBase: 'photo',
      });
      r3?.stream.destroy();

      expect(deps.mediaRepository.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(deps.mediaRepository.generateThumbnail).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ quality: 70 }),
        expect.any(String),
      );
    });

    it('uses embedded JPEG for RAW assets when extractEmbedded is enabled and format is JPEG', async () => {
      const deps = createDeps();
      const cache = new OnDemandFullsizeCache({ cacheDir });
      (deps.getConfig as any).mockResolvedValue({
        image: {
          colorspace: Colorspace.P3,
          extractEmbedded: true,
          preview: { size: 1440 },
          fullsize: { enabled: false, format: ImageFormat.Jpeg, quality: 80, progressive: false },
        },
      });
      (deps.galleryAssetRepository.getForOnDemandFullsize as any).mockResolvedValue({
        id: 'asset-raw',
        type: AssetType.Image,
        originalPath: '/data/library/IMG_001.arw',
        originalFileName: 'IMG_001.arw',
        fileModifiedAt: new Date('2026-10-30T10:00:00.000Z'),
        orientation: '6',
        colorspace: 'sRGB',
        profileDescription: null,
        bitsPerSample: 14,
        projectionType: null,
        edits: [],
      });
      (deps.mediaRepository.extract as any).mockResolvedValue({
        buffer: Buffer.from('embedded-jpg-data'),
        format: RawExtractedFormat.Jpeg,
      });
      (deps.mediaRepository.getImageMetadata as any).mockResolvedValue({
        width: 4000,
        height: 3000,
        isTransparent: false,
      });

      const response = await generateOnDemandFullsizeResponse(deps, cache, {
        assetId: 'asset-raw',
        edited: false,
        fileNameBase: 'IMG_001',
      });

      const body = await readStreamText(response!.stream);
      expect(body).toBe('embedded-jpg-data');
      expect(deps.mediaRepository.writeExif).toHaveBeenCalledWith(
        { orientation: '6', colorspace: 'sRGB' },
        expect.any(String),
      );
      expect(deps.mediaRepository.decodeImage).not.toHaveBeenCalled();
    });

    it('returns null for videos, gifs, missing assets, or generation errors', async () => {
      const deps = createDeps();
      const cache = new OnDemandFullsizeCache({ cacheDir });

      // Missing asset
      (deps.galleryAssetRepository.getForOnDemandFullsize as any).mockResolvedValue(undefined);
      await expect(
        generateOnDemandFullsizeResponse(deps, cache, { assetId: 'missing', edited: true, fileNameBase: 'x' }),
      ).resolves.toBeNull();

      // Video asset
      (deps.galleryAssetRepository.getForOnDemandFullsize as any).mockResolvedValue({
        id: 'vid-1',
        type: AssetType.Video,
        originalPath: '/data/library/clip.mov',
        originalFileName: 'clip.mov',
        fileModifiedAt: new Date(),
        orientation: null,
        colorspace: null,
        profileDescription: null,
        bitsPerSample: null,
        projectionType: null,
        edits: [],
      });
      await expect(
        generateOnDemandFullsizeResponse(deps, cache, { assetId: 'vid-1', edited: true, fileNameBase: 'clip' }),
      ).resolves.toBeNull();

      // Decode failure logs warning and returns null
      (deps.galleryAssetRepository.getForOnDemandFullsize as any).mockResolvedValue({
        id: 'broken-heic',
        type: AssetType.Image,
        originalPath: '/data/library/broken.heic',
        originalFileName: 'broken.heic',
        fileModifiedAt: new Date(),
        orientation: null,
        colorspace: null,
        profileDescription: null,
        bitsPerSample: 8,
        projectionType: null,
        edits: [],
      });
      (deps.mediaRepository.decodeImage as any).mockRejectedValue(new Error('corrupt file'));
      await expect(
        generateOnDemandFullsizeResponse(deps, cache, {
          assetId: 'broken-heic',
          edited: true,
          fileNameBase: 'broken',
        }),
      ).resolves.toBeNull();
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('broken-heic'));
    });
  });
});
