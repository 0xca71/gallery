import { queryClient } from '#lib/queries/client.ts';
import { getPublicConfigQuery } from '#lib/queries/config-public.query.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { toastManager } from '@immich/ui';
import { describe, expect, it } from 'vitest';
import { deleteAssets } from './actions';
import { getDeleteToastOptions } from './delete-toast';

describe('getDeleteToastOptions', () => {
  it('keeps the existing timeout at the threshold', () => {
    expect(getDeleteToastOptions(20, 20)).toEqual({ timeout: 5000, closable: true });
  });

  it('keeps the toast open above the threshold', () => {
    expect(getDeleteToastOptions(21, 20)).toEqual({ timeout: 0, closable: true });
  });

  it('uses a custom threshold', () => {
    expect(getDeleteToastOptions(43, 42)).toEqual({ timeout: 0, closable: true });
  });
});

test('the successful bulk delete consumer uses the configured persistent notice and keeps Undo', async ({ api }) => {
  const config = queryClient.getQueryData(getPublicConfigQuery().queryKey)!;
  queryClient.setQueryData(getPublicConfigQuery().queryKey, { ...config, webDeleteToastThreshold: 42 });
  const assets = Array.from({ length: 43 }, () => factory.timelineAsset());
  api.on({ deleteAssets: () => ({ status: 204 }), restoreAssets: () => ({ json: { count: assets.length } }) });
  const notice = vi.spyOn(toastManager, 'primary');
  const onDelete = vi.fn();
  const onUndo = vi.fn();
  await deleteAssets(false, onDelete, assets, onUndo);
  expect(api.deleteAssets).toHaveBeenCalledWith({ body: { ids: assets.map(({ id }) => id), force: false } });
  expect(onDelete).toHaveBeenCalledWith(assets.map(({ id }) => id));
  expect(notice.mock.calls[0]?.[1]).toMatchObject({ timeout: 0, closable: true });
  const message = notice.mock.calls[0]?.[0];
  expect(typeof message).toBe('object');
  if (typeof message === 'object' && 'button' in message) {
    const close = vi.fn();
    const button = typeof message.button === 'function' ? message.button(close) : message.button;
    expect(button).toBeDefined();
    await button?.onclick();
  }
  await vi.waitFor(() => expect(onUndo).toHaveBeenCalledWith(assets));
  expect(api.restoreAssets).toHaveBeenCalledWith({ body: { ids: assets.map(({ id }) => id) } });
  notice.mockRestore();
});
