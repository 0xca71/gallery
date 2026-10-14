import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE asset_edit_save (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "ownerId" uuid NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    "assetId" uuid NOT NULL,
    "idempotencyKey" uuid NOT NULL,
    mode character varying NOT NULL,
    status character varying NOT NULL DEFAULT 'queued',
    "expectedVersion" timestamp with time zone NOT NULL,
    edits jsonb NOT NULL,
    "resultAssetId" uuid,
    journal jsonb,
    error text,
    "createdAt" timestamp with time zone NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX "asset_edit_save_ownerId_idx" ON asset_edit_save ("ownerId")`.execute(db);
  await sql`CREATE UNIQUE INDEX "asset_edit_save_ownerId_idempotencyKey_idx" ON asset_edit_save ("ownerId", "idempotencyKey")`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX asset_edit_save_active_asset_idx ON asset_edit_save ("assetId")
    WHERE status IN ('queued', 'rendering', 'publishing', 'processing')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_edit_save`.execute(db);
}
