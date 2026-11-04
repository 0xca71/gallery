import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';
import type { ImageDimensions } from 'src/types.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { boundingBoxOverlap } from 'src/utils/editor.js';
import { getCropBoundsDimensions, hasArbitraryRotation, transformPoints } from 'src/utils/transform.js';

export type SavedImageFormat = 'jpeg' | 'png' | 'webp';

export const getSavedImageFormat = (filename: string): SavedImageFormat | undefined => {
  switch (extname(filename).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
    case '.jpe':
    case '.jfif': {
      return 'jpeg';
    }
    case '.png': {
      return 'png';
    }
    case '.webp': {
      return 'webp';
    }
  }
};

export const getSavedImageExtension = (format: SavedImageFormat): string => (format === 'jpeg' ? '.jpg' : `.${format}`);

export const replaceFilenameExtension = (filename: string, extension: string): string => {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return `${stem}${extension}`;
};

export const validateSavedImageEdits = (edits: AssetEditActionItem[], dimensions: ImageDimensions) => {
  if (edits.some((edit) => edit.action === 'trim')) {
    throw new BadRequestException('Only image transformations can be saved to a file');
  }
  const crop = edits.find((edit) => edit.action === 'crop');
  const bounds = getCropBoundsDimensions(edits, dimensions);
  if (
    crop &&
    (edits[0] !== crop ||
      crop.parameters.x + crop.parameters.width > bounds.width ||
      crop.parameters.y + crop.parameters.height > bounds.height)
  ) {
    throw new BadRequestException('Crop parameters are out of bounds or not the first action');
  }
};

export const transformSavedFace = (
  face: {
    imageWidth: number;
    imageHeight: number;
    boundingBoxX1: number;
    boundingBoxY1: number;
    boundingBoxX2: number;
    boundingBoxY2: number;
  },
  edits: AssetEditActionItem[],
  dimensions: ImageDimensions,
) => {
  if (face.imageWidth <= 0 || face.imageHeight <= 0) {
    return;
  }
  const sx = dimensions.width / face.imageWidth;
  const sy = dimensions.height / face.imageHeight;
  const box = {
    x1: face.boundingBoxX1 * sx,
    y1: face.boundingBoxY1 * sy,
    x2: face.boundingBoxX2 * sx,
    y2: face.boundingBoxY2 * sy,
  };
  const crop = edits.find((edit) => edit.action === 'crop');
  if (
    crop &&
    !hasArbitraryRotation(edits) &&
    boundingBoxOverlap(box, {
      x1: crop.parameters.x,
      y1: crop.parameters.y,
      x2: crop.parameters.x + crop.parameters.width,
      y2: crop.parameters.y + crop.parameters.height,
    }) < 0.5
  ) {
    return;
  }
  const transformed = transformPoints(
    [
      { x: box.x1, y: box.y1 },
      { x: box.x2, y: box.y1 },
      { x: box.x2, y: box.y2 },
      { x: box.x1, y: box.y2 },
    ],
    edits,
    dimensions,
  );
  if (crop && hasArbitraryRotation(edits)) {
    const rawXs = transformed.points.map((point) => point.x);
    const rawYs = transformed.points.map((point) => point.y);
    if (
      boundingBoxOverlap(
        {
          x1: Math.min(...rawXs),
          y1: Math.min(...rawYs),
          x2: Math.max(...rawXs),
          y2: Math.max(...rawYs),
        },
        {
          x1: 0,
          y1: 0,
          x2: transformed.currentWidth,
          y2: transformed.currentHeight,
        },
      ) < 0.5
    ) {
      return;
    }
  }
  const xs = transformed.points.map((point) => Math.min(transformed.currentWidth, Math.max(0, point.x)));
  const ys = transformed.points.map((point) => Math.min(transformed.currentHeight, Math.max(0, point.y)));
  const result = {
    imageWidth: transformed.currentWidth,
    imageHeight: transformed.currentHeight,
    boundingBoxX1: Math.round(Math.min(...xs)),
    boundingBoxY1: Math.round(Math.min(...ys)),
    boundingBoxX2: Math.round(Math.max(...xs)),
    boundingBoxY2: Math.round(Math.max(...ys)),
  };
  return result.boundingBoxX2 > result.boundingBoxX1 && result.boundingBoxY2 > result.boundingBoxY1
    ? result
    : undefined;
};
