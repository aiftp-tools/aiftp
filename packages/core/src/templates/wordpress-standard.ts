import type { TemplateConfig } from './types.js';

export const wordpressStandardTemplate: TemplateConfig = {
  id: 'wordpress-standard',
  description: 'WordPress (theme-agnostic baseline)',
  longDescription:
    'WordPress without a specific theme assumption. Excludes the common ' +
    'WP cache / backup / log directories shared by all themes and plugins, ' +
    'plus the most common backup plugin output paths (UpdraftPlus, ' +
    'All-in-One WP Migration, Wordfence). Use this when the site uses a ' +
    'theme that does not appear in the wordpress-* template list.',
  defaults: {
    localRoot: '.',
    excludeAdd: [
      'wp-content/uploads/cache/**',
      'wp-content/uploads/backup-*/**',
      'wp-content/cache/**',
      'wp-content/plugins/wp-rocket/cache/**',
      'wp-content/wflogs/**',
      'wp-content/ai1wm-backups/**',
      'wp-content/updraft/**',
      'wp-content/debug.log',
    ],
    safetyProductionPatterns: ['main*', '*prod*', '*www*', '*-live'],
    preflightPhpLint: true,
  },
};
