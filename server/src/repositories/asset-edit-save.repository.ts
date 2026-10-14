import { ConflictException, Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetEditSaveCreateDto, AssetEditSaveMode, AssetEditSaveStatus } from 'src/dtos/editing.dto.js';
import { AlbumUserRole, AssetFileType, AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AssetEditSaveTable } from 'src/schema/tables/asset-edit-save.table.js';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table.js';
import { AssetFileTable } from 'src/schema/tables/asset-file.table.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { transformSavedFace } from 'src/utils/asset-edit-save.js';
import { getDimensions } from 'src/utils/asset.util.js';

export type AssetEditSaveRow = Selectable<AssetEditSaveTable>;
export type AssetEditSaveSource = { asset: Selectable<AssetTable>; exif: Selectable<AssetExifTable> };
export type AssetEditSaveJournal = {
  originalPath: string;
  publishPath: string;
  stagePath: string;
  backupPath: string | null;
  originalDigest: string;
  outputDigest: string;
  resultAssetId: string;
  newFiles: Insertable<AssetFileTable>[];
  oldFiles: string[];
  publicationStarted?: boolean;
  originalStat?: { mode: number; uid: number; gid: number; mtime: string; atime: string };
  sidecar?: {
    path: string;
    stagePath: string;
    backupPath: string;
    originalDigest: string;
    outputDigest: string;
    originalStat?: AssetEditSaveJournal['originalStat'];
  };
};

const activeStatuses = [
  AssetEditSaveStatus.Queued,
  AssetEditSaveStatus.Rendering,
  AssetEditSaveStatus.Publishing,
  AssetEditSaveStatus.Processing,
];

