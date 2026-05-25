import type { TemplateConfig } from './types.js';

export const wordpressLightningTemplate: TemplateConfig = {
  id: 'wordpress-lightning',
  description: 'WordPress with LIGHTNING (Vektor) theme',
  longDescription:
    'WordPress with the Vektor-Inc LIGHTNING theme family. Adds the SWELL ' +
    'baseline excludes plus lightning-child theme build artifacts. Vektor ' +
    'Passport activation files (.vk_pass_*) are not excluded — they ship ' +
    'with the theme and are required at runtime.',
  defaults: {
    localRoot: '.',
    excludeAdd: [
      'wp-content/uploads/cache/**',
      'wp-content/uploads/backup-*/**',
      'wp-content/cache/**',
      'wp-content/themes/lightning-child/.git/**',
      'wp-content/themes/lightning-child/node_modules/**',
      'wp-content/themes/lightning-child/.cache/**',
      'wp-content/themes/lightning-child/dist/.git/**',
      'wp-content/plugins/wp-rocket/cache/**',
      'wp-content/wflogs/**',
      'wp-content/ai1wm-backups/**',
      'wp-content/updraft/**',
    ],
    safetyProductionPatterns: ['main*', '*prod*', '*www*', '*-live'],
    preflightPhpLint: true,
  },
};
