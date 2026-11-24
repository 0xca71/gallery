import { defaults } from 'src/dtos/config.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { JobStatus } from 'src/enum.js';
import { CleanupService } from 'src/gallery/services/cleanup.service.js';
import { GalleryAssetService } from 'src/gallery/services/gallery-asset.service.js';
import { SpatialSceneService } from 'src/gallery/services/spatial-scene.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { BaseService } from 'src/services/base.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { MediaService } from 'src/services/media.service.js';
import { OcrService } from 'src/services/ocr.service.js';
import { PersonService } from 'src/services/person.service.js';
import { PetDetectionService } from 'src/services/pet-detection.service.js';
import { PetRecognitionService } from 'src/services/pet-recognition.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import { AssetFaceFactory } from 'test/factories/asset-face.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForFacialRecognitionJob } from 'test/mappers.js';
import { factory } from 'test/small.factory.js';
import { newTestService } from 'test/utils.js';

const publishing = <T extends BaseService>(Service: new (...args: ConstructorParameters<typeof BaseService>) => T) => {
  const result = newTestService(Service);
  const service: BaseService = result.sut;
  vi.spyOn(service, 'getConfig').mockResolvedValue({
    ...defaults,
    machineLearning: {
      ...defaults.machineLearning,
      enabled: true,
      petDetection: { ...defaults.machineLearning.petDetection, enabled: true },
      petRecognition: { ...defaults.machineLearning.petRecognition, enabled: true },
      spatialScene: { ...defaults.machineLearning.spatialScene, enabled: true },
    },
  });
  result.mocks.database.withAssetLock.mockImplementation(async (_id, callback) => callback());
  result.mocks.assetEditSave.isSaving.mockResolvedValue(true);
  return result;
};

describe('image publication consumer guards', () => {
  const id = factory.uuid();
  it('does not generate or replace previews while original publication is in flight', async () => {
    const { sut, mocks } = publishing(MediaService);
    expect(await sut.handleGenerateThumbnails({ id })).toBe(JobStatus.Skipped);
    expect(await sut.handleAssetEditThumbnailGeneration({ id })).toBe(JobStatus.Skipped);
    expect(await sut.handleAssetMigration({ id })).toBe(JobStatus.Skipped);
    expect(mocks.assetJob.getForGenerateThumbnailJob).not.toHaveBeenCalled();
    expect(mocks.assetJob.getForMigrationJob).not.toHaveBeenCalled();
  });
  it('defers OCR and CLIP readers instead of indexing the old preview', async () => {
    const ocr = publishing(OcrService);
    const clip = publishing(SmartInfoService);
    expect(await ocr.sut.handleOcr({ id })).toBe(JobStatus.Skipped);
    expect(await clip.sut.handleEncodeClip({ id })).toBe(JobStatus.Skipped);
    expect(ocr.mocks.assetJob.getForOcr).not.toHaveBeenCalled();
    expect(clip.mocks.assetJob.getForClipEncoding).not.toHaveBeenCalled();
  });
  it('does not commit human or pet boxes against unpublished pixels', async () => {
    const human = publishing(PersonService);
    const pet = publishing(PetDetectionService);
    expect(await human.sut.handleDetectFaces({ id })).toBe(JobStatus.Skipped);
    expect(await pet.sut.handlePetDetection({ id })).toBe(JobStatus.Skipped);
    expect(human.mocks.assetJob.getForDetectFacesJob).not.toHaveBeenCalled();
    expect(pet.mocks.petFace.getForPetDetection).not.toHaveBeenCalled();
  });
  it('holds quality, depth and classification writers until publication is finished', async () => {
    const quality = publishing(CleanupService);
    const depth = publishing(SpatialSceneService);
    const classification = publishing(ClassificationService);
    expect(await quality.sut.handleQualityAnalysis({ id })).toBe(JobStatus.Skipped);
    expect(await depth.sut.handleSpatialScene({ id })).toBe(JobStatus.Skipped);
    expect(await classification.sut.handleClassify({ id })).toBe(JobStatus.Skipped);
    expect(quality.mocks.cleanup.getForQualityAnalysis).not.toHaveBeenCalled();
    expect(depth.mocks.spatialScene.getForJob).not.toHaveBeenCalled();
    expect(classification.mocks.asset.getById).not.toHaveBeenCalled();
  });
  it('holds an already queued human recognition job while its asset pixels are publishing', async () => {
    const { sut, mocks } = publishing(PersonService);
    const asset = AssetFactory.from().exif().build();
    const face = AssetFaceFactory.create({ assetId: asset.id });
    mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));
    expect(await sut.handleRecognizeFaces({ id: face.id })).toBe(JobStatus.Skipped);
    expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    expect(mocks.search.searchFaces).not.toHaveBeenCalled();
  });

  it('holds an already queued pet recognition job while its asset pixels are publishing', async () => {
    const { sut, mocks } = publishing(PetRecognitionService);
    const faceId = factory.uuid();
    mocks.petFace.getPetFaceForRecognition.mockResolvedValue({
      id: faceId,
      assetId: id,
      personGroupId: null,
      asset: { ownerId: factory.uuid() },
      petSearch: { faceId, embedding: '[1,2,3,4]', species: 'cat' },
    });
    expect(await sut.handlePetRecognition({ id: faceId })).toBe(JobStatus.Skipped);
    expect(mocks.petFace.searchPets).not.toHaveBeenCalled();
    expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
  });
  it('requeues physical deletion and retains the original and sidecars while saving', async () => {
    const { sut, mocks } = publishing(AssetService);
    expect(await sut.handleAssetDeletion({ id, deleteOnDisk: true })).toBe(JobStatus.Skipped);
    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: 'AssetDelete',
      data: { id, deleteOnDisk: true, delay: 2000 },
    });
    expect(mocks.assetJob.getForAssetDeletion).not.toHaveBeenCalled();
  });
  it('rejects new geometry and Adjust writes while the durable save reservation exists', async () => {
    const geometry = publishing(AssetService);
    const adjust = publishing(GalleryAssetService);
    const conflict = new Error('An image save is already in progress');
    geometry.mocks.assetEditSave.assertNotSaving.mockRejectedValue(conflict);
    adjust.mocks.assetEditSave.assertNotSaving.mockRejectedValue(conflict);
    const auth = factory.auth();
    await expect(
      geometry.sut.editAsset(auth, id, { edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }] }),
    ).rejects.toThrow(conflict);
    await expect(
      adjust.sut.setAdjust(auth, id, { exposure: 5, contrast: 0, saturation: 0, invert: false }),
    ).rejects.toThrow(conflict);
    expect(geometry.mocks.assetEdit.replaceAll).not.toHaveBeenCalled();
    expect(adjust.mocks.imageAdjust.upsert).not.toHaveBeenCalled();
  });
});
