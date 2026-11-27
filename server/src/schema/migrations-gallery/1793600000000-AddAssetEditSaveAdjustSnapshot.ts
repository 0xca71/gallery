import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_edit_save" ADD COLUMN "adjust" jsonb NULL`.execute(db);
  await sql`CREATE INDEX "asset_edit_save_resultAssetId_idx" ON "asset_edit_save" ("resultAssetId")`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_edit_save_resultAssetId_idx"`.execute(db);
  await sql`ALTER TABLE "asset_edit_save" DROP COLUMN "adjust"`.execute(db);
}
