import { exiftool } from 'exiftool-vendored';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { AssetEditAction, AssetEditSaveMode, AssetEditSaveStatus } from 'src/dtos/editing.dto.js';
import { JobStatus } from 'src/enum.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';
import { AssetEditSaveRow, AssetEditSaveSource } from 'src/repositories/asset-edit-save.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { AssetEditSaveService } from 'src/services/asset-edit-save.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { AssetExifFactory } from 'test/factories/asset-exif.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { factory } from 'test/small.factory.js';
import { automock, newTestService } from 'test/utils.js';

const widthOf = async (input: string | Buffer) => {
  const metadata = await sharp(input).metadata();
  return metadata.width;
};
const modificationTime = async (path: string) => {
  const metadata = await stat(path);
  return metadata.mtime;
};
const hasSaveTemps = async (path: string) => {
  const entries = await readdir(path);
  return entries.some((name) => name.includes('gallery-save-'));
};

describe('image save worker on real files', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gallery-save-worker-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await exiftool.end();
  });

  const setup = async (mode: AssetEditSaveMode) => {
    const originalPath = join(directory, 'source.png');
    await sharp({ create: { width: 8, height: 6, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .png()
      .toFile(originalPath);
    const before = await stat(originalPath);
    const asset = AssetFactory.create({
      originalPath,
      originalFileName: 'source.png',
      fileModifiedAt: before.mtime,
      fileCreatedAt: new Date('2024-01-02T03:04:05Z'),
      width: 8,
      height: 6,
    });
    const exif = AssetExifFactory.create({
      assetId: asset.id,
      exifImageWidth: 8,
      exifImageHeight: 6,
      orientation: '1',
      dateTimeOriginal: asset.fileCreatedAt,
      timeZone: 'UTC',
    });
    const source: AssetEditSaveSource = { asset, exif };
    const operation: AssetEditSaveRow = {
      id: factory.uuid(),
      ownerId: asset.ownerId,
      assetId: asset.id,
      idempotencyKey: factory.uuid(),
      expectedVersion: asset.updatedAt,
      mode,
      status: AssetEditSaveStatus.Queued,
      edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 4, height: 6 } }],
      resultAssetId: null,
      error: null,
      journal: null,
      createdAt: new Date(),
    };
    const media = new MediaRepository(automock(LoggingRepository, { strict: false }));
    const { sut, mocks } = newTestService(AssetEditSaveService, {
      crypto: new CryptoRepository(),
      media,
    });
    vi.spyOn(sut as unknown as { getConfig: () => Promise<SystemConfig> }, 'getConfig').mockResolvedValue(defaults);
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(join(directory, 'managed'));
    vi.spyOn(StorageService, 'getWriteBackend').mockReturnValue(new DiskStorageBackend(join(directory, 'managed')));
    mocks.assetEditSave.get.mockImplementation(() => Promise.resolve(operation));
    mocks.assetEditSave.getSource.mockResolvedValue(source);
    mocks.assetEditSave.update.mockImplementation((_id, values) => Promise.resolve(Object.assign(operation, values)));
    mocks.assetEditSave.commit.mockImplementation((_op, _source, output) => {
      operation.resultAssetId = operation.journal!.resultAssetId;
      operation.status = AssetEditSaveStatus.Processing;
      Object.assign(asset, { width: output.width, height: output.height, fileModifiedAt: output.modifiedAt });
      return Promise.resolve();
    });
    mocks.asset.getForCopy.mockResolvedValue({
      id: asset.id,
      originalPath,
      isFavorite: false,
      stackId: null,
      files: [],
    });
    mocks.asset.getByIdsWithAllRelationsButStacks.mockResolvedValue([]);
    mocks.job.queueAll.mockResolvedValue();
    return { sut, mocks, source, operation, before, media };
  };

  it('writes an independent copy without changing the source bytes or modification time', async () => {
    const { sut, mocks, source, operation, before } = await setup(AssetEditSaveMode.Copy);
    const originalBytes = await readFile(source.asset.originalPath);
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Success);
    expect(operation.status).toBe(AssetEditSaveStatus.Completed);
    const output = mocks.assetEditSave.commit.mock.calls[0][2];
    expect(output.path).not.toBe(source.asset.originalPath);
    expect(await widthOf(output.path)).toBe(4);
    expect(await readFile(source.asset.originalPath)).toEqual(originalBytes);
    expect(await modificationTime(source.asset.originalPath)).toEqual(before.mtime);
    expect(operation.journal).toBeNull();
  });

  it('replaces the actual original path and cleans backup files after commit', async () => {
    const { sut, source, operation } = await setup(AssetEditSaveMode.Overwrite);
    const originalHash = createHash('sha256')
      .update(await readFile(source.asset.originalPath))
      .digest('hex');
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Success);
    expect(operation.resultAssetId).toBe(source.asset.id);
    expect(await widthOf(source.asset.originalPath)).toBe(4);
    expect(
      createHash('sha256')
        .update(await readFile(source.asset.originalPath))
        .digest('hex'),
    ).not.toBe(originalHash);
    expect(await hasSaveTemps(directory)).toBe(false);
  });

  it('restores original bytes, dimensions, permissions, and mtime if the database commit fails', async () => {
    const { sut, mocks, source, operation, before } = await setup(AssetEditSaveMode.Overwrite);
    const originalBytes = await readFile(source.asset.originalPath);
    mocks.assetEditSave.commit.mockRejectedValue(new Error('Injected database failure'));
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Failed);
    expect(operation.status).toBe(AssetEditSaveStatus.Failed);
    expect(await readFile(source.asset.originalPath)).toEqual(originalBytes);
    const restored = await stat(source.asset.originalPath);
    expect(restored.mtime).toEqual(before.mtime);
    expect(restored.mode).toBe(before.mode);
    expect(await widthOf(source.asset.originalPath)).toBe(8);
    expect(await hasSaveTemps(directory)).toBe(false);
  });

  it('retries committed post-processing without applying the crop twice', async () => {
    const { sut, mocks, source, operation } = await setup(AssetEditSaveMode.Overwrite);
    mocks.job.queueAll.mockRejectedValueOnce(new Error('Injected queue outage')).mockResolvedValue();
    await expect(sut.handleSave({ id: operation.id })).rejects.toThrow('Injected queue outage');
    expect(operation.status).toBe(AssetEditSaveStatus.Processing);
    expect(await widthOf(source.asset.originalPath)).toBe(4);
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Success);
    expect(mocks.assetEditSave.commit).toHaveBeenCalledTimes(1);
    expect(await widthOf(source.asset.originalPath)).toBe(4);
  });

  it('replaces and restores an S3 original using its backend even when the write default is disk', async () => {
    const { sut, mocks, source, operation } = await setup(AssetEditSaveMode.Overwrite);
    const bytes = await readFile(source.asset.originalPath);
    const key = 'upload/existing/source.png';
    source.asset.originalPath = key;
    const objects = new Map<string, Buffer>([[key, bytes]]);
    const backend = {
      get: vi.fn((path: string) =>
        Promise.resolve({ stream: Readable.from(objects.get(path)!), contentType: 'image/png' }),
      ),
      put: vi.fn(async (path: string, stream: Readable) => {
        const parts: Buffer[] = [];
        for await (const part of stream) {
          parts.push(Buffer.from(part));
        }
        objects.set(path, Buffer.concat(parts));
      }),
      exists: vi.fn((path: string) => Promise.resolve(objects.has(path))),
      delete: vi.fn((path: string) => {
        objects.delete(path);
        return Promise.resolve();
      }),
      downloadToTemp: vi.fn(async (path: string) => {
        const tempPath = join(directory, `${factory.uuid()}.png`);
        await writeFile(tempPath, objects.get(path)!);
        return {
          tempPath,
          cleanup: async () => {
            await rm(tempPath, { force: true });
          },
        };
      }),
    } as unknown as StorageBackend;
    vi.spyOn(StorageService, 'resolveBackendForKey').mockReturnValue(backend);
    mocks.assetEditSave.commit.mockRejectedValueOnce(new Error('Injected DB outage'));
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Failed);
    expect(objects.get(key)).toEqual(bytes);
    expect(objects.keys().toArray()).toEqual([key]);
    operation.status = AssetEditSaveStatus.Queued;
    operation.journal = null;
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Success);
    expect(await widthOf(objects.get(key)!)).toBe(4);
    expect(objects.keys().toArray()).toEqual([key]);
    expect(mocks.assetEditSave.commit.mock.calls[1][2].path).toBe(key);
  });

  it('rejects an external modification during rendering without replacing that new version', async () => {
    const { sut, mocks, source, operation, media } = await setup(AssetEditSaveMode.Overwrite);
    const changed = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const render = media.renderSavedImage.bind(media);
    vi.spyOn(media, 'renderSavedImage').mockImplementation(async (...args) => {
      const result = await render(...args);
      await writeFile(source.asset.originalPath, changed);
      return result;
    });
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Failed);
    expect(operation.status).toBe(AssetEditSaveStatus.Conflict);
    expect(await readFile(source.asset.originalPath)).toEqual(changed);
    expect(mocks.assetEditSave.commit).not.toHaveBeenCalled();
  });

  it('reports full storage without changing the original', async () => {
    const { sut, source, operation, media } = await setup(AssetEditSaveMode.Overwrite);
    const original = await readFile(source.asset.originalPath);
    vi.spyOn(media, 'renderSavedImage').mockRejectedValue(
      Object.assign(new Error('Injected disk full'), { code: 'ENOSPC' }),
    );
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Failed);
    expect(operation.error).toBe('storage_full');
    expect(await readFile(source.asset.originalPath)).toEqual(original);
  });

  it('journals every derivative before writing it and cleans a partial preview failure', async () => {
    const { sut, source, operation, media } = await setup(AssetEditSaveMode.Copy);
    const original = await readFile(source.asset.originalPath);
    const generate = media.generateThumbnail.bind(media);
    let calls = 0;
    vi.spyOn(media, 'generateThumbnail').mockImplementation(async (...args) => {
      expect(operation.journal?.newFiles).toHaveLength(2);
      if (++calls === 2) {
        throw new Error('Injected preview failure');
      }
      await generate(...args);
    });
    expect(await sut.handleSave({ id: operation.id })).toBe(JobStatus.Failed);
    expect(await readFile(source.asset.originalPath)).toEqual(original);
    const files = await readdir(join(directory, 'managed'), { recursive: true });
    expect(files.some((file) => file.includes('_save-'))).toBe(false);
  });
});
