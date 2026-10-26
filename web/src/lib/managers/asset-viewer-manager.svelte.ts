import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import type { ZoomImageWheelState } from '@zoom-image/core';
import { cubicOut } from 'svelte/easing';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userPreferencesManager } from '$lib/managers/user-preferences-manager.svelte';
import type { ImageLoaderStatus } from '$lib/utils/adaptive-image-loader.svelte';
import { canCopyImageToClipboard } from '$lib/utils/asset-utils';
import { BaseEventManager } from '$lib/utils/base-event-manager.svelte';
import type { AssetGridRouteSearchParams } from '$lib/utils/navigation';
import { zoomAt } from '$lib/utils/zoom-geometry';

export interface Faces {
  id: string;
  imageHeight: number;
  imageWidth: number;
  boundingBoxX1: number;
  boundingBoxX2: number;
  boundingBoxY1: number;
  boundingBoxY2: number;
}

const createDefaultZoomState = (): ZoomImageWheelState => ({
  currentRotation: 0,
  currentZoom: 1,
  enable: true,
  currentPositionX: 0,
  currentPositionY: 0,
});

export type Events = {
  Zoom: [];
  ZoomChange: [ZoomImageWheelState];
  Copy: [];
  FaceEditModeChange: [boolean];
};

class AssetViewerManager extends BaseEventManager<Events> {
  #zoomState = $state(createDefaultZoomState());
  #animationFrameId: number | null = null;

