import type { ServerConfigDto } from '@immich/sdk';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';

export const DELETE_TOAST_THRESHOLD_DEFAULT = 20;

export const getDeleteToastThreshold = () => {
  try {
    const config = serverConfigManager.value as ServerConfigDto & { webDeleteToastThreshold?: number };
    return config.webDeleteToastThreshold ?? DELETE_TOAST_THRESHOLD_DEFAULT;
  } catch {
    return DELETE_TOAST_THRESHOLD_DEFAULT;
  }
};

export const getDeleteToastOptions = (count: number, threshold: number) => ({
  timeout: count > threshold ? 0 : 5000,
  closable: true,
});
