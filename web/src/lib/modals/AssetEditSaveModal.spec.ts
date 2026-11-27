import { renderWithTooltips } from '#test/unit/helpers.ts';
import { AssetEditSaveFormat, AssetEditSaveMode } from '@immich/sdk';
import { page } from 'vitest/browser';
import AssetEditSaveModal from './AssetEditSaveModal.svelte';

const capabilities = {
  canCopy: true,
  canOverwrite: true,
  overwriteUnavailableReason: null,
  outputFormat: AssetEditSaveFormat.Png,
} as const;

describe('image save selection', () => {
  it('defaults to a separate copy and submits it', async () => {
    const onClose = vi.fn();
    await renderWithTooltips(AssetEditSaveModal, { capabilities, onClose });
    await expect.element(page.getByRole('radio').nth(0)).toBeChecked();
    await page.getByRole('button', { name: 'editor_save_copy', exact: true }).click();
    await expect.poll(() => onClose.mock.calls).toEqual([[AssetEditSaveMode.Copy]]);
  });

  it('cancels without saving', async () => {
    const onClose = vi.fn();
    await renderWithTooltips(AssetEditSaveModal, { capabilities, onClose });
    await page.getByRole('button', { name: 'cancel', exact: true }).click();
    await expect.poll(() => onClose.mock.calls).toEqual([[null]]);
  });

  it('requires explicitly selecting overwrite', async () => {
    const onClose = vi.fn();
    await renderWithTooltips(AssetEditSaveModal, { capabilities, onClose });
    await page.getByRole('radio').nth(1).click();
    await page.getByRole('button', { name: 'editor_save_overwrite', exact: true }).click();
    await expect.poll(() => onClose.mock.calls).toEqual([[AssetEditSaveMode.Overwrite]]);
  });

  it.each(['not_writable', 'unsupported_format', 'save_in_progress'] as const)(
    'explains unavailable overwrite: %s',
    async (reason) => {
      await renderWithTooltips(AssetEditSaveModal, {
        capabilities: {
          ...capabilities,
          canOverwrite: false,
          overwriteUnavailableReason: reason,
        },
        onClose: vi.fn(),
      });
      await expect.element(page.getByRole('radio').nth(1)).toBeDisabled();
      await expect.element(page.getByText(`editor_save_unavailable_${reason}`)).toBeVisible();
    },
  );
});
