import { getAssetInfo, unlinkAndDeleteLivePhoto, updateAsset } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import LinkLivePhotoAction from './LinkLivePhotoAction.svelte';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAssetInfo: vi.fn(),
  updateAsset: vi.fn(),
  unlinkAndDeleteLivePhoto: vi.fn(),
}));
vi.mock('$lib/managers/asset-multi-select-manager.svelte', () => ({
  assetMultiSelectManager: { ownedAssets: [], clear: vi.fn() },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('@immich/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/ui')>()),
  modalManager: { showDialog: vi.fn() },
}));

describe('LinkLivePhotoAction', () => {
  const photo = assetFactory.build({ id: 'photo-id', livePhotoVideoId: 'video-id' });
  const unlinkedPhoto = { ...photo, livePhotoVideoId: null };
  const onLink = vi.fn();
  const onUnlink = vi.fn();
  const onUnlinkAndDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    assetMultiSelectManager.ownedAssets = [toTimelineAsset(photo)];
    vi.mocked(modalManager.showDialog).mockResolvedValue(true);
    vi.mocked(unlinkAndDeleteLivePhoto).mockResolvedValue(unlinkedPhoto);
    vi.mocked(updateAsset).mockResolvedValue(unlinkedPhoto);
  });

  const render = (deleteVideo = true) =>
    renderWithTooltips(LinkLivePhotoAction, {
      menuItem: true,
      unlink: true,
      deleteVideo,
      onLink,
      onUnlink,
      onUnlinkAndDelete,
    });

  it('confirms deletion and updates the photo without fetching or restoring the video', async () => {
    render();
    await fireEvent.click(screen.getByText('unlink_and_delete_motion_video'));
    await waitFor(() =>
      expect(onUnlinkAndDelete).toHaveBeenCalledWith({
        still: toTimelineAsset(unlinkedPhoto),
        motionId: 'video-id',
      }),
    );
    expect(modalManager.showDialog).toHaveBeenCalled();
    expect(unlinkAndDeleteLivePhoto).toHaveBeenCalledWith({ id: 'photo-id' });
    expect(updateAsset).not.toHaveBeenCalled();
    expect(getAssetInfo).not.toHaveBeenCalled();
    expect(onUnlink).not.toHaveBeenCalled();
    expect(assetMultiSelectManager.clear).toHaveBeenCalled();
  });

  it('keeps the selection and assets when deletion is cancelled', async () => {
    vi.mocked(modalManager.showDialog).mockResolvedValue(false);
    render();
    await fireEvent.click(screen.getByText('unlink_and_delete_motion_video'));
    await waitFor(() => expect(modalManager.showDialog).toHaveBeenCalled());
    expect(unlinkAndDeleteLivePhoto).not.toHaveBeenCalled();
    expect(onUnlinkAndDelete).not.toHaveBeenCalled();
    expect(assetMultiSelectManager.clear).not.toHaveBeenCalled();
  });

  it('preserves the original unlink-only action', async () => {
    const video = assetFactory.build({ id: 'video-id' });
    vi.mocked(getAssetInfo).mockResolvedValue(video);
    render(false);
    await fireEvent.click(screen.getByText('unlink_motion_video'));
    await waitFor(() =>
      expect(onUnlink).toHaveBeenCalledWith({
        still: toTimelineAsset(unlinkedPhoto),
        motion: toTimelineAsset(video),
      }),
    );
    expect(updateAsset).toHaveBeenCalledWith({ id: 'photo-id', updateAssetDto: { livePhotoVideoId: null } });
    expect(unlinkAndDeleteLivePhoto).not.toHaveBeenCalled();
    expect(modalManager.showDialog).not.toHaveBeenCalled();
  });

  it('does not remove assets from the timeline when the API fails', async () => {
    vi.mocked(unlinkAndDeleteLivePhoto).mockRejectedValue(new Error('Video is shared'));
    render();
    await fireEvent.click(screen.getByText('unlink_and_delete_motion_video'));
    await waitFor(() => expect(unlinkAndDeleteLivePhoto).toHaveBeenCalled());
    expect(onUnlinkAndDelete).not.toHaveBeenCalled();
    expect(assetMultiSelectManager.clear).not.toHaveBeenCalled();
  });
});
