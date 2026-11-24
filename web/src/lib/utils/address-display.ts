import type { ExifResponseDto } from '@immich/sdk';

export const getDetailedAddressRemainder = (
  exif: Pick<ExifResponseDto, 'country' | 'state' | 'city' | 'formattedAddress'> | null | undefined,
): string => {
  let remainder = exif?.formattedAddress?.trim() ?? '';
  const parts = [exif?.country, exif?.state, exif?.city].flatMap((value) => value?.trim().split(/\s+/u) ?? []);

  // GeoNames separates city/district/township with spaces. Match whole parts in order, so a
  // shared character in two different place names never removes part of the differing name.
  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (!remainder.startsWith(part)) {
      break;
    }
    remainder = remainder.slice(part.length).trimStart();
  }

  return remainder;
};
