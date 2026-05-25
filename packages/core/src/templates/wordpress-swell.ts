import type { TemplateConfig } from './types.js';

export const wordpressSwellTemplate: TemplateConfig = {
  id: 'wordpress-swell',
  description: 'WordPress with SWELL theme',
  longDescription:
    'WordPress on shared FTP using the SWELL theme. Hard-excludes cache, ' +
    'backup archives, and SWELL child theme build artifacts (.git, node_modules, ' +
    '.cache, dist). Enables PHP lint pre-flight. Marks *prod*, *www*, *-live ' +
    'profile names as production for the type-to-confirm gate.',
  defaults: {
    localRoot: '.',
    excludeAdd: [
      'wp-content/uploads/cache/**',
      'wp-content/uploads/backup-*/**',
      'wp-content/cache/**',
      'wp-content/themes/swell-child/.git/**',
      'wp-content/themes/swell-child/node_modules/**',
      'wp-content/themes/swell-child/.cache/**',
      'wp-content/themes/swell-child/dist/.git/**',
      'wp-content/plugins/wp-rocket/cache/**',
      'wp-content/wflogs/**',
      'wp-content/ai1wm-backups/**',
      'wp-content/updraft/**',
    ],
    safetyProductionPatterns: ['*prod*', '*www*', '*-live'],
    preflightPhpLint: true,
  },
};
