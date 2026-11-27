import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetType, CacheControl, Colorspace, ImageFormat, RawExtractedFormat } from 'src/enum.js';
import type { ImageAdjust } from 'src/gallery/dtos/image-adjust.dto.js';
import type { GalleryAssetRepository } from 'src/gallery/repositories/gallery-asset.repository.js';
import type { ImageAdjustRepository } from 'src/gallery/repositories/image-adjust.repository.js';
import type { BackendMediaServer } from 'src/gallery/utils/backend-media-server.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { MediaRepository } from 'src/repositories/media.repository.js';
import type { GenerateThumbnailOptions } from 'src/types.js';
import { ImmichStreamResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';

export const DEFAULT_ON_DEMAND_FULLSIZE_CACHE_DIR = join(tmpdir(), 'gallery-on-demand-fullsize');
export const DEFAULT_ON_DEMAND_FULLSIZE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_ON_DEMAND_FULLSIZE_MAX_ENTRIES = 500;
export const DEFAULT_ON_DEMAND_FULLSIZE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FULLSIZE_QUALITY = 80;
const DEFAULT_PREVIEW_SIZE = 1440;

export interface OnDemandFullsizeCacheOptions {
  cacheDir?: string;
  maxBytes?: number;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface OnDemandFullsizeCacheKeyParams {
  assetId: string;
  fileModifiedAt?: Date | string | null;
  format: ImageFormat;
  quality: number;
  progressive: boolean;
  colorspace: Colorspace;
  extractEmbedded: boolean;
  useEdits: boolean;
  edits: AssetEditActionItem[];
  adjust?: ImageAdjust;
}

interface CacheEntry {
  key: string;
  filePath: string;
  size: number;
  createdAt: number;
}

export interface OnDemandFullsizeDependencies {
  galleryAssetRepository: GalleryAssetRepository;
  imageAdjustRepository: ImageAdjustRepository;
  mediaRepository: MediaRepository;
  backendMedia: BackendMediaServer;
  logger: LoggingRepository;
  getConfig: (options: { withCache: boolean }) => Promise<SystemConfig>;
}

export interface OnDemandFullsizeRequest {
  assetId: string;
  edited: boolean;
  fileNameBase: string;
}

function isSRGB({
  colorspace,
  profileDescription,
  bitsPerSample,
}: {
  colorspace: string | null;
  profileDescription: string | null;
  bitsPerSample: number | null;
}): boolean {
  if (colorspace || profileDescription) {
    return [colorspace, profileDescription].some((value) => value?.toLowerCase().includes('srgb'));
  }
  if (bitsPerSample) {
    return bitsPerSample === 8;
  }
  return true;
}

export function buildOnDemandFullsizeCacheKey(params: OnDemandFullsizeCacheKeyParams): string {
  const modifiedAt =
    params.fileModifiedAt instanceof Date ? params.fileModifiedAt.toISOString() : (params.fileModifiedAt ?? '');
  const editsSignature = params.useEdits ? JSON.stringify({ edits: params.edits, adjust: params.adjust ?? null }) : '';

  return [
    params.assetId,
    modifiedAt,
    params.format,
    String(params.quality),
    params.progressive ? '1' : '0',
    params.colorspace,
    params.extractEmbedded ? '1' : '0',
    editsSignature,
  ].join('|');
}

function buildCacheFileName(assetId: string, key: string, format: ImageFormat): string {
  const safeAssetId = assetId.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `${safeAssetId}_${digest}.${format}`;
}

export class OnDemandFullsizeCache {
  private readonly cacheDir: string;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CacheEntry>>();
  private readonly pinned = new Map<string, number>();
  private totalBytes = 0;
  private initPromise?: Promise<void>;

  constructor(options: OnDemandFullsizeCacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_ON_DEMAND_FULLSIZE_CACHE_DIR;
    this.maxBytes = options.maxBytes ?? DEFAULT_ON_DEMAND_FULLSIZE_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_ON_DEMAND_FULLSIZE_MAX_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_ON_DEMAND_FULLSIZE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async openOrGenerate(
    key: string,
    fileName: string,
    generate: (tempPath: string) => Promise<void>,
  ): Promise<{ handle: fs.FileHandle; size: number }> {
    await this.ensureInitialized();

    this.pin(key);
    try {
      const cached = await this.tryOpenCached(key);
      if (cached) {
        return cached;
      }

      const cachePath = join(this.cacheDir, fileName);
      let pending = this.inFlight.get(key);
      if (!pending) {
        pending = this.generateAndStore(key, cachePath, generate).finally(() => {
          this.inFlight.delete(key);
        });
        this.inFlight.set(key, pending);
      }

      const entry = await pending;
      return await this.openEntry(entry);
    } finally {
      this.unpin(key);
    }
  }

  async clear(): Promise<void> {
    const keys = this.entries.keys().toArray();
    for (const key of keys) {
      await this.evictKey(key);
    }
  }

  getStats() {
    return {
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      inFlight: this.inFlight.size,
    };
  }

  private pin(key: string): void {
    this.pinned.set(key, (this.pinned.get(key) ?? 0) + 1);
  }

  private unpin(key: string): void {
    const next = (this.pinned.get(key) ?? 1) - 1;
    if (next <= 0) {
      this.pinned.delete(key);
    } else {
      this.pinned.set(key, next);
    }
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeDir().catch((error) => {
        this.initPromise = undefined;
        throw error;
      });
    }
    return this.initPromise;
  }

  private async initializeDir(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    // Clear leftover temporary cache files from previous process runs.
    const existing = await fs.readdir(this.cacheDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      existing
        .filter((entry) => entry.isFile())
        .map((entry) => fs.unlink(join(this.cacheDir, entry.name)).catch(() => {})),
    );
  }

  private async tryOpenCached(key: string): Promise<{ handle: fs.FileHandle; size: number } | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      await this.evictKey(key);
      return null;
    }

    // Refresh LRU order (delete + set moves entry to the most-recently-used end).
    this.entries.delete(key);
    this.entries.set(key, entry);

    try {
      return await this.openEntry(entry);
    } catch {
      // Cache file was removed externally (e.g., OS /tmp cleanup); drop stale metadata and regenerate.
      await this.evictKey(key);
      return null;
    }
  }

  private async openEntry(entry: CacheEntry): Promise<{ handle: fs.FileHandle; size: number }> {
    const handle = await fs.open(entry.filePath, 'r');
    try {
      const stat = await handle.stat();
      return { handle, size: stat.size };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  private async generateAndStore(
    key: string,
    cachePath: string,
    generate: (tempPath: string) => Promise<void>,
  ): Promise<CacheEntry> {
    const tempPath = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await generate(tempPath);
      await fs.rename(tempPath, cachePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    const { size } = await fs.stat(cachePath);
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.size;
      this.entries.delete(key);
    }

    const entry: CacheEntry = {
      key,
      filePath: cachePath,
      size,
      createdAt: this.now(),
    };
    this.entries.set(key, entry);
    this.totalBytes += size;

    await this.evictIfNeeded();
    return entry;
  }

  private isExpired(entry: CacheEntry): boolean {
    return this.now() - entry.createdAt > this.ttlMs;
  }

  private async evictKey(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    this.totalBytes -= entry.size;
    await fs.unlink(entry.filePath).catch(() => {});
  }

  private async evictIfNeeded(): Promise<void> {
    const expiredKeys: string[] = [];
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry) && !this.pinned.has(key)) {
        expiredKeys.push(key);
      }
    }
    for (const key of expiredKeys) {
      await this.evictKey(key);
    }

    while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes)) {
      let oldestUnpinned: string | undefined;
      for (const key of this.entries.keys()) {
        if (!this.pinned.has(key)) {
          oldestUnpinned = key;
          break;
        }
      }
      if (!oldestUnpinned) {
        break;
      }
      await this.evictKey(oldestUnpinned);
    }
  }
}

