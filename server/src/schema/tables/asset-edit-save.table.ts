import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  type Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
} from '@immich/sql-tools';
import type { AssetEditSaveJournal } from 'src/repositories/asset-edit-save.repository.js';
import { AssetEditActionItem, AssetEditSaveMode, AssetEditSaveStatus } from 'src/dtos/editing.dto.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('asset_edit_save')
@Index({ columns: ['ownerId', 'idempotencyKey'], unique: true })
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

  @Column({ type: 'uuid', nullable: true })
  resultAssetId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  journal!: AssetEditSaveJournal | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Date>;
}
