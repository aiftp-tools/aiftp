import type { TemplateConfig } from './types.js';

export const laravelTemplate: TemplateConfig = {
  id: 'laravel',
  description: 'Laravel on shared hosting',
  longDescription:
    'Laravel deployed to shared hosting (DocumentRoot points at public/). ' +
    'local_root is "public" so only the web-serveable assets are uploaded. ' +
    'Excludes .env*, storage/logs, vendor/, bootstrap/cache to avoid ' +
    'leaking secrets or runtime state. Enables PHP lint.',
  defaults: {
    localRoot: 'public',
    excludeAdd: [
      '.env*',
      'storage/logs/**',
      'storage/framework/cache/**',
      'storage/framework/sessions/**',
      'storage/framework/views/**',
      'vendor/**',
      'bootstrap/cache/**',
      '.git/**',
      'node_modules/**',
      'tests/**',
    ],
    safetyProductionPatterns: ['*prod*', '*www*', '*-live'],
    preflightPhpLint: true,
  },
};
