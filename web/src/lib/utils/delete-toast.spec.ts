import { describe, expect, it } from 'vitest';
import { getDeleteToastOptions } from './delete-toast';

describe('getDeleteToastOptions', () => {
  it('keeps the existing timeout at the threshold', () => {
    expect(getDeleteToastOptions(20, 20)).toEqual({ timeout: 5000, closable: true });
  });

  it('keeps the toast open above the threshold', () => {
    expect(getDeleteToastOptions(21, 20)).toEqual({ timeout: 0, closable: true });
  });

  it('uses a custom threshold', () => {
    expect(getDeleteToastOptions(43, 42)).toEqual({ timeout: 0, closable: true });
  });
});
