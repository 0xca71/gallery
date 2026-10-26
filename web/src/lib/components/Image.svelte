<script lang="ts">
  import { isFirefox } from '$lib/utils/asset-utils';
  import { cancelImageUrl } from '$lib/utils/sw-messaging';
  import { onDestroy, untrack } from 'svelte';
  import type { HTMLImgAttributes } from 'svelte/elements';

  type Props = Omit<HTMLImgAttributes, 'onload' | 'onerror'> & {
    src: string | undefined;
    decodeBeforeLoad?: boolean;
    onStart?: () => void;
    onLoad?: () => void;
    onError?: (error: Error) => void;
    ref?: HTMLImageElement;
  };

  let {
    src,
    decodeBeforeLoad = false,
    onStart,
    onLoad,
    onError,
    ref = $bindable(),
    crossorigin = 'anonymous',
    ...rest
  }: Props = $props();

  let capturedSource: string | undefined = $state();
  let loaded = $state(false);
  let destroyed = false;

  $effect(() => {
    // gallery-fork: re-capture whenever the source CHANGES (not only on first
    // capture) and release the previous object URL, in upstream's early-return shape.
    if (src === undefined || src === capturedSource) {
      return;
    }

    const oldSource = capturedSource;
    capturedSource = src;
    loaded = false;
    untrack(() => {
      if (oldSource !== undefined) {
        cancelImageUrl(oldSource);
      }
      onStart?.();
    });
  });

  onDestroy(() => {
    destroyed = true;
    if (capturedSource !== undefined) {
      cancelImageUrl(capturedSource);
    }
  });

  const completeLoad = () => {
    if (destroyed) {
      return;
    }
    loaded = true;
    onLoad?.();
  };

  const handleLoad = async () => {
    if (destroyed || !src) {
      return;
    }

    if (!decodeBeforeLoad && !isFirefox) {
      completeLoad();
      return;
    }
    const source = capturedSource;
    const image = ref;
    try {
      await image?.decode();
      if (!destroyed && source === capturedSource && image === ref) {
        completeLoad();
      }
    } catch {
      if (!destroyed && source === capturedSource && image === ref) {
        if (decodeBeforeLoad) {
          handleError();
        } else {
          completeLoad();
        }
      }
    }
  };

  const handleError = () => {
    if (destroyed || !src) {
      return;
    }
    onError?.(new Error(`Failed to load image: ${src}`));
  };
</script>

{#if capturedSource}
  {#key capturedSource}
    <img
      bind:this={ref}
      src={capturedSource}
      {crossorigin}
      {...rest}
      style:visibility={isFirefox && !loaded ? 'hidden' : undefined}
      onload={handleLoad}
      onerror={handleError}
    />
  {/key}
{/if}
