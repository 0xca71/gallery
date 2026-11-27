import request from 'supertest';
import { AssetEditSaveMode, AssetEditSaveStatus } from 'src/dtos/editing.dto.js';
import { AssetEditSaveController } from 'src/gallery/controllers/asset-edit-save.controller.js';
import { AssetEditSaveService } from 'src/gallery/services/asset-edit-save.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AssetEditSaveController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AssetEditSaveService);
  beforeAll(async () => {
    ctx = await controllerSetup(AssetEditSaveController, [{ provide: AssetEditSaveService, useValue: service }]);
    return () => ctx.close();
  });
  beforeEach(() => {
    ctx.reset();
    service.resetAllMocks();
  });

  it('accepts Adjust-only saves and transforms the expected version into a Date', async () => {
    const assetId = factory.uuid();
    const operationId = factory.uuid();
    const idempotencyKey = factory.uuid();
    const expectedVersion = new Date().toISOString();
    const adjust = { exposure: 25, contrast: -10, saturation: 0, invert: true };
    service.create.mockResolvedValue({
      id: operationId,
      assetId,
      resultAssetId: null,
      mode: AssetEditSaveMode.Copy,
      status: AssetEditSaveStatus.Queued,
      error: null,
    });
    const response = await request(ctx.getHttpServer())
      .post(`/assets/${assetId}/edit-save`)
      .send({ edits: [], adjust, mode: 'copy', idempotencyKey, expectedVersion });
    expect(response.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith(undefined, assetId, {
      edits: [],
      adjust,
      mode: 'copy',
      idempotencyKey,
      expectedVersion: new Date(expectedVersion),
    });
    expect(response.body.status).toBe('queued');
  });

  it.each([
    { edits: [{ action: 'trim', parameters: { start: 0, end: 1 } }] },
    { edits: [{ action: 'rotate', parameters: { angle: 361 } }] },
    {
      edits: [
        { action: 'rotate', parameters: { angle: 90 } },
        { action: 'rotate', parameters: { angle: 180 } },
      ],
    },
    { adjust: { exposure: 101 } },
    { expectedVersion: 'not-a-date' },
    { idempotencyKey: 'not-a-uuid' },
    { mode: 'replace' },
  ])('rejects invalid file-save payloads before invoking the worker: %j', async (invalid) => {
    const response = await request(ctx.getHttpServer())
      .post(`/assets/${factory.uuid()}/edit-save`)
      .send({
        edits: [],
        mode: 'overwrite',
        expectedVersion: new Date().toISOString(),
        idempotencyKey: factory.uuid(),
        ...invalid,
      });
    expect(response.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('validates both status path identifiers', async () => {
    const response = await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/edit-save/invalid`);
    expect(response.status).toBe(400);
    expect(service.get).not.toHaveBeenCalled();
  });

  it('serializes native and automatic-format capabilities', async () => {
    service.capabilities.mockResolvedValue({
      canCopy: true,
      canOverwrite: false,
      overwriteUnavailableReason: 'not_writable',
      outputFormat: null,
    });
    const response = await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/edit-save/capabilities`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      canCopy: true,
      canOverwrite: false,
      overwriteUnavailableReason: 'not_writable',
      outputFormat: null,
    });
  });
});
