import { AssetEditSaveMode } from '@immich/sdk';
import '@testing-library/jest-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import AssetEditSaveModal from './AssetEditSaveModal.svelte';

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 30));
});

describe('image save selection', () => {
  const capabilities = { canCopy: true, canOverwrite: true, overwriteUnavailableReason: null, outputFormat: 'png' };

  it('defaults to an independent copy', async () => {
    const onClose = vi.fn();
    render(AssetEditSaveModal, { capabilities, onClose });
    expect(screen.getAllByRole('radio')[0]).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'editor_save_copy' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(AssetEditSaveMode.Copy));
  });

  it('cancels without choosing either save mode', async () => {
    const onClose = vi.fn();
    render(AssetEditSaveModal, { capabilities, onClose });
    await userEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(null));
  });

  it('requires selecting overwrite before replacing the original', async () => {
    const onClose = vi.fn();
    render(AssetEditSaveModal, { capabilities, onClose });
    await userEvent.click(screen.getAllByRole('radio')[1]);
    await userEvent.click(screen.getByRole('button', { name: 'editor_save_overwrite' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(AssetEditSaveMode.Overwrite));
  });

  it('disables overwrite and explains a read-only external source', () => {
    render(AssetEditSaveModal, {
      capabilities: { ...capabilities, canOverwrite: false, overwriteUnavailableReason: 'not_writable' },
      onClose: vi.fn(),
    });
    expect(screen.getAllByRole('radio')[1]).toBeDisabled();
    expect(screen.getByText('editor_save_unavailable_not_writable')).toBeInTheDocument();
  });
});
