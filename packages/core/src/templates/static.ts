import type { TemplateConfig } from './types.js';

export const staticTemplate: TemplateConfig = {
  id: 'static',
  description: 'Static site / Jamstack build output',
  longDescription:
    'Static-site or Jamstack build output (Astro, Next.js export, Eleventy, ' +
    'Hugo, Vite). Defaults local_root to "dist" — change to "out", "build", ' +
    'or "_site" if your toolchain uses a different output directory. ' +
    'Excludes source maps, .git, node_modules. Disables PHP lint by default.',
  defaults: {
    localRoot: 'dist',
    excludeAdd: [
      '.git/**',
      'node_modules/**',
      '*.map',
      '.cache/**',
      '.parcel-cache/**',
      '.vite/**',
    ],
    safetyProductionPatterns: ['main*', '*prod*', '*www*', '*-live'],
  },
};
