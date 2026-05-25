import type { TemplateConfig } from './types.js';

export const phpSimpleTemplate: TemplateConfig = {
  id: 'php-simple',
  description: 'Standalone PHP scripts (contact form, mini-API)',
  longDescription:
    'Standalone PHP — お問い合わせフォーム、簡易 API、独自スクリプト。 ' +
    'Excludes .env*, db.php, config.local.php so credentials never reach ' +
    'the server even by mistake. Enables PHP lint pre-flight.',
  defaults: {
    localRoot: '.',
    excludeAdd: [
      '.env*',
      'db.php',
      'config.local.php',
      'config-local.php',
      '*.log',
      '.git/**',
      'node_modules/**',
      'vendor/**',
    ],
    safetyProductionPatterns: ['*prod*', '*www*', '*-live'],
    preflightPhpLint: true,
  },
};
