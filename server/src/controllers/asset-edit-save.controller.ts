import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  AssetEditSaveCapabilitiesDto,
  AssetEditSaveCreateDto,
  AssetEditSaveResponseDto,
} from 'src/dtos/editing.dto.js';
import { ApiTag, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetEditSaveService } from 'src/services/asset-edit-save.service.js';
import { UUIDParamDto } from 'src/validation.js';

class AssetEditSaveParams extends createZodDto(z.object({ id: z.uuidv4(), operationId: z.uuidv4() })) {}

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetEditSaveController {
  constructor(private service: AssetEditSaveService) {}

  @Get(':id/edit-save/capabilities')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Get image file save capabilities',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  getAssetEditSaveCapabilities(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<AssetEditSaveCapabilitiesDto> {
    return this.service.capabilities(auth, id);
  }

  @Post(':id/edit-save')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Save image edits to a new or original file',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  saveAssetEdits(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetEditSaveCreateDto,
  ): Promise<AssetEditSaveResponseDto> {
    return this.service.create(auth, id, dto);
  }

  @Get(':id/edit-save/:operationId')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Get an image file save operation',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  getAssetEditSave(
    @Auth() auth: AuthDto,
    @Param() { id, operationId }: AssetEditSaveParams,
  ): Promise<AssetEditSaveResponseDto> {
    return this.service.get(auth, id, operationId);
  }
}
