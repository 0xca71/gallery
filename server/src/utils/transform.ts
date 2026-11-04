import { Matrix, applyToPoint, compose, flipX, flipY, identity, rotate, scale, translate } from 'transformation-matrix';
import type { ImageDimensions } from 'src/types.js';
import { AssetEditAction, AssetEditActionItem } from 'src/dtos/editing.dto.js';
import { AssetOcrResponseDto } from 'src/dtos/ocr.dto.js';

export const isOrthogonalRotation = (angleDegrees: number): boolean => {
  const remainder = ((angleDegrees % 90) + 90) % 90;
  return remainder < 1e-6 || Math.abs(remainder - 90) < 1e-6;
};

export const hasArbitraryRotation = (edits: AssetEditActionItem[]): boolean =>
  edits.some((edit) => edit.action === AssetEditAction.Rotate && !isOrthogonalRotation(edit.parameters.angle));

export const getRotatedDimensions = (dimensions: ImageDimensions, angleDegrees: number): ImageDimensions => {
  if (isOrthogonalRotation(angleDegrees)) {
    const normalized = ((Math.round(angleDegrees) % 360) + 360) % 360;
    return normalized === 90 || normalized === 270
      ? { width: dimensions.height, height: dimensions.width }
      : { width: dimensions.width, height: dimensions.height };
  }

  const angleRadians = (angleDegrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angleRadians));
  const sin = Math.abs(Math.sin(angleRadians));
  return {
    width: Math.max(1, Math.round(dimensions.width * cos + dimensions.height * sin)),
    height: Math.max(1, Math.round(dimensions.width * sin + dimensions.height * cos)),
  };
};

export const getCropBoundsDimensions = (
  edits: AssetEditActionItem[],
  startingDimensions: ImageDimensions,
): ImageDimensions => {
  if (!hasArbitraryRotation(edits)) {
    return startingDimensions;
  }

  let dims = { ...startingDimensions };
  for (const edit of edits) {
    if (edit.action === AssetEditAction.Rotate) {
      dims = getRotatedDimensions(dims, edit.parameters.angle);
    }
  }
  return dims;
};

export const getOutputDimensions = (
  edits: AssetEditActionItem[],
  startingDimensions: ImageDimensions,
): ImageDimensions => {
  const crop = edits.find((edit) => edit.action === AssetEditAction.Crop);

  if (hasArbitraryRotation(edits)) {
    if (crop) {
      return { width: crop.parameters.width, height: crop.parameters.height };
    }
    return getCropBoundsDimensions(edits, startingDimensions);
  }

  let { width, height } = startingDimensions;
  if (crop) {
    width = crop.parameters.width;
    height = crop.parameters.height;
  }

  for (const edit of edits) {
    if (edit.action !== AssetEditAction.Rotate) {
      continue;
    }

    ({ width, height } = getRotatedDimensions({ width, height }, edit.parameters.angle));
  }

  return { width, height };
};

export const createAffineMatrix = (
  edits: AssetEditActionItem[],
  scalingParameters?: {
    pointSpace: ImageDimensions;
    targetSpace: ImageDimensions;
  },
): Matrix => {
  let scalingMatrix: Matrix = identity();

  if (scalingParameters) {
    const { pointSpace, targetSpace } = scalingParameters;
    const scaleX = targetSpace.width / pointSpace.width;
    scalingMatrix = scale(scaleX);
  }

  return compose(
    scalingMatrix,
    ...edits.map((edit) => {
      switch (edit.action) {
        case 'rotate': {
          const angleInRadians = (-edit.parameters.angle * Math.PI) / 180;
          return rotate(angleInRadians);
        }
        case 'mirror': {
          return edit.parameters.axis === 'horizontal' ? flipY() : flipX();
        }
        default: {
          return identity();
        }
      }
    }),
  );
};

export type Point = { x: number; y: number };

type TransformState = {
  points: Point[];
  currentWidth: number;
  currentHeight: number;
};

/**
 * Transforms an array of points through a series of edit operations (crop, rotate, mirror).
 * Points should be in absolute pixel coordinates relative to the starting dimensions.
 */
