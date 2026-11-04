import type { MirrorParameters, RotateParameters } from '@immich/sdk';
import { compose, flipX, flipY, identity, rotate } from 'transformation-matrix';
import type { EditActions } from '$lib/managers/edit/edit-manager.svelte';

const isCloseToZero = (x: number, epsilon: number = 1e-15) => Math.abs(x) < epsilon;

export const normalizeTransformEdits = (
  edits: EditActions,
): {
  rotation: number;
  mirrorHorizontal: boolean;
  mirrorVertical: boolean;
} => {
  const { a, b, c, d } = buildAffineFromEdits(edits);
  const rawAngle = (Math.atan2(c, a) * 180) / Math.PI;
  const normalizedAngle = rawAngle < 0 ? 360 + rawAngle : rawAngle;
  const roundedAngle = Math.round(normalizedAngle * 100) / 100;

  return {
    rotation: isCloseToZero(roundedAngle) || isCloseToZero(roundedAngle - 360) ? 0 : roundedAngle,
    mirrorHorizontal: false,
    mirrorVertical: a * d < b * c,
  };
};

export const buildAffineFromEdits = (edits: EditActions) =>
  compose(
    identity(),
    ...edits.map((edit) => {
      switch (edit.action) {
        case 'rotate': {
          const parameters = edit.parameters as RotateParameters;
          const angleInRadians = (-parameters.angle * Math.PI) / 180;
          return rotate(angleInRadians);
        }
        case 'mirror': {
          const parameters = edit.parameters as MirrorParameters;
          return parameters.axis === 'horizontal' ? flipY() : flipX();
        }
        default: {
          return identity();
        }
      }
    }),
  );
