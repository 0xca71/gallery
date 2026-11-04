<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import { transformManager } from '$lib/managers/edit/transform-manager.svelte';
  import { Button, HStack, IconButton } from '@immich/ui';
  import { mdiFlipHorizontal, mdiFlipVertical, mdiRotateLeft, mdiRotateRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface AspectRatioOption {
    label: string;
    value: string;
    width?: number;
    height?: number;
    isFree?: boolean;
  }

  const aspectRatios: AspectRatioOption[] = [
    { label: $t('crop_aspect_ratio_free'), value: 'free', isFree: true },
    { label: $t('crop_aspect_ratio_original'), value: 'original', width: 24, height: 18 },
    { label: '5:4', value: '5:4', width: 22, height: 18 },
    { label: '4:5', value: '4:5', width: 18, height: 22 },
    { label: '4:3', value: '4:3', width: 24, height: 18 },
    { label: '3:4', value: '3:4', width: 18, height: 24 },
    { label: '3:2', value: '3:2', width: 24, height: 16 },
    { label: '2:3', value: '2:3', width: 16, height: 24 },
    { label: '16:9', value: '16:9', width: 24, height: 14 },
    { label: '9:16', value: '9:16', width: 14, height: 24 },
    { label: $t('crop_aspect_ratio_square'), value: '1:1', width: 20, height: 20 },
  ];

  let isRotated = $derived(transformManager.normalizedBaseRotation % 180 !== 0);
  let formattedFineAngle = $derived(
    `${transformManager.fineRotation > 0 ? '+' : ''}${transformManager.fineRotation.toFixed(1)}°`,
  );

  function rotatedRatio(ratio: AspectRatioOption): string {
    if (ratio.value === 'free') {
      return ratio.value;
    }

    if (isRotated) {
      let [width, height] = ratio.value.split(':', 2);
      return `${height}:${width}`;
    }
    return ratio.value;
  }

  function ratioSelected(ratio: AspectRatioOption): boolean {
    const currentRatioRotated = rotatedRatio(ratio);

    return transformManager.cropAspectRatio === currentRatioRotated;
  }

  function selectAspectRatio(ratio: AspectRatioOption) {
    let appliedRatio;
    if (ratio.value === 'original') {
      const { width, height } = transformManager.cropImageSize;
      appliedRatio = `${width}:${height}`;
    } else {
      appliedRatio = rotatedRatio(ratio);
    }

    transformManager.setAspectRatio(appliedRatio);
  }

  async function rotateImage(degrees: number) {
    await transformManager.rotate(degrees);
  }

  function mirrorImage(axis: 'horizontal' | 'vertical') {
    transformManager.mirror(axis);
  }
</script>

<svelte:document
  use:shortcuts={[
    { shortcut: { key: ']' }, onShortcut: () => rotateImage(90) },
    { shortcut: { key: '[' }, onShortcut: () => rotateImage(-90) },
  ]}
/>

<div class="mt-3 px-4">
  <div class="mt-2 flex h-10 w-full items-center justify-between text-sm">
    <h2>{$t('editor_orientation')}</h2>
    <button
      type="button"
      class="rounded-full px-2 py-0.5 font-mono text-xs transition {transformManager.fineRotation === 0
        ? 'text-gray-400'
        : 'bg-immich-dark-primary/20 text-immich-dark-primary hover:bg-immich-dark-primary/30'}"
      onclick={() => transformManager.setFineRotation(0)}
      disabled={transformManager.fineRotation === 0}
      aria-label={formattedFineAngle}
    >
      {formattedFineAngle}
    </button>
  </div>
  <HStack>
    <IconButton
      class="w-full"
      size="small"
      aria-label={$t('editor_rotate_left')}
      icon={mdiRotateLeft}
      onclick={() => rotateImage(-90)}
    />
    <IconButton
      class="w-full"
      size="small"
      aria-label={$t('editor_rotate_right')}
      icon={mdiRotateRight}
      onclick={() => rotateImage(90)}
    />
    <IconButton
      class="w-full"
      size="small"
      aria-label={$t('editor_flip_horizontal')}
      icon={mdiFlipHorizontal}
      onclick={() => mirrorImage('horizontal')}
    />
    <IconButton
      class="w-full"
      size="small"
      aria-label={$t('editor_flip_vertical')}
      icon={mdiFlipVertical}
      onclick={() => mirrorImage('vertical')}
    />
  </HStack>

  <div class="mt-3">
    <input
      type="range"
      min="-45"
      max="45"
      step="0.1"
      value={transformManager.fineRotation}
      aria-label={$t('editor_orientation')}
      class="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-gray-700 accent-immich-dark-primary"
      onpointerdown={() => (transformManager.isInteracting = true)}
      onpointerup={() => (transformManager.isInteracting = false)}
      onpointercancel={() => (transformManager.isInteracting = false)}
      onblur={() => (transformManager.isInteracting = false)}
      ondblclick={() => transformManager.setFineRotation(0)}
      oninput={(e) => transformManager.setFineRotation(Number((e.currentTarget as HTMLInputElement).value))}
    />
    <div class="mt-1 flex justify-between px-0.5 font-mono text-[10px] text-gray-400 select-none">
      <span>-45°</span>
      <span>-15°</span>
      <span>0°</span>
      <span>+15°</span>
      <span>+45°</span>
    </div>
  </div>

  <div class="mt-6 flex h-10 w-full items-center justify-between text-sm">
    <h2>{$t('crop')}</h2>
  </div>

  <!-- Aspect Ratio Grid -->
  <div class="mb-4 grid grid-cols-2">
    {#each aspectRatios as ratio (ratio.value)}
      <HStack>
        <Button
          class="m-2 size-14"
          shape="round"
          onclick={() => selectAspectRatio(ratio)}
          aria-label={ratio.label}
          color={ratioSelected(ratio) ? 'primary' : 'secondary'}
          variant={ratioSelected(ratio) ? 'filled' : 'outline'}
        >
          {#if ratio.isFree}
            <!-- Free crop icon with dashed border -->
            <div
              class="size-6 shrink-0 rounded-xs border-2 border-dashed {ratioSelected(ratio)
                ? 'border-black'
                : 'border-white'}"
            ></div>
          {:else}
            <!-- Aspect ratio box -->
            <div
              class="shrink-0 rounded-xs border-2 {ratioSelected(ratio) ? 'border-black' : 'border-white'}"
              style="width: {ratio.width}px; height: {ratio.height}px;"
            ></div>
          {/if}
        </Button>
        <span class="text-sm text-white">{ratio.label}</span>
      </HStack>
    {/each}
  </div>
</div>
