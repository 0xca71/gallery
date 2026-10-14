import { exiftool } from 'exiftool-vendored';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { AssetExifFactory } from 'test/factories/asset-exif.factory.js';
import { automock } from 'test/utils.js';

describe('saved image files', () => {
  let directory: string;
  let sut: MediaRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'gallery-save-test-'));
    sut = new MediaRepository(automock(LoggingRepository, { strict: false }));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    await exiftool.end();
  });

  it('bakes crop and rotation into pixels, preserves capture metadata, and leaves the source untouched', async () => {
    const source = join(directory, 'source.png');
    const output = join(directory, 'result.png');
    const pixels = Buffer.alloc(8 * 6 * 3);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 8; x++) {
        pixels[(y * 8 + x) * 3 + (x < 4 ? 0 : 2)] = 255;
      }
    }
    await sharp(pixels, { raw: { width: 8, height: 6, channels: 3 } })
      .png()
      .toFile(source);
    await exiftool.write(
      source,
      {
        DateTimeOriginal: '2024:03:04 05:06:07',
        OffsetTimeOriginal: '+08:00',
        SubSecTimeOriginal: '123456',
        Make: 'Test Camera',
        GPSLatitude: 31.2,
        GPSLongitude: 121.4,
        Copyright: 'Keep this metadata',
      },
      { writeArgs: ['-overwrite_original'] },
    );
    const before = createHash('sha256')
      .update(await readFile(source))
      .digest('hex');
    const dimensions = await sut.renderSavedImage(
      source,
      output,
      [
        { action: AssetEditAction.Crop, parameters: { x: 4, y: 0, width: 4, height: 6 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ],
      'png',
    );
    expect(dimensions).toEqual({ width: 6, height: 4 });
    const exif = AssetExifFactory.create({
      exifImageWidth: 8,
      exifImageHeight: 6,
      orientation: '1',
      timeZone: 'Asia/Shanghai',
    });
    await sut.writeSavedImageMetadata(source, output, exif, dimensions, new Date('2024-03-03T21:06:07Z'));
    const tags = await exiftool.read(output);
    expect(tags.Make).toBe('Test Camera');
    expect(tags.Copyright).toBe('Keep this metadata');
    expect(tags.GPSLatitude).toBeCloseTo(31.2);
    expect(tags.GPSLongitude).toBeCloseTo(121.4);
    expect(tags.OffsetTimeOriginal).toBe('+08:00');
    expect(String(tags.SubSecTimeOriginal)).toBe('123456');
    expect(Number(tags.Orientation)).toBe(1);
    const decoded = await sharp(output).removeAlpha().raw().toBuffer();
    for (let i = 0; i < decoded.length; i += 3) {
      expect([...decoded.subarray(i, i + 3)]).toEqual([0, 0, 255]);
    }
    expect(
      createHash('sha256')
        .update(await readFile(source))
        .digest('hex'),
    ).toBe(before);
  });

  it('normalizes orientation and keeps alpha in a PNG save', async () => {
    const source = join(directory, 'oriented.png');
    const output = join(directory, 'result.png');
    await sharp({ create: { width: 8, height: 6, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .withMetadata({ orientation: 6 })
      .png()
      .toFile(source);
    const originalMetadata = await sharp(source).metadata();
    expect(originalMetadata.orientation).toBe(6);
    const dimensions = await sut.renderSavedImage(source, output, [], 'png');
    expect(dimensions).toEqual({ width: 6, height: 8 });
    const metadata = await sharp(output).metadata();
    expect(metadata.hasAlpha).toBe(true);
    expect(metadata.orientation).toBeUndefined();
  });

  it('writes user-corrected capture time, timezone, description, and GPS into the baked file', async () => {
    const source = join(directory, 'source.png');
    const output = join(directory, 'result.png');
    await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } })
      .png()
      .toFile(source);
    await exiftool.write(
      source,
      {
        DateTimeOriginal: '2001:01:01 01:00:00',
        OffsetTimeOriginal: '+01:00',
        SubSecTimeOriginal: '999',
        GPSLatitude: 1,
        GPSLongitude: 2,
      },
      { writeArgs: ['-overwrite_original'] },
    );
    const capture = new Date('2024-03-03T21:06:07.123Z');
    const exif = AssetExifFactory.create({
      dateTimeOriginal: capture,
      timeZone: 'Asia/Shanghai',
      description: 'Corrected description',
      latitude: -33.8,
      longitude: 151.2,
      lockedProperties: ['dateTimeOriginal', 'timeZone', 'description', 'latitude', 'longitude'],
    });
    const dimensions = await sut.renderSavedImage(source, output, [], 'png');
    await sut.writeSavedImageMetadata(source, output, exif, dimensions, capture);
    const written = await exiftool.read(output);
    expect(written.OffsetTimeOriginal).toBe('+08:00');
    expect(String(written.SubSecTimeOriginal)).toBe('123');
    expect(written.ImageDescription).toBe('Corrected description');
    expect(written.GPSLatitude).toBeCloseTo(-33.8);
    expect(written.GPSLongitude).toBeCloseTo(151.2);
  });

  it('rejects renamed inputs and incomplete decoding before overwriting an original', async () => {
    const source = join(directory, 'renamed.jpg');
    const output = join(directory, 'result.jpg');
    await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } })
      .png()
      .toFile(source);
    await expect(sut.renderSavedImage(source, output, [], 'jpeg', { width: 8, height: 6 }, true)).rejects.toThrow(
      'unsupported_format',
    );
    await expect(sut.renderSavedImage(source, output, [], 'png', { width: 16, height: 12 })).rejects.toThrow(
      'Full original',
    );
  });
});
