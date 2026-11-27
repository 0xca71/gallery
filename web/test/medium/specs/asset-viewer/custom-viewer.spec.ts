import { Route } from '#lib/route.ts';
import { factory } from '#test/common/factories.ts';
import { test as base, expect } from '#test/medium/fixtures.ts';
import { galleryInitScript } from '#test/medium/gallery/init.ts';
import {
  AssetEditAction,
  AssetEditSaveFormat,
  AssetEditSaveMode,
  AssetEditSaveStatus,
  AssetTypeEnum,
} from '@immich/sdk';
import type { Page } from '@playwright/test';

const test = base.extend({
  workerContext: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({
        baseURL: workerInfo.project.use.baseURL,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        locale: 'en-US',
        timezoneId: 'UTC',
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
      });
      await context.addInitScript(() => {
        if (location.protocol.startsWith('http')) localStorage.setItem('lang', 'dev');
      });
      await context.addInitScript(galleryInitScript);
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],
});

const zoomIntoPhoto = async (page: Page) => {
  const image = page.getByTestId('viewer-content').getByTestId('preview');
  const box = await image.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Alt');
  await expect(page.getByRole('toolbar', { name: 'photo_navigator', exact: true })).toBeVisible();
};

test.describe('custom viewer on mobile web', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('photo tap toggles the filmstrip and selecting a neighbor changes the viewed asset', async ({
    page,
    data,
    app,
  }) => {
    const assets = data.addTimeline({ years: 1 });
    const asset = assets.find((item) => item.type === AssetTypeEnum.Image)!;
    await page.goto(Route.viewAsset({ id: asset.id }));
    await app.viewer.waitForAsset(asset);
    await expect(app.viewer.nextButton).toBeVisible();
    const strip = page.getByRole('listbox', { name: 'photos', exact: true });
    const wasVisible = await strip.isVisible();
    await app.viewer.image('preview').tap();
    if (wasVisible) {
      await expect(strip).toBeHidden();
      await app.viewer.image('preview').tap();
    }
    await expect(strip).toBeVisible();
    const neighbor = strip.locator('[data-filmstrip-asset][aria-selected="false"]').first();
    const id = await neighbor.getAttribute('data-filmstrip-asset');
    const selected = assets.find((item) => item.id === id)!;
    expect(selected.id).not.toBe(asset.id);
    await neighbor.scrollIntoViewIfNeeded();
    await neighbor.tap();
    await app.viewer.waitForAsset(selected);
    await expect(page).toHaveURL(Route.viewAsset({ id: selected.id }));
    await page.screenshot({ path: '/tmp/gallery-integration-filmstrip.png' });
  });

  test('navigator crop saves directly with the current Adjust snapshot and no duplicated crop', async ({
    page,
    data,
    api,
    app,
  }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Image, canEdit: true });
    data.addAssets(asset);
    const adjust = { exposure: 0.5, contrast: 8, saturation: 12, invert: true };
    const operation = {
      id: crypto.randomUUID(),
      assetId: asset.id,
      resultAssetId: asset.id,
      mode: AssetEditSaveMode.Overwrite,
      status: AssetEditSaveStatus.Queued,
      error: null,
    };
    api.on({
      getAssetEditSaveCapabilities: () => ({
        json: {
          canCopy: true,
          canOverwrite: true,
          overwriteUnavailableReason: null,
          outputFormat: AssetEditSaveFormat.Jpeg,
        },
      }),
      getAssetAdjust: () => ({ json: adjust }),
      saveAssetEdits: () => ({ json: operation }),
      getAssetEditSave: () => ({ json: { ...operation, status: AssetEditSaveStatus.Completed } }),
      getAssetEdits: () => ({ json: { edits: [] } }),
    });
    await page.goto(Route.viewAsset({ id: asset.id }));
    await app.viewer.waitForAsset(asset);
    await zoomIntoPhoto(page);
    await page.screenshot({ path: '/tmp/gallery-integration-navigator.png' });
    await page
      .getByRole('toolbar', { name: 'photo_navigator', exact: true })
      .getByRole('button', { name: 'crop', exact: true })
      .click();
    expect(api.saveAssetEdits).toHaveBeenCalledWith({
      params: { id: asset.id },
      body: expect.objectContaining({
        mode: AssetEditSaveMode.Overwrite,
        adjust,
        edits: [expect.objectContaining({ action: AssetEditAction.Crop })],
      }),
    });
    expect(api.getAssetEditSave).toHaveBeenCalledWith({ params: { id: asset.id, operationId: operation.id } });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(Route.viewAsset({ id: asset.id }));
  });

  test('a read-only shared asset has a navigator but no crop action', async ({ page, data, app }) => {
    const asset = factory.asset({ type: AssetTypeEnum.Image, ownerId: crypto.randomUUID(), canEdit: false });
    data.addAssets(asset);
    await page.goto(Route.viewAsset({ id: asset.id }));
    await app.viewer.waitForAsset(asset);
    await zoomIntoPhoto(page);
    await expect(
      page
        .getByRole('toolbar', { name: 'photo_navigator', exact: true })
        .getByRole('button', { name: 'crop', exact: true }),
    ).toHaveCount(0);
  });
});
