import {
  amapLocation,
  formatAmapAddress,
  isMainlandCandidate,
  readAmapConfig,
  wgs84ToGcj02,
} from 'src/gallery/amap-address.js';

const response = (component: Record<string, unknown> = {}) => ({
  status: '1',
  regeocode: {
    formatted_address: '湖北省武汉市硚口区古田云彩',
    addressComponent: {
      country: '中国',
      province: '湖北省',
      city: '武汉市',
      district: '硚口区',
      township: '长丰街道',
      adcode: '420104',
      streetNumber: { street: '解放大道', number: '22号', distance: '12' },
      ...component,
    },
  },
});

describe('AMap address conversion and formatting', () => {
  it('matches the previously verified Wuhan conversion without changing the input', () => {
    const original = Object.freeze({ latitude: 30.602597, longitude: 114.186145 });
    const result = wgs84ToGcj02(original);
    expect(result.latitude).toBeCloseTo(30.600203721789, 5);
    expect(result.longitude).toBeCloseTo(114.191684299046, 5);
    expect(amapLocation(original)).toBe('114.191685,30.600204');
    expect(original.latitude).toBe(30.602597);
  });

  it('leaves overseas coordinates unchanged and rejects invalid GPS', () => {
    const point = { latitude: 52.52, longitude: 13.405 };
    expect(wgs84ToGcj02(point)).toEqual(point);
    expect(() => wgs84ToGcj02({ latitude: NaN, longitude: 100 })).toThrow();
  });

  it.each([
    [{ latitude: 22.3, longitude: 114.2 }, 'China', 'Hong Kong'],
    [{ latitude: 22.19, longitude: 113.55 }, '中国', '澳门'],
    [{ latitude: 25.03, longitude: 121.56 }, '中国', '台湾省'],
    [{ latitude: 13.7, longitude: 100.5 }, 'Thailand', null],
  ])('excludes non-mainland and uncertain boundary points', (point, country, state) => {
    expect(
      isMainlandCandidate(point as { latitude: number; longitude: number }, country as string, state as string | null),
    ).toBe(false);
  });

  it('uses only address components, never POI/AOI or the provider formatted description', () => {
    expect(formatAmapAddress(response())).toBe('中国湖北省武汉市硚口区长丰街道解放大道22号');
  });

  it('handles municipality empty arrays and deduplicates province/city', () => {
    expect(
      formatAmapAddress(
        response({
          province: '北京市',
          city: [],
          district: '海淀区',
          township: [],
          adcode: '110108',
          streetNumber: [],
        }),
      ),
    ).toBe('中国北京市海淀区');
    expect(formatAmapAddress(response({ province: '重庆市', city: '重庆市' }))).not.toContain('重庆市重庆市');
  });

  it.each(['100', '', '-1', 'NaN'])('omits uncertain house numbers at distance %s', (distance) => {
    expect(formatAmapAddress(response({ streetNumber: { street: '解放大道', number: '22号', distance } }))).toBe(
      '中国湖北省武汉市硚口区长丰街道解放大道',
    );
  });

  it('rejects errors and non-mainland administrative codes', () => {
    expect(formatAmapAddress({ status: '0' })).toBeNull();
    expect(formatAmapAddress(response({ adcode: '810000' }))).toBeNull();
    expect(formatAmapAddress(response({ adcode: [] }))).toBeNull();
  });

  it('requires opt-in and validates budgets and provider settings', () => {
    expect(readAmapConfig({})).toMatchObject({ enabled: false, qps: 2, monthlyBudget: 140_000 });
    expect(() => readAmapConfig({ GALLERY_AMAP_QPS: 'NaN' })).toThrow('GALLERY_AMAP_QPS');
  });
});
