import { describe, expect, it } from 'vitest';
import { VERSION } from './index.js';

describe('core', () => {
  it('exports VERSION constant', () => {
    expect(VERSION).toBe('0.0.0');
  });
});
