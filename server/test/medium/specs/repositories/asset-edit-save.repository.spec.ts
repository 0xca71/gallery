import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import {
  AssetEditAction,
  AssetEditSaveCreateDto,
  AssetEditSaveMode,
  AssetEditSaveStatus,
} from 'src/dtos/editing.dto.js';
import { AlbumUserRole, AssetFileType, ChecksumAlgorithm, SourceType } from 'src/enum.js';
import { AssetEditSaveRepository, AssetEditSaveSource } from 'src/gallery/repositories/asset-edit-save.repository.js';
import { ImageAdjustRepository } from 'src/gallery/repositories/image-adjust.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newEmbedding } from 'test/small.factory.js';
import { automock, getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB('image_save_18');
});
afterAll(async () => {
  await database.destroy();
});

const setup = async (external = false) => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const library = external ? await ctx.newLibrary({ ownerId: user.id }) : null;
  const capture = new Date('2024-03-04T05:06:07.123Z');
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    libraryId: library?.library.id ?? null,
    isExternal: external,
    checksumAlgorithm: external ? ChecksumAlgorithm.sha1Path : ChecksumAlgorithm.sha1File,
    originalPath: '/test/photo.jpg',
    originalFileName: 'photo.jpg',
    fileCreatedAt: capture,
    localDateTime: capture,
  });
  await ctx.newExif({
    assetId: asset.id,
    exifImageWidth: 100,
    exifImageHeight: 80,
    orientation: '1',
    fileSizeInByte: 500,
    dateTimeOriginal: capture,
    timeZone: 'Asia/Shanghai',
  });
  const sut = ctx.get(AssetEditSaveRepository);
  const source = (await sut.getSource(asset.id))!;
  return { ctx, sut, source, user };
};

const operationFor = async (
  sut: AssetEditSaveRepository,
  source: AssetEditSaveSource,
  mode: AssetEditSaveMode,
  adjust?: AssetEditSaveCreateDto['adjust'],
) => {
  const operation = await sut.create(source.asset.ownerId, source.asset.id, {
    mode,
    expectedVersion: source.asset.updatedAt,
    idempotencyKey: factory.uuid(),
    edits: [{ action: AssetEditAction.Crop, parameters: { x: 10, y: 10, width: 40, height: 40 } }],
    adjust,
  });
  const resultAssetId = mode === AssetEditSaveMode.Copy ? factory.uuid() : source.asset.id;
  return sut.update(operation.id, {
    status: AssetEditSaveStatus.Publishing,
    journal: {
      originalPath: source.asset.originalPath,
      publishPath: '/test/saved.jpg',
      stagePath: '/test/save.tmp',
      backupPath: '/test/save.bak',
      originalDigest: 'old',
      outputDigest: 'new',
      resultAssetId,
      newFiles: [],
      oldFiles: [],
    },
  });
};

const outputFor = (source: AssetEditSaveSource, resultAssetId: string) => ({
  path: source.asset.originalPath,
  filename: 'photo-edited.jpg',
  checksum: createHash('sha1').update(resultAssetId).digest(),
  size: 200,
  width: 40,
  height: 40,
  modifiedAt: new Date(),
  thumbhash: Buffer.from('thumbnail'),
  files: [
    {
      assetId: resultAssetId,
      type: AssetFileType.Preview,
      path: `/test/${resultAssetId}.preview.jpg`,
      isEdited: false,
    },
  ],
});

