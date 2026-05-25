import type { TemplateConfig } from './types.js';

export const wordpressCocoonTemplate: TemplateConfig = {
  id: 'wordpress-cocoon',
  description: 'WordPress with Cocoon theme',
  longDescription:
    'WordPress with the わいひら-san Cocoon theme. Excludes the cocoon-master ' +
    'parent theme .git and cocoon-child build artifacts. Cocoon-specific ' +
    'cache directories (wp-content/cache/cocoon-cache/**) are also excluded.',
  defaults: {
    localRoot: '.',
    excludeAdd: [
      'wp-content/uploads/cache/**',
      'wp-content/uploads/backup-*/**',
      'wp-content/cache/**',
      'wp-content/cache/cocoon-cache/**',
      'wp-content/themes/cocoon-master/.git/**',
      'wp-content/themes/cocoon-child/.git/**',
      'wp-content/themes/cocoon-child/node_modules/**',
      'wp-content/themes/cocoon-child/.cache/**',
      'wp-content/plugins/wp-rocket/cache/**',
      'wp-content/wflogs/**',
      'wp-content/ai1wm-backups/**',
      'wp-content/updraft/**',
    ],
    safetyProductionPatterns: ['*prod*', '*www*', '*-live'],
    preflightPhpLint: true,
  },
};
