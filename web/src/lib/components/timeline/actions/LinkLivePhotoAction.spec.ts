import { assetMultiSelectManager } from '#lib/managers/asset-multi-select-manager.svelte.ts';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { toTimelineAsset } from '#lib/utils/timeline-util.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';
import LinkLivePhotoAction from './LinkLivePhotoAction.svelte';

test.beforeEach(async () => {
  await authManager.load();
  assetMultiSelectManager.clear();
});
test.afterEach(() => {
  assetMultiSelectManager.clear();
  vi.restoreAllMocks();
});

test('confirms permanent video deletion without restoring or fetching the motion asset', async ({ api }) => {
  const photo = factory.asset({ ownerId: authManager.user.id, livePhotoVideoId: crypto.randomUUID() });
  const updated = { ...photo, livePhotoVideoId: null };
  api.on({ unlinkAndDeleteLivePhoto: () => ({ json: updated }) });
  assetMultiSelectManager.selectAsset(toTimelineAsset(photo));
  const onUnlinkAndDelete = vi.fn();
  await render(LinkLivePhotoAction, {
    menuItem: true,
    unlink: true,
    deleteVideo: true,
    onLink: vi.fn(),
    onUnlink: vi.fn(),
    onUnlinkAndDelete,
  });
  await userEvent.click(page.getByRole('menuitem'));
  await userEvent.click(page.getByRole('button', { name: get(t)('permanently_delete'), exact: true }));
  await vi.waitFor(() =>
    expect(onUnlinkAndDelete).toHaveBeenCalledWith({
      still: toTimelineAsset(updated),
      motionId: photo.livePhotoVideoId,
    }),
  );
  expect(api.unlinkAndDeleteLivePhoto).toHaveBeenCalledWith({ params: { id: photo.id } });
  expect(api.updateAsset).not.toHaveBeenCalled();
  expect(api.getAssetInfo).not.toHaveBeenCalled();
  expect(assetMultiSelectManager.selectionActive).toBe(false);
});

test('cancel leaves the association and selection intact', async ({ api }) => {
  const photo = factory.asset({ ownerId: authManager.user.id, livePhotoVideoId: crypto.randomUUID() });
  assetMultiSelectManager.selectAsset(toTimelineAsset(photo));
  const onUnlinkAndDelete = vi.fn();
  await render(LinkLivePhotoAction, {
    menuItem: true,
    unlink: true,
    deleteVideo: true,
    onLink: vi.fn(),
    onUnlink: vi.fn(),
    onUnlinkAndDelete,
  });
  await userEvent.click(page.getByRole('menuitem'));
  await userEvent.click(page.getByRole('button', { name: get(t)('cancel'), exact: true }));
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
  expect(api.unlinkAndDeleteLivePhoto).not.toHaveBeenCalled();
  expect(onUnlinkAndDelete).not.toHaveBeenCalled();
  expect(assetMultiSelectManager.hasSelectedAsset(photo.id)).toBe(true);
});

test('plain unlink still restores the video through the official update/read flow', async ({ api }) => {
  const video = factory.asset({ ownerId: authManager.user.id });
  const photo = factory.asset({ ownerId: authManager.user.id, livePhotoVideoId: video.id });
  const updated = { ...photo, livePhotoVideoId: null };
  api.on({ updateAsset: () => ({ json: updated }), getAssetInfo: () => ({ json: video }) });
  assetMultiSelectManager.selectAsset(toTimelineAsset(photo));
  const onUnlink = vi.fn();
  await render(LinkLivePhotoAction, { menuItem: true, unlink: true, onLink: vi.fn(), onUnlink });
  await userEvent.click(page.getByRole('menuitem'));
  await vi.waitFor(() =>
    expect(onUnlink).toHaveBeenCalledWith({ still: toTimelineAsset(updated), motion: toTimelineAsset(video) }),
  );
  expect(api.unlinkAndDeleteLivePhoto).not.toHaveBeenCalled();
  expect(api.updateAsset).toHaveBeenCalledWith({ params: { id: photo.id }, body: { livePhotoVideoId: null } });
  expect(api.getAssetInfo).toHaveBeenCalledWith({ params: { id: video.id } });
});

test('a rejected delete leaves the still and selection unchanged', async ({ api, logger }) => {
  const photo = factory.asset({ ownerId: authManager.user.id, livePhotoVideoId: crypto.randomUUID() });
  assetMultiSelectManager.selectAsset(toTimelineAsset(photo));
  api.on({
    unlinkAndDeleteLivePhoto: () => ({ status: 409, json: { message: 'Video is still linked', statusCode: 409 } }),
  });
  const onUnlinkAndDelete = vi.fn();
  await render(LinkLivePhotoAction, {
    menuItem: true,
    unlink: true,
    deleteVideo: true,
    onLink: vi.fn(),
    onUnlink: vi.fn(),
    onUnlinkAndDelete,
  });
  await userEvent.click(page.getByRole('menuitem'));
  await userEvent.click(page.getByRole('button', { name: get(t)('permanently_delete'), exact: true }));
  expect(api.unlinkAndDeleteLivePhoto).toHaveBeenCalledWith({ params: { id: photo.id } });
  expect(logger.error).toHaveBeenCalledWith(/\[handleError\].*Error: 409/);
  await vi.waitFor(() => expect(logger.error.calls.length).toBeGreaterThan(0));
  expect(onUnlinkAndDelete).not.toHaveBeenCalled();
  expect(assetMultiSelectManager.hasSelectedAsset(photo.id)).toBe(true);
});