describe('persistent image saves', () => {
  it('creates an independent copy with capture metadata and permitted album/tag associations', async () => {
    const { ctx, sut, source, user } = await setup();
    const albumId = factory.uuid();
    await database.insertInto('album').values({ id: albumId }).execute();
    await database.insertInto('album_user').values({ albumId, userId: user.id, role: AlbumUserRole.Owner }).execute();
    await database.insertInto('album_asset').values({ albumId, assetId: source.asset.id }).execute();
    const tagId = factory.uuid();
    await database.insertInto('tag').values({ id: tagId, userId: user.id, value: 'kept' }).execute();
    await database.insertInto('tag_asset').values({ tagId, assetId: source.asset.id }).execute();
    await ctx
      .get(AssetEditRepository)
      .replaceAll(source.asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }]);
    const fresh = (await sut.getSource(source.asset.id))!;
    const operation = await operationFor(sut, fresh, AssetEditSaveMode.Copy);
    const resultId = operation.journal!.resultAssetId;
    await database.updateTable('user').set({ quotaUsageInBytes: 500 }).where('id', '=', user.id).execute();
    await sut.commit(operation, fresh, { ...outputFor(fresh, resultId), path: '/test/new-photo.jpg' });
    const saved = (await sut.getSource(resultId))!;
    expect(saved.asset.fileCreatedAt).toEqual(source.asset.fileCreatedAt);
    expect(saved.asset.localDateTime).toEqual(source.asset.localDateTime);
    expect(saved.exif.timeZone).toBe(source.exif.timeZone);
    expect(saved.asset.isEdited).toBe(false);
    expect(saved.asset.originalPath).toBe('/test/new-photo.jpg');
    expect(saved.asset.stackId).toBeNull();
    const owner = await database
      .selectFrom('user')
      .select('quotaUsageInBytes')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(Number(owner.quotaUsageInBytes)).toBe(700);
    expect(await ctx.get(AssetEditRepository).getAll(source.asset.id)).toHaveLength(1);
    expect((await sut.getSource(source.asset.id))!.asset.checksum).toEqual(source.asset.checksum);
    expect(await database.selectFrom('album_asset').selectAll().where('assetId', '=', resultId).execute()).toHaveLength(
      1,
    );
    expect(await database.selectFrom('tag_asset').selectAll().where('assetId', '=', resultId).execute()).toHaveLength(
      1,
    );
  });

  it('keeps external identity and path checksum, clears baked edits, and maps confirmed faces', async () => {
    const { ctx, sut, source } = await setup(true);
    const { person } = await ctx.newPerson({ ownerId: source.asset.ownerId, name: 'Confirmed person' });
    const visible = await ctx.newAssetFace({
      assetId: source.asset.id,
      sourceType: SourceType.Manual,
      personGroupId: person.personGroupId,
      imageWidth: 100,
      imageHeight: 80,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 30,
      boundingBoxY2: 30,
    });
    await ctx.newAssetFace({
      assetId: source.asset.id,
      imageWidth: 100,
      imageHeight: 80,
      boundingBoxX1: 70,
      boundingBoxY1: 10,
      boundingBoxX2: 90,
      boundingBoxY2: 30,
    });
    await ctx
      .get(AssetEditRepository)
      .replaceAll(source.asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }]);
    const fresh = (await sut.getSource(source.asset.id))!;
    const operation = await operationFor(sut, fresh, AssetEditSaveMode.Overwrite);
    await sut.commit(operation, fresh, outputFor(fresh, fresh.asset.id));
    const saved = (await sut.getSource(fresh.asset.id))!;
    expect(saved.asset.libraryId).toBe(source.asset.libraryId);
    expect(saved.asset.isExternal).toBe(true);
    expect(saved.asset.originalPath).toBe(source.asset.originalPath);
    expect(saved.asset.checksumAlgorithm).toBe(ChecksumAlgorithm.sha1Path);
    expect(saved.asset.checksum).toEqual(source.asset.checksum);
    expect(saved.asset.fileCreatedAt).toEqual(source.asset.fileCreatedAt);
    expect(saved.asset.isEdited).toBe(false);
    const faces = await database.selectFrom('asset_face').selectAll().where('assetId', '=', source.asset.id).execute();
    expect(faces).toHaveLength(1);
    expect(faces[0].id).toBe(visible.assetFace.id);
    expect(faces[0].sourceType).toBe(SourceType.Manual);
    expect(faces[0].personGroupId).toBe(person.personGroupId);
    expect(faces[0].imageWidth).toBe(40);
    expect(faces[0].boundingBoxX1).toBe(0);
  });

  it('persists Adjust snapshots, clears baked adjustments and all pixel-derived sidecars in the correct ledgers', async () => {
    const { ctx, sut, source } = await setup();
    const adjust = { exposure: 20, contrast: -5, saturation: 10, invert: true };
    await ctx.get(ImageAdjustRepository).upsert(source.asset.id, adjust);
    const human = await ctx.newAssetFace({
      assetId: source.asset.id,
      sourceType: SourceType.Manual,
      imageWidth: 100,
      imageHeight: 80,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 30,
      boundingBoxY2: 30,
    });
    const pet = await ctx.newAssetFace({
      assetId: source.asset.id,
      imageWidth: 100,
      imageHeight: 80,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 30,
      boundingBoxY2: 30,
    });
    await database
      .insertInto('face_search')
      .values({ faceId: human.assetFace.id, embedding: newEmbedding() })
      .execute();
    await database
      .insertInto('pet_search')
      .values({ faceId: pet.assetFace.id, embedding: newEmbedding(), species: 'cat' })
      .execute();
    await database
      .insertInto('asset_spatial_scene')
      .values({
        assetId: source.asset.id,
        path: '/test/old-depth.webp',
        width: 100,
        height: 80,
        boundarySharpness: 0.2,
        edgeDensity: 0.2,
        foregroundRatio: 0.5,
        focus: 0.5,
        modelName: 'old-depth-model',
      })
      .execute();
    await database
      .insertInto('asset_job_status_gallery')
      .values({
        assetId: source.asset.id,
        petsDetectedAt: new Date(),
        classifiedAt: new Date(),
        qualityAnalyzedAt: new Date(),
      })
      .execute();
    const autoTag = factory.uuid();
    const manualTag = factory.uuid();
    await database
      .insertInto('tag')
      .values([
        { id: autoTag, userId: source.asset.ownerId, value: 'Auto/obsolete' },
        { id: manualTag, userId: source.asset.ownerId, value: 'manual-kept' },
      ])
      .execute();
    await database
      .insertInto('tag_asset')
      .values([
        { assetId: source.asset.id, tagId: autoTag },
        { assetId: source.asset.id, tagId: manualTag },
      ])
      .execute();
    const fresh = (await sut.getSource(source.asset.id))!;
    const operation = await operationFor(sut, fresh, AssetEditSaveMode.Overwrite, adjust);
    expect(operation.adjust).toEqual(adjust);
    expect(await sut.isPathSaving(operation.journal!.publishPath)).toBe(true);
    await sut.commit(operation, fresh, outputFor(fresh, fresh.asset.id));
    expect(await ctx.get(ImageAdjustRepository).get(fresh.asset.id)).toBeUndefined();
    expect((await sut.getSource(fresh.asset.id))!.asset.isEdited).toBe(false);
    expect(
      await database.selectFrom('face_search').selectAll().where('faceId', '=', human.assetFace.id).execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom('pet_search').selectAll().where('faceId', '=', pet.assetFace.id).execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom('asset_face').select('id').where('assetId', '=', fresh.asset.id).execute(),
    ).toEqual([{ id: human.assetFace.id }]);
    expect(
      await database.selectFrom('asset_spatial_scene').selectAll().where('assetId', '=', fresh.asset.id).execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom('tag_asset').select('tagId').where('assetId', '=', fresh.asset.id).execute(),
    ).toEqual([{ tagId: manualTag }]);
    const stamps = await database
      .selectFrom('asset_job_status_gallery')
      .selectAll()
      .where('assetId', '=', fresh.asset.id)
      .executeTakeFirstOrThrow();
    expect(stamps.petsDetectedAt).toBeNull();
    expect(stamps.classifiedAt).toBeNull();
    expect(stamps.qualityAnalyzedAt).toBeNull();
    expect(await sut.hasResult(fresh.asset.id)).toBe(true);
  });

  it('updates an external path checksum when native conversion changes the filename', async () => {
    const { sut, source } = await setup(true);
    const operation = await operationFor(sut, source, AssetEditSaveMode.Overwrite);
    await sut.commit(operation, source, {
      ...outputFor(source, source.asset.id),
      path: '/test/photo-converted.png',
      filename: 'photo-converted.png',
    });
    const saved = (await sut.getSource(source.asset.id))!;
    expect(saved.asset.libraryId).toBe(source.asset.libraryId);
    expect(saved.asset.checksumAlgorithm).toBe(ChecksumAlgorithm.sha1Path);
    expect(saved.asset.checksum).toEqual(createHash('sha1').update('path:/test/photo-converted.png').digest());
  });

  it('rejects concurrent metadata changes without committing image metadata', async () => {
    const { sut, source } = await setup();
    const operation = await operationFor(sut, source, AssetEditSaveMode.Overwrite);
    await database
      .updateTable('asset_exif')
      .set({ description: 'A concurrent update' })
      .where('assetId', '=', source.asset.id)
      .execute();
    await expect(sut.commit(operation, source, outputFor(source, source.asset.id))).rejects.toThrow(
      'Source metadata changed',
    );
    expect((await sut.getSource(source.asset.id))!.exif.exifImageWidth).toBe(100);
    expect((await sut.get(operation.id))!.status).toBe(AssetEditSaveStatus.Publishing);
  });

  it('enforces one in-flight save per asset and unique request keys', async () => {
    const { sut, source } = await setup();
    const first = await operationFor(sut, source, AssetEditSaveMode.Copy);
    expect(await sut.isSaving(source.asset.id)).toBe(true);
    expect(await sut.isPathSaving(source.asset.originalPath)).toBe(true);
    await expect(operationFor(sut, source, AssetEditSaveMode.Overwrite)).rejects.toThrow();
    expect((await sut.getByKey(source.asset.ownerId, first.idempotencyKey))!.id).toBe(first.id);
  });

  it('lets post-processing run after commit while reserving the source against another save', async () => {
    const { sut, source } = await setup();
    const op = await operationFor(sut, source, AssetEditSaveMode.Overwrite);
    await sut.update(op.id, { status: AssetEditSaveStatus.Processing });
    expect(await sut.isSaving(source.asset.id)).toBe(true);
    expect(await sut.isSaving(source.asset.id, false)).toBe(false);
  });

  it('serializes workers without consuming an application connection while waiting', async () => {
    const lock = new DatabaseRepository(
      database,
      automock(LoggingRepository, { strict: false }),
      automock(ConfigRepository, { strict: false }),
    );
    const id = factory.uuid();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = lock.withAssetLock(
      id,
      async () => {
        entered.resolve();
        await release.promise;
      },
      database,
    );
    await entered.promise;
    let secondEntered = false;
    const second = lock.withAssetLock(
      id,
      () => {
        secondEntered = true;
        return Promise.resolve();
      },
      database,
    );
    try {
      await expect(lock.withAssetLock(id, async () => {}, database, false)).rejects.toThrow('another worker');
      expect(secondEntered).toBe(false);
      // This SQL still runs while the file lock is held by a different connection.
      expect(await database.selectFrom('user').select('id').limit(1).execute()).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.all([first, second]);
    }
    expect(secondEntered).toBe(true);
    expect(await lock.withAssetLock(id, () => Promise.resolve('released'), database, false)).toBe('released');
  });
});
