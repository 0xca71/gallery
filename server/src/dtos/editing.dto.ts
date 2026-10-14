import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { isoDatetimeToDate } from 'src/validation.js';

export enum AssetEditAction {
  Crop = 'crop',
  Rotate = 'rotate',
  Mirror = 'mirror',
  Trim = 'trim',
}

export const AssetEditActionSchema = z
  .enum(AssetEditAction)
  .describe('Type of edit action to perform')
  .meta({ id: 'AssetEditAction' });

export enum MirrorAxis {
  Horizontal = 'horizontal',
  Vertical = 'vertical',
}

const MirrorAxisSchema = z.enum(['horizontal', 'vertical']).describe('Axis to mirror along').meta({ id: 'MirrorAxis' });

const CropParametersSchema = z
  .object({
    x: z.int().min(0).describe('Top-Left X coordinate of crop'),
    y: z.int().min(0).describe('Top-Left Y coordinate of crop'),
    width: z.int().min(1).describe('Width of the crop'),
    height: z.int().min(1).describe('Height of the crop'),
  })
  .meta({ id: 'CropParameters' });

const RotateParametersSchema = z
  .object({
    angle: z
      .int()
      .min(0)
      .max(270)
      .refine((v) => [0, 90, 180, 270].includes(v), {
        error: 'Angle must be one of the following values: 0, 90, 180, 270',
      })
      .describe('Rotation angle in degrees'),
  })
  .meta({ id: 'RotateParameters' });

const MirrorParametersSchema = z
  .object({
    axis: MirrorAxisSchema,
  })
  .meta({ id: 'MirrorParameters' });

const TrimParametersSchema = z
  .object({
    startTime: z.number().meta({ format: 'double' }).min(0).describe('Start time in seconds'),
    endTime: z.number().meta({ format: 'double' }).min(0).describe('End time in seconds'),
  })
  .refine((params) => params.endTime > params.startTime, {
    error: 'endTime must be greater than startTime',
    path: ['endTime'],
  })
  .meta({ id: 'TrimParameters' });

// TODO: ideally we would use the discriminated union directly in the future not only for type support but also for validation and openapi generation
const __AssetEditActionItemSchema = z.discriminatedUnion('action', [
  z.object({ action: AssetEditActionSchema.extract(['Crop']), parameters: CropParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Rotate']), parameters: RotateParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Mirror']), parameters: MirrorParametersSchema }),
  z.object({ action: AssetEditActionSchema.extract(['Trim']), parameters: TrimParametersSchema }),
]);

const AssetEditParametersSchema = z
  .union([CropParametersSchema, RotateParametersSchema, MirrorParametersSchema, TrimParametersSchema], {
    error: getExpectedKeysByActionMessage,
  })
  .describe('List of edit actions to apply (crop, rotate, mirror, or trim)');

const actionParameterMap = {
  [AssetEditAction.Crop]: CropParametersSchema,
  [AssetEditAction.Rotate]: RotateParametersSchema,
  [AssetEditAction.Mirror]: MirrorParametersSchema,
  [AssetEditAction.Trim]: TrimParametersSchema,
} as const;

const actionParameterKeys = {
  [AssetEditAction.Crop]: Object.keys(CropParametersSchema.shape),
  [AssetEditAction.Rotate]: Object.keys(RotateParametersSchema.shape),
  [AssetEditAction.Mirror]: Object.keys(MirrorParametersSchema.shape),
  [AssetEditAction.Trim]: ['startTime', 'endTime'],
} as const;

function getExpectedKeysByActionMessage(): string {
  const expectedByAction = Object.keys(actionParameterMap)
    .map((action) => `${action}: [${actionParameterKeys[action as AssetEditAction].join(', ')}]`)
    .join('; ');

  return `Invalid parameters for action, expected keys by action: ${expectedByAction}`;
}

function isParametersValidForAction(edit: z.infer<typeof AssetEditActionItemSchema>): boolean {
  return actionParameterMap[edit.action].safeParse(edit.parameters).success;
}

