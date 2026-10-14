import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { type Stats, constants, createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, chown, copyFile, mkdir, realpath, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobItem } from 'src/types.js';
import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetEditActionItem,
  AssetEditSaveCapabilitiesDto,
  AssetEditSaveCreateDto,
  AssetEditSaveMode,
  AssetEditSaveResponseDto,
  AssetEditSaveStatus,
} from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetType,
  ChecksumAlgorithm,
  Colorspace,
  ImmichWorker,
  JobName,
  JobStatus,
  Permission,
  StorageFolder,
} from 'src/enum.js';
import {
  AssetEditSaveJournal,
  AssetEditSaveRow,
  AssetEditSaveSource,
} from 'src/repositories/asset-edit-save.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { StorageService } from 'src/services/storage.service.js';
import { getSavedImageFormat, validateSavedImageEdits } from 'src/utils/asset-edit-save.js';
import { getDimensions, isPanorama } from 'src/utils/asset.util.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { mimeTypes } from 'src/utils/mime-types.js';

const terminalStatuses = new Set([
  AssetEditSaveStatus.Completed,
  AssetEditSaveStatus.Failed,
  AssetEditSaveStatus.Conflict,
]);
const copyWithMetadata = promisify(execFile);
const preserveFileAttributes = process.platform === 'linux' ? ['-p', '--preserve=xattr'] : ['-p'];
const asResponse = ({
  id,
  assetId,
  resultAssetId,
  mode,
  status,
  error,
}: AssetEditSaveRow): AssetEditSaveResponseDto => ({ id, assetId, resultAssetId, mode, status, error });

@Injectable()
export class AssetEditSaveService extends BaseService {
  private recoveryTimer?: NodeJS.Timeout;

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async resumeSaves() {
    this.recoveryTimer ??= setInterval(() => {
      void this.requeueSaves().catch(() => this.logger.error('Could not requeue image saves'));
    }, 60_000);
    this.recoveryTimer.unref();
    await this.requeueSaves();
  }