  zoomViewport = $state({ width: 0, height: 0 });
  imgRef = $state<HTMLImageElement | undefined>();
  imageLoaderStatus = $state<ImageLoaderStatus | undefined>();
  #isImageLoading = $derived.by(() => {
    const quality = this.imageLoaderStatus?.quality;
    if (!quality || this.imageLoaderStatus?.hasError) {
      return false;
    }
    const previewOrOriginalReady = quality.preview === 'success' || quality.original === 'success';
    const loadingOriginal = this.zoom > 1 && quality.original === 'unloaded';
    return (!previewOrOriginalReady && quality.preview === 'unloaded') || loadingOriginal;
  });
  isShowActivityPanel = $state(false);
  isPlayingMotionPhoto = $state(false);
  isShowEditor = $state(false);
  #isFaceEditMode = $state(false);
  #isEditFacesPanelOpen = $state(false);
  #viewingAssetStoreState = $state<AssetResponseDto>();
  #viewState = $state<boolean>(false);
  #highlightedFaces = $state<Faces[]>([]);
  #showingHiddenPeople = $state(false);
  gridScrollTarget = $state<AssetGridRouteSearchParams | null | undefined>();

  get asset() {
    return this.#viewingAssetStoreState;
  }

  get isViewing() {
    return this.#viewState;
  }

  get isImageLoading() {
    return this.#isImageLoading;
  }

  get isShowDetailPanel() {
    return userPreferencesManager.showDetailPanel;
  }

  get isShowAssetPath() {
    return userPreferencesManager.showAssetPath;
  }

  get isFaceEditMode() {
    return this.#isFaceEditMode;
  }

  get isEditFacesPanelOpen() {
    return this.#isEditFacesPanelOpen;
  }

  get zoomState() {
    return this.#zoomState;
  }

  set zoomState(state: ZoomImageWheelState) {
    this.#zoomState = state;
    this.emit('ZoomChange', state);
  }

  get zoom() {
    return this.#zoomState.currentZoom;
  }

  set zoom(zoom: number) {
    this.cancelZoomAnimation();
    this.zoomState = zoomAt(this.zoomState, zoom, { x: this.zoomViewport.width / 2, y: this.zoomViewport.height / 2 });
  }

  canZoomIn() {
    return this.hasListeners('Zoom') && this.zoom <= 1;
  }

  canZoomOut() {
    return this.hasListeners('Zoom') && this.zoom > 1;
  }

  canCopyImage() {
    return canCopyImageToClipboard() && !!assetViewerManager.imgRef;
  }

  private set isShowDetailPanel(value: boolean) {
    userPreferencesManager.showDetailPanel = value;
  }

  private set isShowAssetPath(value: boolean) {
    userPreferencesManager.showAssetPath = value;
  }

  onZoomChange(state: ZoomImageWheelState) {
    // bypass event emitter to avoid loop
    this.#zoomState = state;
  }

  cancelZoomAnimation() {
    if (this.#animationFrameId === null) {
      return;
    }

    cancelAnimationFrame(this.#animationFrameId);
    this.#animationFrameId = null;
  }

  animatedZoom(targetZoom: number, duration = 300, anchor?: { x: number; y: number }) {
    this.cancelZoomAnimation();

    const zoomAnchor = anchor ?? { x: this.zoomViewport.width / 2, y: this.zoomViewport.height / 2 };
    const startState = { ...this.#zoomState };
    const startZoom = startState.currentZoom;
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.zoomState = zoomAt(startState, targetZoom, zoomAnchor);
      return;
    }
    const startTime = performance.now();

    const frame = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const linearProgress = Math.min(elapsed / duration, 1);
      const easedProgress = cubicOut(linearProgress);
      const interpolatedZoom = startZoom + (targetZoom - startZoom) * easedProgress;

      this.zoomState = zoomAt(startState, interpolatedZoom, zoomAnchor);

      this.#animationFrameId = linearProgress < 1 ? requestAnimationFrame(frame) : null;
    };

    this.#animationFrameId = requestAnimationFrame(frame);
  }

  resetZoomState() {
    this.cancelZoomAnimation();
    this.zoomState = createDefaultZoomState();
  }

  toggleActivityPanel() {
    this.closeDetailPanel();
    this.isShowActivityPanel = !this.isShowActivityPanel;
  }

  closeActivityPanel() {
    this.isShowActivityPanel = false;
  }

  toggleAssetPath() {
    this.isShowAssetPath = !this.isShowAssetPath;
  }

  toggleDetailPanel() {
    this.closeActivityPanel();
    this.isShowDetailPanel = !this.isShowDetailPanel;
  }

  closeDetailPanel() {
    this.isShowDetailPanel = false;
  }

  openEditor() {
    this.closeActivityPanel();
    this.isShowEditor = true;
  }

  closeEditor() {
    this.isShowEditor = false;
  }

  toggleFaceEditMode() {
    this.#isFaceEditMode = !this.#isFaceEditMode;
    this.emit('FaceEditModeChange', this.#isFaceEditMode);
  }

  closeFaceEditMode() {
    if (this.#isFaceEditMode) {
      this.emit('FaceEditModeChange', false);
    }
    this.#isFaceEditMode = false;
  }

  openEditFacesPanel() {
    this.#isEditFacesPanelOpen = true;
  }

  closeEditFacesPanel() {
    this.#isEditFacesPanelOpen = false;
  }

  resetPanelState() {
    this.closeEditor();
    this.closeFaceEditMode();
    this.closeEditFacesPanel();
  }

  get highlightedFaces() {
    return this.#highlightedFaces;
  }

  setHighlightedFaces(faces: Faces[]) {
    this.#highlightedFaces = faces;
  }

  clearHighlightedFaces() {
    this.#highlightedFaces = [];
  }

  get isShowingHiddenPeople() {
    return this.#showingHiddenPeople;
  }

  toggleHiddenPeople() {
    this.#showingHiddenPeople = !this.#showingHiddenPeople;
  }

  hideHiddenPeople() {
    this.#showingHiddenPeople = false;
  }

  setAsset(asset: AssetResponseDto) {
    this.#viewingAssetStoreState = asset;
    this.#viewState = true;
  }

  async setAssetId(id: string, spaceId?: string): Promise<AssetResponseDto> {
    const asset = await getAssetInfo({ ...authManager.params, id, spaceId });
    this.setAsset(asset);
    return asset;
  }

  showAssetViewer(show: boolean) {
    this.#viewState = show;
  }
}

export const assetViewerManager = new AssetViewerManager();