const AssetEditActionItemSchema = z
  .object({
    action: AssetEditActionSchema,
    parameters: AssetEditParametersSchema,
  })
  .superRefine((edit, ctx) => {
    if (!isParametersValidForAction(edit)) {
      ctx.addIssue({
        code: 'custom',
        path: ['parameters'],
        message: `Invalid parameters for action '${edit.action}', expecting keys: ${actionParameterKeys[edit.action].join(', ')}`,
      });
    }
  })
  .meta({ id: 'AssetEditActionItemDto' });

export type AssetEditActionItem = z.infer<typeof __AssetEditActionItemSchema>;
export type AssetEditParameters = AssetEditActionItem['parameters'];

function uniqueEditActions(edits: z.infer<typeof AssetEditActionItemSchema>[]): boolean {
  const keys = new Set<string>();
  for (const edit of edits) {
    const key = edit.action === 'mirror' ? `mirror-${JSON.stringify(edit.parameters)}` : edit.action;
    if (keys.has(key)) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

const AssetEditsCreateSchema = z
  .object({
    edits: z
      .array(AssetEditActionItemSchema)
      .min(1)
      .describe('List of edit actions to apply (crop, rotate, mirror, or trim)')
      .refine(uniqueEditActions, { error: 'Duplicate edit actions are not allowed' }),
  })
  .meta({ id: 'AssetEditsCreateDto' });

const AssetEditActionItemResponseSchema = AssetEditActionItemSchema.extend({
  id: z.uuidv4().describe('Asset edit ID'),
}).meta({ id: 'AssetEditActionItemResponseDto' });

const AssetEditsResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID these edits belong to'),
    edits: z.array(AssetEditActionItemResponseSchema).describe('List of edit actions applied to the asset'),
  })
  .meta({ id: 'AssetEditsResponseDto' });

export class AssetEditActionItemResponseDto extends createZodDto(AssetEditActionItemResponseSchema) {}
export class AssetEditsCreateDto extends createZodDto(AssetEditsCreateSchema) {}
export class AssetEditsResponseDto extends createZodDto(AssetEditsResponseSchema) {}
export type CropParameters = z.infer<typeof CropParametersSchema>;
export type TrimParameters = z.infer<typeof TrimParametersSchema>;
export type RotateParameters = z.infer<typeof RotateParametersSchema>;
export type MirrorParameters = z.infer<typeof MirrorParametersSchema>;

export enum AssetEditSaveMode {
  Copy = 'copy',
  Overwrite = 'overwrite',
}

export enum AssetEditSaveStatus {
  Queued = 'queued',
  Rendering = 'rendering',
  Publishing = 'publishing',
  Processing = 'processing',
  Completed = 'completed',
  Failed = 'failed',
  Conflict = 'conflict',
}

const AssetEditSaveModeSchema = z.enum(AssetEditSaveMode).meta({ id: 'AssetEditSaveMode' });

const AssetEditSaveCreateSchema = AssetEditsCreateSchema.extend({
  edits: z
    .array(AssetEditActionItemSchema)
    .refine(uniqueEditActions, { error: 'Duplicate edit actions are not allowed' }),
  mode: AssetEditSaveModeSchema,
  expectedVersion: isoDatetimeToDate.describe('Asset updatedAt when the editor was opened'),
  idempotencyKey: z.uuidv4().describe('Reuse this key when retrying the same save'),
}).meta({ id: 'AssetEditSaveCreateDto' });

const AssetEditSaveResponseSchema = z
  .object({
    id: z.uuidv4(),
    assetId: z.uuidv4(),
    resultAssetId: z.uuidv4().nullable(),
    mode: AssetEditSaveModeSchema,
    status: z.enum(AssetEditSaveStatus).meta({ id: 'AssetEditSaveStatus' }),
    error: z.string().nullable(),
  })
  .meta({ id: 'AssetEditSaveResponseDto' });

const AssetEditSaveCapabilitiesSchema = z
  .object({
    canCopy: z.boolean(),
    canOverwrite: z.boolean(),
    overwriteUnavailableReason: z.string().nullable(),
    outputFormat: z.string().nullable(),
  })
  .meta({ id: 'AssetEditSaveCapabilitiesDto' });

export class AssetEditSaveCreateDto extends createZodDto(AssetEditSaveCreateSchema) {}
export class AssetEditSaveResponseDto extends createZodDto(AssetEditSaveResponseSchema) {}
export class AssetEditSaveCapabilitiesDto extends createZodDto(AssetEditSaveCapabilitiesSchema) {}