export async function generateOnDemandFullsizeResponse(
  deps: OnDemandFullsizeDependencies,
  cache: OnDemandFullsizeCache,
  request: OnDemandFullsizeRequest,
): Promise<ImmichStreamResponse | null> {
  const { assetId, edited, fileNameBase } = request;
  const asset = await deps.galleryAssetRepository.getForOnDemandFullsize(assetId);
  if (!asset || asset.type !== AssetType.Image || asset.originalFileName.toLowerCase().endsWith('.gif')) {
    return null;
  }

  const config = await deps.getConfig({ withCache: true });
  const imageConfig = config?.image;
  const format = imageConfig?.fullsize?.format ?? ImageFormat.Jpeg;
  const quality = imageConfig?.fullsize?.quality ?? DEFAULT_FULLSIZE_QUALITY;
  const progressive = !!imageConfig?.fullsize?.progressive && format === ImageFormat.Jpeg;
  const extractEmbedded = !!imageConfig?.extractEmbedded;
  const previewSize = imageConfig?.preview?.size ?? DEFAULT_PREVIEW_SIZE;
  const colorspace = isSRGB(asset) ? Colorspace.Srgb : (imageConfig?.colorspace ?? Colorspace.P3);

  const edits = edited ? (asset.edits ?? []) : [];
  const adjust = edited ? await deps.imageAdjustRepository.getForRender(assetId) : undefined;
  const useEdits = edited && (edits.length > 0 || !!adjust);

  const key = buildOnDemandFullsizeCacheKey({
    assetId: asset.id,
    fileModifiedAt: asset.fileModifiedAt,
    format,
    quality,
    progressive,
    colorspace,
    extractEmbedded,
    useEdits,
    edits,
    adjust,
  });
  const cacheFileName = buildCacheFileName(asset.id, key, format);

  try {
    const { handle, size } = await cache.openOrGenerate(key, cacheFileName, async (tempPath) => {
      await using original = await deps.backendMedia.ensureLocalFile(asset.originalPath);
      const localOriginalPath = original.localPath;

      let extracted =
        extractEmbedded && mimeTypes.isRaw(asset.originalFileName)
          ? await deps.mediaRepository.extract(localOriginalPath)
          : null;
      if (extracted) {
        const { width, height } = await deps.mediaRepository.getImageMetadata(extracted.buffer);
        if (Math.min(width, height) < previewSize) {
          extracted = null;
        }
      }

      if (extracted && extracted.format === RawExtractedFormat.Jpeg && !useEdits && format === ImageFormat.Jpeg) {
        await fs.writeFile(tempPath, extracted.buffer);
        await deps.mediaRepository.writeExif(
          { orientation: asset.orientation, colorspace: asset.colorspace },
          tempPath,
        );
      } else {
        const thumbSource = extracted ? extracted.buffer : localOriginalPath;
        const decoded = await deps.mediaRepository.decodeImage(thumbSource, {
          colorspace,
          processInvalidImages: process.env.IMMICH_PROCESS_INVALID_IMAGES === 'true',
          orientation: extracted && asset.orientation ? Number(asset.orientation) : undefined,
        });

        const fullsizeOptions: GenerateThumbnailOptions = {
          colorspace,
          format,
          quality,
          progressive,
          processInvalidImages: false,
          decodingTier: 0,
          edits: useEdits ? edits : [],
          adjust: useEdits ? adjust : undefined,
        };
        await deps.mediaRepository.generateThumbnail(decoded, fullsizeOptions, tempPath);
      }

      if (asset.projectionType === 'EQUIRECTANGULAR') {
        await deps.mediaRepository.copyTagGroup('XMP-GPano', localOriginalPath, tempPath);
      }
    });

    const stream = handle.createReadStream({ autoClose: true });
    return new ImmichStreamResponse({
      stream,
      length: size,
      contentType: mimeTypes.lookup(`.${format}`),
      cacheControl: CacheControl.PrivateWithCache,
      fileName: `${fileNameBase}_${AssetFileType.FullSize}.${format}`,
    });
  } catch (error: Error | any) {
    deps.logger.warn(`Failed to generate on-demand fullsize for asset ${assetId}: ${error?.message ?? error}`);
    return null;
  }
}
