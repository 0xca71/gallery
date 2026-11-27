import { Kysely } from 'kysely';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { SharedSpaceRepository } from 'src/repositories/shared-space.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

// eslint-disable-next-line unicorn/no-unnecessary-parameters
const setup = (db?: Kysely<DB>) => {
  return newMediumService(AssetService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      SharedLinkAssetRepository,
      SharedSpaceRepository,
      StackRepository,
      UserRepository,
      SharedLinkRepository,
      // the Spatial Scene overlay reads the system config
      ConfigRepository,
      SystemMetadataRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetService.name, () => {
  describe('Live Photo unlink-and-delete access', () => {
    it.each(['viewer', 'editor', 'owner'] as const)(
      'does not turn the space %s role into video deletion access',
      async (role) => {
        const { sut, ctx } = setup();
        const { user: assetOwner } = await ctx.newUser();
        const { user: member } = await ctx.newUser();
        const { space } = await ctx.newSharedSpace({ createdById: assetOwner.id });
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: assetOwner.id, role: 'owner' });
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: member.id, role });
        const { asset: video } = await ctx.newAsset({
          ownerId: assetOwner.id,
          type: AssetType.Video,
          visibility: AssetVisibility.Hidden,
        });
        const { asset: photo } = await ctx.newAsset({ ownerId: assetOwner.id, livePhotoVideoId: video.id });
        await ctx.newSharedSpaceAsset({ spaceId: space.id, assetId: photo.id, addedById: assetOwner.id });
        const auth = factory.auth({ user: { id: member.id } });
        await expect(sut.get(auth, photo.id)).resolves.toBeDefined();
        await expect(sut.unlinkAndDeleteLivePhoto(auth, photo.id)).rejects.toThrow();
        expect(await ctx.get(AssetRepository).getById(photo.id)).toMatchObject({ livePhotoVideoId: video.id });
        expect(await ctx.get(AssetRepository).getById(video.id)).toMatchObject({ deletedAt: null });
      },
    );

    it.each([false, true])(
      'requires ownership of the linked video too, including external library videos (external=%s)',
      async (external) => {
        const { sut, ctx } = setup();
        const { user: photoOwner } = await ctx.newUser();
        const { user: videoOwner } = await ctx.newUser();
        const { library } = external ? await ctx.newLibrary({ ownerId: videoOwner.id }) : { library: null };
        const { asset: video } = await ctx.newAsset({
          ownerId: videoOwner.id,
          libraryId: library?.id ?? null,
          isExternal: external,
          type: AssetType.Video,
        });
        const { asset: photo } = await ctx.newAsset({ ownerId: photoOwner.id, livePhotoVideoId: video.id });
        await expect(
          sut.unlinkAndDeleteLivePhoto(factory.auth({ user: { id: photoOwner.id } }), photo.id),
        ).rejects.toThrow();
        expect(await ctx.get(AssetRepository).getById(photo.id)).toMatchObject({ livePhotoVideoId: video.id });
        expect(await ctx.get(AssetRepository).getById(video.id)).toMatchObject({ deletedAt: null });
      },
    );

    it('does not permit shared-link deletion even under the owning user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: video.id });
      await expect(
        sut.unlinkAndDeleteLivePhoto(AuthFactory.from({ id: user.id }).sharedLink().build(), photo.id),
      ).rejects.toThrow();
      expect(await ctx.get(AssetRepository).getById(photo.id)).toMatchObject({ livePhotoVideoId: video.id });
    });
  });

  describe('shared space permissions', () => {
    describe('asset access by role', () => {
      it('should allow asset read for any space member', async () => {
        const { sut, ctx } = setup();
        const { user: owner } = await ctx.newUser();
        const { user: viewer } = await ctx.newUser();
        const { space } = await ctx.newSharedSpace({ createdById: owner.id });
        const { asset } = await ctx.newAsset({ ownerId: owner.id });

        // Add asset to space
        await ctx.newSharedSpaceAsset({ spaceId: space.id, assetId: asset.id, addedById: owner.id });

        // Add viewer member to space
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: viewer.id, role: 'viewer' });

        const auth = factory.auth({ user: { id: viewer.id } });

        // Should be able to read asset
        await expect(sut.get(auth, asset.id)).resolves.toBeDefined();
      });

      it('should deny asset edit if user is VIEWER role', async () => {
        const { sut, ctx } = setup();
        ctx.getMock(JobRepository).queue.mockResolvedValue();
        const { user: owner } = await ctx.newUser();
        const { user: viewer } = await ctx.newUser();
        const { space } = await ctx.newSharedSpace({ createdById: owner.id });
        const { asset } = await ctx.newAsset({ ownerId: owner.id });

        // Add asset to space
        await ctx.newSharedSpaceAsset({ spaceId: space.id, assetId: asset.id, addedById: owner.id });

        // #734 spec §2.3: checkSpaceEditAccess requires the asset's owner to also be a member of
        // the space granting the caller their role — see the EDITOR test below for the full
        // rationale. Without this row the denial would come from the owner-is-member EXISTS, not
        // from the role gate this test is meant to cover.
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: owner.id, role: 'owner' });

        // Add viewer member to space
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: viewer.id, role: 'viewer' });

        const auth = factory.auth({ user: { id: viewer.id } });

        // Should NOT be able to edit asset
        await expect(sut.update(auth, asset.id, { description: 'new' })).rejects.toThrow();
      });

      it('should allow asset edit if user is EDITOR role', async () => {
        const { sut, ctx } = setup();
        ctx.getMock(JobRepository).queue.mockResolvedValue();
        const { user: owner } = await ctx.newUser();
        const { user: editor } = await ctx.newUser();
        const { space } = await ctx.newSharedSpace({ createdById: owner.id });
        const { asset } = await ctx.newAsset({ ownerId: owner.id });

        // Add asset to space
        await ctx.newSharedSpaceAsset({ spaceId: space.id, assetId: asset.id, addedById: owner.id });

        // #734 spec §2.3: checkSpaceEditAccess requires the asset's owner to also be a member of
        // the space granting the caller their role — an editor may act on a fellow MEMBER's
        // asset, not on any asset merely reachable through the space. Without this row the owner
        // isn't a member, so this test would assert the pre-#734 behaviour instead of the
        // scenario it's meant to cover.
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: owner.id, role: 'owner' });

        // Add editor member to space
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: editor.id, role: 'editor' });

        const auth = factory.auth({ user: { id: editor.id } });

        // Should be able to edit asset
        await expect(sut.update(auth, asset.id, { description: 'new' })).resolves.toBeDefined();
      });

      it('should allow asset edit if user is ADMIN role', async () => {
        const { sut, ctx } = setup();
        ctx.getMock(JobRepository).queue.mockResolvedValue();
        const { user: owner } = await ctx.newUser();
        const { user: admin } = await ctx.newUser();
        const { space } = await ctx.newSharedSpace({ createdById: owner.id });
        const { asset } = await ctx.newAsset({ ownerId: owner.id });

        // Add asset to space
        await ctx.newSharedSpaceAsset({ spaceId: space.id, assetId: asset.id, addedById: owner.id });

        // #734 spec §2.3: checkSpaceEditAccess requires the asset's owner to also be a member of
        // the space granting the caller their role — see the EDITOR test above for the full
        // rationale.
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: owner.id, role: 'owner' });

        // Add admin member to space
        await ctx.newSharedSpaceMember({ spaceId: space.id, userId: admin.id, role: 'owner' });

        const auth = factory.auth({ user: { id: admin.id } });

        // Should be able to edit asset
        await expect(sut.update(auth, asset.id, { description: 'new' })).resolves.toBeDefined();
      });
    });

    describe('asset access control on lifecycle', () => {
      it('should deny access when user is removed from space', async () => {
        const { sut, ctx } = setup();
        const { user: owner } = await ctx.newUser();
        const { user: member } = await ctx.newUser();
        const { space } = await ctx.newSharedSpace({ createdById: owner.id });
        const { asset } = await ctx.newAsset({ ownerId: owner.id });

        // Add asset to space
        await ctx.newSharedSpaceAsset({ spaceId: space.id, assetId: asset.id, addedById: owner.id });

        // Add member to space
        await ctx.newSharedSpaceMember({
          spaceId: space.id,
          userId: member.id,
          role: 'editor',
        });

        const auth = factory.auth({ user: { id: member.id } });

        // Can access while member
        await expect(sut.get(auth, asset.id)).resolves.toBeDefined();

        // Remove from space
        await defaultDatabase
          .deleteFrom('shared_space_member')
          .where('spaceId', '=', space.id)
          .where('userId', '=', member.id)
          .execute();

        // Can't access after removal
        await expect(sut.get(auth, asset.id)).rejects.toThrow();
      });
    });

    describe('non-space assets', () => {
      it('should allow owner to access asset not in space', async () => {
        const { sut, ctx } = setup();
        const { user: owner } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: owner.id });

        const auth = factory.auth({ user: { id: owner.id } });

        // Owner should be able to access their own asset
        await expect(sut.get(auth, asset.id)).resolves.toBeDefined();
      });

      it('should deny non-owner access to asset not in space', async () => {
        const { sut, ctx } = setup();
        const { user: owner } = await ctx.newUser();
        const { user: other } = await ctx.newUser();
        const { asset } = await ctx.newAsset({ ownerId: owner.id });

        const auth = factory.auth({ user: { id: other.id } });

        // Non-owner should NOT be able to access asset not in space
        await expect(sut.get(auth, asset.id)).rejects.toThrow();
      });
    });
  });
});
