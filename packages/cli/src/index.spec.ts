import { describe, expect, it } from 'vitest';
import { VERSION } from './index.js';

describe('cli', () => {
  it('re-exports VERSION from core', () => {
    expect(VERSION).toBe('0.0.0');
  });
});
