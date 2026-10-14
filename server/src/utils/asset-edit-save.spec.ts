import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { getSavedImageFormat, transformSavedFace, validateSavedImageEdits } from 'src/utils/asset-edit-save.js';

describe('image file saving geometry', () => {
  const edits = [
    { action: AssetEditAction.Crop, parameters: { x: 10, y: 10, width: 40, height: 40 } },
    { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
  ] as const;
  it('retains a visible face in the new coordinate system', () => {
    expect(
      transformSavedFace(
        {
          imageWidth: 100,
          imageHeight: 80,
          boundingBoxX1: 10,
          boundingBoxY1: 10,
          boundingBoxX2: 30,
          boundingBoxY2: 30,
        },
        [...edits],
        { width: 100, height: 80 },
      ),
    ).toEqual({
      imageWidth: 40,
      imageHeight: 40,
      boundingBoxX1: 20,
      boundingBoxY1: 0,
      boundingBoxX2: 40,
      boundingBoxY2: 20,
    });
  });
  it('removes cropped-away and invalid face bounds', () => {
    const face = {
      imageWidth: 100,
      imageHeight: 80,
      boundingBoxX1: 70,
      boundingBoxY1: 10,
      boundingBoxX2: 90,
      boundingBoxY2: 30,
    };
    expect(transformSavedFace(face, [...edits], { width: 100, height: 80 })).toBeUndefined();
    expect(transformSavedFace({ ...face, imageWidth: 0 }, [], { width: 100, height: 80 })).toBeUndefined();
  });
  it('rejects out-of-bounds or reordered crops', () => {
    expect(() => validateSavedImageEdits([...edits], { width: 20, height: 20 })).toThrow();
    expect(() => validateSavedImageEdits([edits[1], edits[0]], { width: 100, height: 80 })).toThrow();
  });
  it('restricts same-format replacement to supported image encoders', () => {
    expect(getSavedImageFormat('photo.JPG')).toBe('jpeg');
    expect(getSavedImageFormat('photo.png')).toBe('png');
    expect(getSavedImageFormat('photo.heic')).toBeUndefined();
    expect(getSavedImageFormat('photo.cr2')).toBeUndefined();
  });
});
