import { queryClient } from '#lib/queries/client.ts';
import { getPublicConfigQuery } from '#lib/queries/config-public.query.ts';

export const DELETE_TOAST_THRESHOLD_DEFAULT = 20;

export const getDeleteToastThreshold = () => {
  const config = queryClient.getQueryData(getPublicConfigQuery().queryKey);
  return config?.webDeleteToastThreshold ?? DELETE_TOAST_THRESHOLD_DEFAULT;
};

export const getDeleteToastOptions = (count: number, threshold: number) => ({
  timeout: count > threshold ? 0 : 5000,
  closable: true,
});
