/** Server-side coordinate conversion and address formatting; no database or network dependencies. */
export const ADDRESS_FORMAT_VERSION = 'amap-base-v1';

export interface AddressPoint {
  latitude: number;
  longitude: number;
}

export interface AmapConfig {
  enabled: boolean;
  key: string;
  metadataEnabled: boolean;
  onDemandEnabled: boolean;
  qps: number;
  monthlyBudget: number;
  timeoutMs: number;
  maxStreetNumberDistance: number;
}

export function readAmapConfig(env: Record<string, string | undefined>): AmapConfig {
  const number = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  };
  return {
    enabled: env.GALLERY_AMAP_ENABLED === 'true',
    key: env.GALLERY_AMAP_KEY?.trim() ?? '',
    metadataEnabled: env.GALLERY_AMAP_METADATA_ENABLED !== 'false',
    onDemandEnabled: env.GALLERY_AMAP_ON_DEMAND_ENABLED !== 'false',
    qps: number('GALLERY_AMAP_QPS', 2, 0.1, 100),
    monthlyBudget: number('GALLERY_AMAP_MONTHLY_BUDGET', 140_000, 0, 10_000_000),
    timeoutMs: number('GALLERY_AMAP_TIMEOUT_MS', 5000, 100, 30_000),
    maxStreetNumberDistance: number('GALLERY_AMAP_MAX_NUMBER_DISTANCE_METERS', 50, 0, 1000),
  };
}

export function isValidPoint(point: AddressPoint): boolean {
  return (
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180 &&
    !(point.latitude === 0 && point.longitude === 0)
  );
}

/** A conservative prefilter, not a country boundary test. Callers also check country polygons. */
export function isMainlandCandidate(point: AddressPoint, country?: string | null, state?: string | null): boolean {
  const { latitude: lat, longitude: lon } = point;
  if (!isValidPoint(point) || lon < 73.5 || lon > 135.1 || lat < 18 || lat > 53.6) {
    return false;
  }
  if (country && !['china', '中国', '中华人民共和国'].includes(country.trim().toLowerCase())) {
    return false;
  }
  if (state && /香港|澳门|澳門|台湾|臺灣|台灣|hong\s*kong|macau|macao|taiwan/i.test(state)) {
    return false;
  }
  // Deliberately skip the boundary fringe of HK/Macao rather than transform uncertain coordinates.
  return !(
    (lon >= 113.8 && lon <= 114.5 && lat >= 22.1 && lat <= 22.6) ||
    (lon >= 113.5 && lon <= 113.65 && lat >= 22.1 && lat <= 22.25) ||
    (lon >= 119.3 && lon <= 122.2 && lat >= 21.8 && lat <= 25.5)
  );
}

export function wgs84ToGcj02(point: AddressPoint): AddressPoint {
  const { latitude: lat, longitude: lon } = point;
  if (!isValidPoint(point)) {
    throw new Error('Invalid GPS coordinate');
  }
  if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) {
    return { ...point };
  }
  const x = lon - 105;
  const y = lat - 35;
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  let dLon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  const common = ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  dLat += common + ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  dLat += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  dLon += common + ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  dLon += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  const rad = (lat / 180) * Math.PI;
  const magic = 1 - 0.006693421622965943 * Math.sin(rad) ** 2;
  dLat = (dLat * 180) / (((6_378_245 * (1 - 0.006693421622965943)) / (magic * Math.sqrt(magic))) * Math.PI);
  dLon = (dLon * 180) / ((6_378_245 / Math.sqrt(magic)) * Math.cos(rad) * Math.PI);
  return { latitude: lat + dLat, longitude: lon + dLon };
}

export function amapLocation(point: AddressPoint): string {
  const converted = wgs84ToGcj02(point);
  return `${converted.longitude.toFixed(6)},${converted.latitude.toFixed(6)}`;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export function formatAmapAddress(response: unknown, maxNumberDistance = 50): string | null {
  const root = object(response);
  if (root.status !== '1') {
    return null;
  }
  const component = object(object(root.regeocode).addressComponent);
  const adcode = text(component.adcode);
  if (!/^\d{6}$/.test(adcode) || /^(71|81|82)/.test(adcode) || text(component.country) !== '中国') {
    return null;
  }
  const streetNumber = object(component.streetNumber);
  const parts = [
    '中国',
    text(component.province),
    text(component.city),
    text(component.district),
    text(component.township),
  ];
  const street = text(streetNumber.street);
  const number = text(streetNumber.number);
  const rawDistance = text(streetNumber.distance);
  const distance = rawDistance ? Number(rawDistance) : NaN;
  parts.push(street);
  if (street && number && Number.isFinite(distance) && distance >= 0 && distance <= maxNumberDistance) {
    parts.push(number);
  }
  const unique = parts.filter((part, index) => part && parts.indexOf(part) === index);
  return unique.length > 1 ? unique.join('') : null;
}