@Injectable()
export class AssetEditSaveRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async getSource(assetId: string): Promise<AssetEditSaveSource | undefined> {
    const asset = await this.db.selectFrom('asset').selectAll().where('id', '=', assetId).executeTakeFirst();
    const exif = await this.db.selectFrom('asset_exif').selectAll().where('assetId', '=', assetId).executeTakeFirst();
    return asset && exif ? { asset, exif } : undefined;
  }

  get(id: string) {
    return this.db.selectFrom('asset_edit_save').selectAll().where('id', '=', id).executeTakeFirst();
  }

  getByKey(ownerId: string, key: string) {
    return this.db
      .selectFrom('asset_edit_save')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('idempotencyKey', '=', key)
      .executeTakeFirst();
  }

  create(ownerId: string, assetId: string, dto: AssetEditSaveCreateDto) {
    return this.db
      .insertInto('asset_edit_save')
      .values({ ownerId, assetId, ...dto, edits: dto.edits as AssetEditSaveTable['edits'] })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  update(id: string, values: Partial<Pick<AssetEditSaveRow, 'status' | 'resultAssetId' | 'journal' | 'error'>>) {
    return this.db
      .updateTable('asset_edit_save')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  getInFlight() {
    return this.db.selectFrom('asset_edit_save').selectAll().where('status', 'in', activeStatuses).execute();
  }

  async isSaving(assetId: string, includeProcessing = true) {
    return !!(await this.db
      .selectFrom('asset_edit_save')
      .select('id')
      .where('assetId', '=', assetId)
      .where(
        'status',
        'in',
        includeProcessing
          ? activeStatuses
          : activeStatuses.filter((status) => status !== AssetEditSaveStatus.Processing),
      )
      .executeTakeFirst());
  }

  async assertNotSaving(assetId: string) {
    if (await this.isSaving(assetId)) {
      throw new ConflictException('An image save is already in progress');
    }
  }

  async isPathSaving(path: string) {
    return !!(await this.db
      .selectFrom('asset_edit_save')
      .innerJoin('asset', 'asset.id', 'asset_edit_save.assetId')
      .select('asset_edit_save.id')
      .where('asset.originalPath', '=', path)
      .where('asset_edit_save.status', 'in', activeStatuses)
      .executeTakeFirst());
  }

  async getSavingAssetIds(ids: string[]) {
    if (ids.length === 0) {
      return new Set<string>();
    }
    const rows = await this.db
      .selectFrom('asset_edit_save')
      .select('assetId')
      .where('assetId', 'in', ids)
      .where('status', 'in', activeStatuses)
      .execute();
    return new Set(rows.map((row) => row.assetId));
  }

  async getActiveOriginalPaths() {
    const operations = await this.getInFlight();
    return new Set(
      operations.flatMap((operation) =>
        operation.journal ? [operation.journal.originalPath, operation.journal.publishPath] : [],
      ),
    );
  }

  async commit(
    operation: AssetEditSaveRow,
    source: AssetEditSaveSource,
    output: {
      path: string;
      filename: string;
      checksum: Buffer;
      size: number;
      width: number;
      height: number;
      modifiedAt: Date;
      thumbhash: Buffer;
      files: Insertable<AssetFileTable>[];
    },
  ): Promise<void> {
    const resultId = operation.journal!.resultAssetId;
    await this.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', operation.assetId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !current ||
        current.deletedAt ||
        current.isOffline ||
        current.updatedAt.getTime() !== operation.expectedVersion.getTime()
      ) {
        throw new ConflictException('The source asset changed while saving');
      }
      const currentExif = await trx
        .selectFrom('asset_exif')
        .select('updatedAt')
        .where('assetId', '=', current.id)
        .forUpdate()
        .executeTakeFirst();
      if (!currentExif || currentExif.updatedAt.getTime() !== source.exif.updatedAt.getTime()) {
        throw new ConflictException('Source metadata changed during rendering');
      }
      const owner = await trx
        .selectFrom('user')
        .select(['quotaSizeInBytes', 'quotaUsageInBytes'])
        .where('id', '=', current.ownerId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const usageDelta =
        operation.mode === AssetEditSaveMode.Copy
          ? output.size
          : current.isExternal
            ? 0
            : output.size - Number(source.exif.fileSizeInByte ?? 0);
      if (
        owner.quotaSizeInBytes !== null &&
        Number(owner.quotaUsageInBytes) + Math.max(0, usageDelta) > Number(owner.quotaSizeInBytes)
      ) {
        throw new ConflictException('Quota has been exceeded');
      }
      if (usageDelta !== 0) {
        await trx
          .updateTable('user')
          .set((eb) => ({
            quotaUsageInBytes: eb.fn<number>('greatest', [eb.val(0), eb('quotaUsageInBytes', '+', usageDelta)]),
          }))
          .where('id', '=', current.ownerId)
          .execute();
      }
      if (operation.mode === AssetEditSaveMode.Copy) {
        await trx
          .insertInto('asset')
          .values({
            id: resultId,
            ownerId: current.ownerId,
            libraryId: null,
            originalPath: output.path,
            originalFileName: output.filename,
            checksum: output.checksum,
            checksumAlgorithm: ChecksumAlgorithm.sha1File,
            type: AssetType.Image,
            fileCreatedAt: current.fileCreatedAt,
            localDateTime: current.localDateTime,
            fileModifiedAt: output.modifiedAt,
            isFavorite: current.isFavorite,
            visibility: current.visibility,
            width: output.width,
            height: output.height,
            thumbhash: output.thumbhash,
          })
          .execute();
        const { assetId: _assetId, updatedAt: _updatedAt, updateId: _updateId, ...exif } = source.exif;
        await trx
          .insertInto('asset_exif')
          .values({
            ...exif,
            assetId: resultId,
            orientation: '1',
            exifImageWidth: output.width,
            exifImageHeight: output.height,
            fileSizeInByte: output.size,
            colorspace: 'srgb',
            dateTimeOriginal: source.exif.dateTimeOriginal ?? current.fileCreatedAt,
            lockedProperties: [
              ...new Set([...(source.exif.lockedProperties ?? []), 'dateTimeOriginal', 'timeZone'] as const),
            ],
          })
          .execute();
        await trx
          .insertInto('tag_asset')
          .columns(['assetId', 'tagId'])
          .expression(
            trx
              .selectFrom('tag_asset')
              .select((eb) => [eb.val(resultId).as('assetId'), 'tagId'])
              .where('assetId', '=', current.id),
          )
          .onConflict((oc) => oc.doNothing())
          .execute();
        await trx
          .insertInto('album_asset')
          .columns(['assetId', 'albumId'])
          .expression(
            trx
              .selectFrom('album_asset')
              .innerJoin('album_user', 'album_user.albumId', 'album_asset.albumId')
              .select((eb) => [eb.val(resultId).as('assetId'), 'album_asset.albumId'])
              .where('album_asset.assetId', '=', current.id)
              .where('album_user.userId', '=', current.ownerId)
              .where('album_user.role', 'in', [AlbumUserRole.Owner, AlbumUserRole.Editor]),
          )
          .onConflict((oc) => oc.doNothing())
          .execute();
      } else {
        await trx
          .updateTable('asset')
          .set({
            originalPath: output.path,
            fileModifiedAt: output.modifiedAt,
            width: output.width,
            height: output.height,
            thumbhash: output.thumbhash,
            duplicateId: null,
            ...(!current.isExternal && { checksum: output.checksum, checksumAlgorithm: ChecksumAlgorithm.sha1File }),
          })
          .where('id', '=', current.id)
          .execute();
        if (!current.isExternal) {
          await trx.deleteFrom('asset_duplicate_checksum').where('assetId', '=', current.id).execute();
        }
        await trx
          .updateTable('asset_exif')
          .set({
            orientation: '1',
            exifImageWidth: output.width,
            exifImageHeight: output.height,
            fileSizeInByte: output.size,
            colorspace: 'srgb',
          })
          .where('assetId', '=', current.id)
          .execute();
        await trx.deleteFrom('asset_edit').where('assetId', '=', current.id).execute();
        const faces = await trx
          .selectFrom('asset_face')
          .selectAll()
          .where('assetId', '=', current.id)
          .where('deletedAt', 'is', null)
          .execute();
        const dimensions = getDimensions(source.exif);
        for (const face of faces) {
          const transformed = transformSavedFace(face, operation.edits, dimensions);
          if (transformed) {
            await trx
              .updateTable('asset_face')
              .set({ ...transformed, isVisible: true })
              .where('id', '=', face.id)
              .execute();
          } else {
            await trx.deleteFrom('asset_face').where('id', '=', face.id).execute();
          }
        }
        await trx.deleteFrom('asset_ocr').where('assetId', '=', current.id).execute();
        await trx.deleteFrom('ocr_search').where('assetId', '=', current.id).execute();
        await trx.deleteFrom('smart_search').where('assetId', '=', current.id).execute();
        await trx
          .deleteFrom('asset_file')
          .where('assetId', '=', current.id)
          .where('type', 'in', [AssetFileType.Thumbnail, AssetFileType.Preview, AssetFileType.FullSize])
          .execute();
      }
      await trx.insertInto('asset_file').values(output.files).execute();
      await trx
        .insertInto('asset_job_status')
        .values({
          assetId: resultId,
          metadataExtractedAt: new Date(),
          ocrAt: null,
          petsDetectedAt: null,
          duplicatesDetectedAt: null,
        })
        .onConflict((oc) =>
          oc.column('assetId').doUpdateSet({
            metadataExtractedAt: new Date(),
            ocrAt: null,
            petsDetectedAt: null,
            duplicatesDetectedAt: null,
          }),
        )
        .execute();
      await trx
        .updateTable('asset_edit_save')
        .set({ status: AssetEditSaveStatus.Processing, resultAssetId: resultId })
        .where('id', '=', operation.id)
        .execute();
    });
  }
}
