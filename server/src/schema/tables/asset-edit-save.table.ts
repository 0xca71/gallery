import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  type Generated,
} from '@immich/sql-tools';
import { AssetEditActionItem, AssetEditSaveMode, AssetEditSaveStatus } from 'src/dtos/editing.dto.js';
import type { ImageAdjust } from 'src/gallery/dtos/image-adjust.dto.js';
import type { AssetEditSaveJournal } from 'src/gallery/repositories/asset-edit-save.repository.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('asset_edit_save')
@Index({ columns: ['ownerId', 'idempotencyKey'], unique: true })
@Index({ columns: ['resultAssetId'] })
@Index({
  name: 'asset_edit_save_active_asset_idx',
  columns: ['assetId'],
  unique: true,
  where: `status IN ('queued', 'rendering', 'publishing', 'processing')`,
})
export class AssetEditSaveTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', nullable: false })
  ownerId!: string;

  // Deliberately not cascading with the source: recovery records must outlive asset deletion.
  @Column({ type: 'uuid' })
  assetId!: string;

  @Column({ type: 'uuid' })
  idempotencyKey!: string;

  @Column({ type: 'character varying' })
  mode!: AssetEditSaveMode;

  @Column({ type: 'character varying', default: 'queued' })
  status!: Generated<AssetEditSaveStatus>;

  @Column({ type: 'timestamp with time zone' })
  expectedVersion!: Date;

  @Column({ type: 'jsonb' })
  edits!: AssetEditActionItem[];

  @Column({ type: 'jsonb', nullable: true })
  adjust!: ImageAdjust | null;

  @Column({ type: 'uuid', nullable: true })
  resultAssetId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  journal!: AssetEditSaveJournal | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