export const transformPoints = (
  points: Point[],
  edits: AssetEditActionItem[],
  startingDimensions: ImageDimensions,
  { inverse = false } = {},
): TransformState => {
  let currentWidth = startingDimensions.width;
  let currentHeight = startingDimensions.height;
  let transformedPoints = [...points];
  const arbitraryRotation = hasArbitraryRotation(edits);
  const crop = edits.find((edit) => edit.action === 'crop');

  const applyCrop = () => {
    if (!crop) {
      return;
    }
    const { x: cropX, y: cropY, width: cropWidth, height: cropHeight } = crop.parameters;
    if (inverse) {
      transformedPoints = transformedPoints.map((p) => ({
        x: p.x + cropX,
        y: p.y + cropY,
      }));
    } else {
      transformedPoints = transformedPoints.map((p) => ({
        x: p.x - cropX,
        y: p.y - cropY,
      }));
      currentWidth = cropWidth;
      currentHeight = cropHeight;
    }
  };

  if (arbitraryRotation ? inverse : !inverse) {
    applyCrop();
  }

  // Apply rotate and mirror transforms
  const editSequence = inverse ? edits.toReversed() : edits;
  for (const edit of editSequence) {
    let matrix: Matrix = identity();
    if (edit.action === 'rotate') {
      const angleDegrees = edit.parameters.angle;
      const angleRadians = (angleDegrees * Math.PI) / 180;
      const { width: newWidth, height: newHeight } = getRotatedDimensions(
        { width: currentWidth, height: currentHeight },
        angleDegrees,
      );

      matrix = compose(
        translate(newWidth / 2, newHeight / 2),
        rotate(inverse ? -angleRadians : angleRadians),
        translate(-currentWidth / 2, -currentHeight / 2),
      );

      currentWidth = newWidth;
      currentHeight = newHeight;
    } else if (edit.action === 'mirror') {
      matrix = compose(
        translate(currentWidth / 2, currentHeight / 2),
        edit.parameters.axis === 'horizontal' ? flipY() : flipX(),
        translate(-currentWidth / 2, -currentHeight / 2),
      );
    } else {
      // Skip non-affine transformations
      continue;
    }

    transformedPoints = transformedPoints.map((p) => applyToPoint(matrix, p));
  }

  if (arbitraryRotation ? !inverse : inverse) {
    applyCrop();
  }

  return {
    points: transformedPoints,
    currentWidth,
    currentHeight,
  };
};

type FaceBoundingBox = {
  boundingBoxX1: number;
  boundingBoxX2: number;
  boundingBoxY1: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
};

export const transformFaceBoundingBox = (
  box: FaceBoundingBox,
  edits: AssetEditActionItem[],
  imageDimensions: ImageDimensions,
): FaceBoundingBox => {
  if (edits.length === 0) {
    return box;
  }

  const scaleX = imageDimensions.width / box.imageWidth;
  const scaleY = imageDimensions.height / box.imageHeight;

  const points: Point[] = [
    { x: box.boundingBoxX1 * scaleX, y: box.boundingBoxY1 * scaleY },
    { x: box.boundingBoxX2 * scaleX, y: box.boundingBoxY2 * scaleY },
  ];

  const { points: transformedPoints, currentWidth, currentHeight } = transformPoints(points, edits, imageDimensions);

  // Ensure x1,y1 is top-left and x2,y2 is bottom-right
  const [p1, p2] = transformedPoints;
  return {
    boundingBoxX1: Math.trunc(Math.min(p1.x, p2.x)),
    boundingBoxY1: Math.trunc(Math.min(p1.y, p2.y)),
    boundingBoxX2: Math.trunc(Math.max(p1.x, p2.x)),
    boundingBoxY2: Math.trunc(Math.max(p1.y, p2.y)),
    imageWidth: currentWidth,
    imageHeight: currentHeight,
  };
};

const reorderQuadPointsForRotation = (points: Point[], rotationDegrees: number): Point[] => {
  const [p1, p2, p3, p4] = points;
  switch (rotationDegrees) {
    case 90: {
      return [p4, p1, p2, p3];
    }
    case 180: {
      return [p3, p4, p1, p2];
    }
    case 270: {
      return [p2, p3, p4, p1];
    }
    default: {
      return points;
    }
  }
};

export const transformOcrBoundingBox = (
  box: AssetOcrResponseDto,
  edits: AssetEditActionItem[],
  imageDimensions: ImageDimensions,
): AssetOcrResponseDto => {
  if (edits.length === 0) {
    return box;
  }

  const points: Point[] = [
    { x: box.x1 * imageDimensions.width, y: box.y1 * imageDimensions.height },
    { x: box.x2 * imageDimensions.width, y: box.y2 * imageDimensions.height },
    { x: box.x3 * imageDimensions.width, y: box.y3 * imageDimensions.height },
    { x: box.x4 * imageDimensions.width, y: box.y4 * imageDimensions.height },
  ];

  const { points: transformedPoints, currentWidth, currentHeight } = transformPoints(points, edits, imageDimensions);

  // Reorder points to maintain semantic ordering (topLeft, topRight, bottomRight, bottomLeft)
  const netRotation = edits.find((e) => e.action === AssetEditAction.Rotate)?.parameters.angle ?? 0 % 360;
  const reorderedPoints = reorderQuadPointsForRotation(transformedPoints, netRotation);

  const [p1, p2, p3, p4] = reorderedPoints;
  return {
    ...box,
    x1: p1.x / currentWidth,
    y1: p1.y / currentHeight,
    x2: p2.x / currentWidth,
    y2: p2.y / currentHeight,
    x3: p3.x / currentWidth,
    y3: p3.y / currentHeight,
    x4: p4.x / currentWidth,
    y4: p4.y / currentHeight,
  };
};
