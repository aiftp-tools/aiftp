import { describe, expect, it } from 'vitest';
import { VERSION } from './index.js';

describe('mcp', () => {
  it('re-exports VERSION from core', () => {
    expect(VERSION).toBe('0.0.0');
  });
});