  @OnEvent({ name: 'AppShutdown', workers: [ImmichWorker.Microservices] })
  stopRecovery() {
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  private async requeueSaves() {
    const operations = await this.assetEditSaveRepository.getInFlight();
    await this.jobRepository.queueAll(
      operations.map(({ id, assetId }) => ({
        name: JobName.AssetEditThumbnailGeneration,
        data: { id: assetId, editSaveOperationId: id },
      })),
    );
  }

  private validateSource(source?: AssetEditSaveSource): asserts source is AssetEditSaveSource {
    if (!source || source.asset.deletedAt || source.asset.isOffline) {
      throw new NotFoundException('Source image is unavailable');
    }
    const { asset, exif } = source;
    if (
      asset.type !== AssetType.Image ||
      asset.livePhotoVideoId ||
      isPanorama({ projectionType: exif.projectionType, originalFileName: asset.originalFileName }) ||
      ['.gif', '.svg'].includes(extname(asset.originalFileName).toLowerCase())
    ) {
      throw new BadRequestException('This image type cannot be saved with edits');
    }
    const dimensions = getDimensions(exif);
    if (!dimensions.width || !dimensions.height) {
      throw new BadRequestException('Original image dimensions are unavailable');
    }
  }

  async capabilities(auth: AuthDto, id: string): Promise<AssetEditSaveCapabilitiesDto> {
    await this.requireAccess({ auth, permission: Permission.AssetEditCreate, ids: [id] });
    const source = await this.assetEditSaveRepository.getSource(id);
    this.validateSource(source);
    const format = getSavedImageFormat(source.asset.originalPath);
    let reason: string | null = format ? null : 'unsupported_format';
    if (await this.assetEditSaveRepository.isSaving(id)) {
      reason = 'save_in_progress';
    } else if (!reason && isAbsolute(source.asset.originalPath)) {
      try {
        const path = await realpath(source.asset.originalPath);
        await access(path, constants.R_OK | constants.W_OK);
        await access(dirname(path), constants.W_OK);
      } catch {
        reason = 'not_writable';
      }
    }
    return { canCopy: true, canOverwrite: !reason, overwriteUnavailableReason: reason, outputFormat: format ?? 'jpeg' };
  }

  async create(auth: AuthDto, id: string, dto: AssetEditSaveCreateDto): Promise<AssetEditSaveResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetEditCreate, ids: [id] });
    if (dto.mode === AssetEditSaveMode.Copy) {
      await this.requireAccess({ auth, permission: Permission.AssetUpload, ids: [auth.user.id] });
    }
    return this.databaseRepository.withAssetLock(id, async () => {
      const existing = await this.assetEditSaveRepository.getByKey(auth.user.id, dto.idempotencyKey);
      if (existing) {
        if (
          existing.assetId !== id ||
          existing.mode !== dto.mode ||
          existing.expectedVersion.getTime() !== dto.expectedVersion.getTime() ||
          JSON.stringify(existing.edits) !== JSON.stringify(dto.edits)
        ) {
          throw new ConflictException('Idempotency key was used for a different save');
        }
        if (!terminalStatuses.has(existing.status)) {
          await this.jobRepository.queue({
            name: JobName.AssetEditThumbnailGeneration,
            data: { id: existing.assetId, editSaveOperationId: existing.id },
          });
        }
        return asResponse(existing);
      }
      const source = await this.assetEditSaveRepository.getSource(id);
      this.validateSource(source);
      if (source.asset.ownerId !== auth.user.id || source.asset.updatedAt.getTime() !== dto.expectedVersion.getTime()) {
        throw new ConflictException('The source image changed since the editor was opened');
      }
      validateSavedImageEdits(dto.edits as AssetEditActionItem[], getDimensions(source.exif));
      await this.assetEditSaveRepository.assertNotSaving(id);
      if (dto.mode === AssetEditSaveMode.Overwrite) {
        const capabilities = await this.capabilities(auth, id);
        if (!capabilities.canOverwrite) {
          throw new BadRequestException(capabilities.overwriteUnavailableReason!);
        }
      }
      const operation = await this.assetEditSaveRepository.create(auth.user.id, id, dto);
      await this.jobRepository.queue({
        name: JobName.AssetEditThumbnailGeneration,
        data: { id: operation.assetId, editSaveOperationId: operation.id },
      });
      return asResponse(operation);
    });
  }

  async get(auth: AuthDto, assetId: string, operationId: string): Promise<AssetEditSaveResponseDto> {
    const operation = await this.assetEditSaveRepository.get(operationId);
    if (!operation || operation.assetId !== assetId || operation.ownerId !== auth.user.id) {
      throw new NotFoundException('Image save not found');
    }
    return asResponse(operation);
  }

  @OnEvent({ name: 'AssetEditSave', workers: [ImmichWorker.Microservices] })
  async onSaveRequest(request: ArgOf<'AssetEditSave'>) {
    request.result = await this.handleSave({ id: request.id });
  }

  async handleSave({ id }: { id: string }): Promise<JobStatus> {
    let operation = await this.assetEditSaveRepository.get(id);
    if (!operation || terminalStatuses.has(operation.status)) {
      return JobStatus.Skipped;
    }
    return this.databaseRepository.withAssetLock(operation.assetId, async () => {
      operation = await this.assetEditSaveRepository.get(id);
      if (!operation || terminalStatuses.has(operation.status)) {
        return JobStatus.Skipped;
      }
      if (operation.status === AssetEditSaveStatus.Processing) {
        await this.finish(operation);
        return JobStatus.Success;
      }
      const workdir = join(tmpdir(), 'gallery-edit-save', id);
      try {
        if (operation.status === AssetEditSaveStatus.Publishing) {
          await this.rollback(operation);
          operation = await this.assetEditSaveRepository.update(id, {
            status: AssetEditSaveStatus.Queued,
            journal: null,
            error: null,
          });
        }
        await rm(workdir, { recursive: true, force: true });
        await mkdir(workdir, { recursive: true, mode: 0o700 });
        await this.renderAndCommit(operation, workdir);
      } catch (error) {
        const saved = await this.assetEditSaveRepository.get(id);
        // A DB transaction may have committed before its connection failed. Consult the journal,
        // rather than restoring a file whose new metadata is already committed.
        if (saved?.status === AssetEditSaveStatus.Processing) {
          throw new Error('Image save post-processing must be retried', { cause: error });
        }
        if (saved?.journal) {
          try {
            await this.rollback(saved);
          } catch (recoveryError) {
            await this.assetEditSaveRepository.update(id, { error: 'recovery_required' });
            throw new Error('Image save recovery must be retried; backup retained', { cause: recoveryError });
          }
        }
        const filesystemCode = (error as NodeJS.ErrnoException)?.code;
        const filesystemMessage =
          error instanceof Error ? `${error.message} ${(error as Error & { stderr?: string }).stderr ?? ''}` : '';
        const code =
          error instanceof Error && error.message.includes('Quota has been exceeded')
            ? 'quota_exceeded'
            : filesystemCode === 'ENOSPC' || filesystemMessage.includes('No space left')
              ? 'storage_full'
              : filesystemCode === 'ENOENT' || error instanceof NotFoundException
                ? 'source_unavailable'
                : ['EACCES', 'EPERM', 'EROFS'].includes(filesystemCode ?? '') ||
                    /Permission denied|Read-only file system/.test(filesystemMessage)
                  ? 'not_writable'
                  : error instanceof ConflictException
                    ? 'source_changed'
                    : isAssetChecksumConstraint(error)
                      ? 'duplicate'
                      : error instanceof BadRequestException
                        ? 'unsupported_format'
                        : 'save_failed';
        await this.assetEditSaveRepository.update(id, {
          status: code === 'source_changed' ? AssetEditSaveStatus.Conflict : AssetEditSaveStatus.Failed,
          error: code,
        });
        this.logger.error(`Image save ${id} failed (${code})`);
        return JobStatus.Failed;
      } finally {
        await rm(workdir, { recursive: true, force: true });
      }
      await this.finish((await this.assetEditSaveRepository.get(id))!);
      return JobStatus.Success;
    });
  }

  private async renderAndCommit(operation: AssetEditSaveRow, workdir: string) {
    const source = await this.assetEditSaveRepository.getSource(operation.assetId);
    this.validateSource(source);
    if (source.asset.updatedAt.getTime() !== operation.expectedVersion.getTime()) {
      throw new ConflictException('Source image version changed');
    }
    const { asset, exif } = source;
    const format = getSavedImageFormat(asset.originalPath) ?? 'jpeg';
    if (operation.mode === AssetEditSaveMode.Overwrite && !getSavedImageFormat(asset.originalPath)) {
      throw new BadRequestException('unsupported_format');
    }
    operation = await this.assetEditSaveRepository.update(operation.id, {
      status: AssetEditSaveStatus.Rendering,
      error: null,
    });
    const original = await this.ensureLocalFile(asset.originalPath);
    try {
      const sourceStat = await stat(original.localPath);
      if (isAbsolute(asset.originalPath) && sourceStat.mtime.getTime() !== asset.fileModifiedAt.getTime()) {
        throw new ConflictException('The original file changed outside Gallery');
      }
      const originalDigest = await this.hashFileHex(original.localPath);
      if (asset.checksumAlgorithm === ChecksumAlgorithm.sha1File && originalDigest !== asset.checksum.toString('hex')) {
        throw new ConflictException('Original image content changed before rendering');
      }
      const output = join(workdir, `image.${format}`);
      validateSavedImageEdits(operation.edits, getDimensions(exif));
      const dimensions = await this.mediaRepository.renderSavedImage(
        original.localPath,
        output,
        operation.edits,
        format,
        getDimensions(exif),
        operation.mode === AssetEditSaveMode.Overwrite,
      );
      await this.mediaRepository.writeSavedImageMetadata(
        original.localPath,
        output,
        exif,
        dimensions,
        asset.fileCreatedAt,
      );
      const checksum = await this.cryptoRepository.hashFile(output);
      const { size } = await stat(output);
      const resultAssetId = operation.mode === AssetEditSaveMode.Copy ? this.cryptoRepository.randomUUID() : asset.id;
      const relative = StorageCore.getRelativeNestedPath(
        StorageFolder.Upload,
        asset.ownerId,
        `${resultAssetId}.${format}`,
      );
      const path =
        operation.mode === AssetEditSaveMode.Overwrite
          ? asset.originalPath
          : StorageService.getWriteBackend() instanceof DiskStorageBackend
            ? join(StorageCore.getMediaLocation(), relative)
            : relative;
      const publishPath =
        isAbsolute(path) && operation.mode === AssetEditSaveMode.Overwrite ? await realpath(path) : path;
      const originalAsset = await this.assetRepository.getForCopy(asset.id);
      const oldFiles =
        operation.mode === AssetEditSaveMode.Overwrite
          ? (originalAsset?.files
              .filter(
                (file) =>
                  [AssetFileType.Thumbnail, AssetFileType.Preview, AssetFileType.FullSize].includes(file.type) &&
                  file.path !== asset.originalPath &&
                  file.path !== publishPath,
              )
              .map((file) => file.path) ?? [])
          : [];
      const journal: AssetEditSaveJournal = {
        originalPath: asset.originalPath,
        publishPath,
        stagePath: `${publishPath}.gallery-save-${operation.id}.tmp`,
        backupPath:
          operation.mode === AssetEditSaveMode.Overwrite ? `${publishPath}.gallery-save-${operation.id}.bak` : null,
        originalDigest,
        outputDigest: checksum.toString('hex'),
        resultAssetId,
        newFiles: [],
        oldFiles,
        originalStat: {
          mode: sourceStat.mode,
          uid: sourceStat.uid,
          gid: sourceStat.gid,
          mtime: sourceStat.mtime.toISOString(),
          atime: sourceStat.atime.toISOString(),
        },
      };
      operation = await this.assetEditSaveRepository.update(operation.id, {
        journal,
        status: AssetEditSaveStatus.Publishing,
      });
      const derivatives = await this.renderDerivatives(
        output,
        resultAssetId,
        asset.ownerId,
        operation.id,
        async (files) => {
          journal.newFiles = files;
          operation = await this.assetEditSaveRepository.update(operation.id, { journal });
        },
      );
      await this.stageFile(
        output,
        journal.stagePath,
        sourceStat,
        operation.mode === AssetEditSaveMode.Overwrite,
        original.localPath,
      );
      if ((await this.digestStored(journal.stagePath)) !== journal.outputDigest) {
        throw new Error('Staged image failed validation');
      }
      if (journal.backupPath) {
        await this.copyStored(publishPath, journal.backupPath);
        if ((await this.digestStored(journal.backupPath)) !== journal.originalDigest) {
          throw new ConflictException('Source changed before backup');
        }
        const sourceFiles = originalAsset?.files ?? [];
        const sidecar = sourceFiles.find((file) => file.type === AssetFileType.Sidecar);
        if (sidecar) {
          const local = await this.ensureLocalFile(sidecar.path);
          try {
            const sidecarOutput = join(workdir, 'sidecar.xmp');
            await copyFile(local.localPath, sidecarOutput);
            await this.mediaRepository.normalizeSavedSidecar(sidecarOutput, dimensions, exif, asset.fileCreatedAt);
            const sidecarStat = await stat(local.localPath);
            const sidecarPath = isAbsolute(sidecar.path) ? await realpath(sidecar.path) : sidecar.path;
            journal.sidecar = {
              path: sidecarPath,
              stagePath: `${sidecarPath}.gallery-save-${operation.id}.tmp`,
              backupPath: `${sidecarPath}.gallery-save-${operation.id}.bak`,
              originalDigest: await this.hashFileHex(local.localPath),
              outputDigest: await this.hashFileHex(sidecarOutput),
              originalStat: {
                mode: sidecarStat.mode,
                uid: sidecarStat.uid,
                gid: sidecarStat.gid,
                mtime: sidecarStat.mtime.toISOString(),
                atime: sidecarStat.atime.toISOString(),
              },
            };
            operation = await this.assetEditSaveRepository.update(operation.id, { journal });
            await this.stageFile(sidecarOutput, journal.sidecar.stagePath, sidecarStat, true, local.localPath);
            await this.copyStored(sidecarPath, journal.sidecar.backupPath);
            if (
              (await this.digestStored(journal.sidecar.stagePath)) !== journal.sidecar.outputDigest ||
              (await this.digestStored(journal.sidecar.backupPath)) !== journal.sidecar.originalDigest
            ) {
              throw new ConflictException('Sidecar changed before publication');
            }
          } finally {
            await local.cleanup();
          }
        }
      }
      if (
        (await this.digestStored(asset.originalPath)) !== originalDigest ||
        (operation.mode === AssetEditSaveMode.Overwrite &&
          isAbsolute(asset.originalPath) &&
          (await realpath(asset.originalPath)) !== publishPath)
      ) {
        throw new ConflictException('Source file changed during rendering');
      }
      if (journal.sidecar && (await this.digestStored(journal.sidecar.path)) !== journal.sidecar.originalDigest) {
        throw new ConflictException('Sidecar changed during rendering');
      }
      journal.publicationStarted = true;
      operation = await this.assetEditSaveRepository.update(operation.id, { journal });
      await this.publish(journal.stagePath, publishPath);
      if (journal.sidecar) {
        await this.publish(journal.sidecar.stagePath, journal.sidecar.path);
      }
      const publishedStat = isAbsolute(publishPath) ? await stat(publishPath) : null;
      const modifiedAt = publishedStat?.mtime ?? new Date();
      await this.assetEditSaveRepository.commit(operation, source, {
        path,
        filename:
          operation.mode === AssetEditSaveMode.Copy
            ? `${extname(asset.originalFileName) ? asset.originalFileName.slice(0, -extname(asset.originalFileName).length) : asset.originalFileName}-edited.${format}`
            : asset.originalFileName,
        checksum,
        size,
        ...dimensions,
        modifiedAt,
        thumbhash: derivatives.thumbhash,
        files: derivatives.files,
      });
    } finally {
      await original.cleanup();
    }
  }

  private async renderDerivatives(
    input: string,
    assetId: string,
    ownerId: string,
    operationId: string,
    registerFiles: (files: AssetEditSaveJournal['newFiles']) => Promise<void>,
  ) {
    const { image } = await this.getConfig({ withCache: true });
    const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };
    const thumbhash = await this.mediaRepository.generateThumbhash(input, options);
    const { isTransparent } = await this.mediaRepository.getImageMetadata(input);
    const backend = StorageService.getWriteBackend();
    const plans = (
      [
        [AssetFileType.Thumbnail, image.thumbnail],
        [AssetFileType.Preview, image.preview],
      ] as const
    ).map(([type, config]) => {
      const name = `${assetId}_${type}_save-${operationId}.${config.format}`;
      const relative = StorageCore.getRelativeNestedPath(StorageFolder.Thumbnails, ownerId, name);
      const local = join(StorageCore.getMediaLocation(), relative);
      const path = backend instanceof DiskStorageBackend ? local : relative;
      return {
        local,
        config,
        file: {
          assetId,
          type,
          path,
          isEdited: false,
          isProgressive: !!config.progressive,
          isTransparent: config.format !== 'jpeg' && isTransparent,
        },
      };
    });
    const files = plans.map(({ file }) => file);
    // Persist every owned output before its first write so a crashed worker can clean it.
    await registerFiles(files);
    const stagedPaths: string[] = [];
    try {
      for (const {
        local,
        config,
        file: { path },
      } of plans) {
        stagedPaths.push(local);
        await mkdir(dirname(local), { recursive: true });
        await this.mediaRepository.generateThumbnail(input, { ...config, ...options }, local);
        if (path !== local) {
          stagedPaths.push(path);
        }
        if (path !== local) {
          await backend.put(path, createReadStream(local), { contentType: mimeTypes.lookup(local) });
          await rm(local, { force: true });
        }
      }
      return { files, thumbhash };
    } catch (error) {
      await Promise.all(stagedPaths.map((path) => this.deleteStored(path)));
      throw error;
    }
  }

  private async stageFile(input: string, path: string, sourceStat: Stats, preserveMode: boolean, sourcePath: string) {
    if (isAbsolute(path)) {
      await mkdir(dirname(path), { recursive: true });
      if (preserveMode) {
        // Keep the original ACL and extended attributes on supported Unix hosts.
        // Writing into the cloned inode retains them for the atomic publication.
        await copyWithMetadata('/bin/cp', [...preserveFileAttributes, '--', sourcePath, path]);
        await pipeline(createReadStream(input), createWriteStream(path));
      } else {
        await copyFile(input, path);
      }
      if (preserveMode) {
        await chmod(path, sourceStat.mode);
        const staged = await stat(path);
        if (staged.uid !== sourceStat.uid || staged.gid !== sourceStat.gid) {
          await chown(path, sourceStat.uid, sourceStat.gid);
        }
      }
    } else {
      await StorageService.resolveBackendForKey(path).put(path, createReadStream(input), {
        contentType: mimeTypes.lookup(input),
      });
    }
  }

  private async copyStored(source: string, target: string) {
    if (isAbsolute(source)) {
      await copyWithMetadata('/bin/cp', [...preserveFileAttributes, '--', source, target]);
      return;
    }
    const backend = StorageService.resolveBackendForKey(source);
    const { stream, contentType } = await backend.get(source);
    await backend.put(target, stream, { contentType });
  }

  private async publish(stage: string, target: string) {
    if (isAbsolute(target)) {
      await rename(stage, target);
      return;
    }
    await this.copyStored(stage, target);
  }

  private async digestStored(path: string) {
    const file = await this.ensureLocalFile(path);
    try {
      return await this.hashFileHex(file.localPath);
    } finally {
      await file.cleanup();
    }
  }

  private async hashFileHex(path: string) {
    const digest = await this.cryptoRepository.hashFile(path);
    return digest.toString('hex');
  }

  private async deleteStored(path: string) {
    if (isAbsolute(path)) {
      await rm(path, { force: true });
    } else {
      const backend = StorageService.resolveBackendForKey(path);
      if (await backend.exists(path)) {
        await backend.delete(path);
      }
    }
  }

  private async rollback(operation: AssetEditSaveRow) {
    const journal = operation.journal;
    if (!journal) {
      return;
    }
    if (operation.mode === AssetEditSaveMode.Overwrite) {
      const digest = await this.digestStored(journal.publishPath);
      if (digest === journal.originalDigest) {
        // Rendering/staging failed before publication. The source still contains its old bytes.
      } else if (digest === journal.outputDigest) {
        if (!journal.backupPath) {
          throw new Error('Original backup is unavailable');
        }
        if ((await this.digestStored(journal.backupPath)) !== journal.originalDigest) {
          throw new Error('Original backup failed validation');
        }
        await this.copyStored(journal.backupPath, journal.stagePath);
        if (isAbsolute(journal.stagePath) && journal.originalStat) {
          await chmod(journal.stagePath, journal.originalStat.mode);
          const staged = await stat(journal.stagePath);
          if (staged.uid !== journal.originalStat.uid || staged.gid !== journal.originalStat.gid) {
            await chown(journal.stagePath, journal.originalStat.uid, journal.originalStat.gid);
          }
          await utimes(journal.stagePath, new Date(journal.originalStat.atime), new Date(journal.originalStat.mtime));
        }
        await this.publish(journal.stagePath, journal.publishPath);
      } else {
        if (journal.publicationStarted) {
          throw new ConflictException('External file changed; recovery backup retained');
        }
        // A detectable external modification cancelled the save before any replacement.
        // Leave that version untouched and release this operation after cleaning its temps.
      }
      if (journal.sidecar) {
        const digest = await this.digestStored(journal.sidecar.path);
        if (
          digest === journal.sidecar.outputDigest &&
          journal.sidecar.originalDigest !== journal.sidecar.outputDigest
        ) {
          if ((await this.digestStored(journal.sidecar.backupPath)) !== journal.sidecar.originalDigest) {
            throw new Error('Sidecar backup failed validation');
          }
          await this.copyStored(journal.sidecar.backupPath, journal.sidecar.stagePath);
          await this.restoreFileStat(journal.sidecar.stagePath, journal.sidecar.originalStat);
          await this.publish(journal.sidecar.stagePath, journal.sidecar.path);
        } else if (digest !== journal.sidecar.originalDigest && journal.publicationStarted) {
          throw new ConflictException('External sidecar changed; recovery backup retained');
        }
      }
    } else {
      await this.deleteStored(journal.publishPath);
    }
    await this.cleanupJournal(journal, true);
  }

  private async restoreFileStat(path: string, metadata: AssetEditSaveJournal['originalStat']) {
    if (!isAbsolute(path) || !metadata) {
      return;
    }
    await chmod(path, metadata.mode);
    const staged = await stat(path);
    if (staged.uid !== metadata.uid || staged.gid !== metadata.gid) {
      await chown(path, metadata.uid, metadata.gid);
    }
    await utimes(path, new Date(metadata.atime), new Date(metadata.mtime));
  }

  private async cleanupJournal(journal: AssetEditSaveJournal, removeOutput: boolean) {
    const paths = [
      journal.stagePath,
      journal.backupPath,
      journal.sidecar?.stagePath,
      journal.sidecar?.backupPath,
      ...(removeOutput ? journal.newFiles.map((file) => file.path) : journal.oldFiles),
    ];
    for (const path of paths) {
      if (path) {
        await this.deleteStored(path);
      }
    }
  }

  private async finish(operation: AssetEditSaveRow) {
    const id = operation.resultAssetId!;
    const jobs: JobItem[] = [
      { name: JobName.SmartSearch, data: { id, source: 'upload' } },
      { name: JobName.Ocr, data: { id } },
    ];
    if (operation.mode === AssetEditSaveMode.Copy) {
      jobs.splice(0, jobs.length, { name: JobName.AssetExtractMetadata, data: { id, source: 'upload', notify: true } });
      await this.eventRepository.emit('AssetCreate', { asset: { id, ownerId: operation.ownerId } });
    }
    await this.jobRepository.queueAll(jobs);
    const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([id], operation.ownerId);
    if (asset) {
      this.websocketRepository.clientSend(
        operation.mode === AssetEditSaveMode.Copy ? 'on_upload_success' : 'on_asset_update',
        operation.ownerId,
        mapAsset(asset),
      );
    }
    await this.cleanupJournal(operation.journal!, false);
    await this.assetEditSaveRepository.update(operation.id, {
      status: AssetEditSaveStatus.Completed,
      error: null,
      journal: null,
    });
  }
}
