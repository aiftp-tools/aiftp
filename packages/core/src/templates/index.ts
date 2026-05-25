/**
 * v0.11 Pillar β — template registry.
 *
 * Templates are statically declared (one TS module per template), validated
 * against TemplateConfigSchema at module-load time, and exposed by id via
 * getTemplate() / listTemplates(). No dynamic registration — the registry
 * is a closed set so an MCP client cannot inject arbitrary defaults.
 */

import { laravelTemplate } from './laravel.js';
import { phpSimpleTemplate } from './php-simple.js';
import { staticTemplate } from './static.js';
import { type TemplateConfig, TemplateConfigSchema } from './types.js';
import { wordpressCocoonTemplate } from './wordpress-cocoon.js';
import { wordpressLightningTemplate } from './wordpress-lightning.js';
import { wordpressStandardTemplate } from './wordpress-standard.js';
import { wordpressSwellTemplate } from './wordpress-swell.js';

const ALL_TEMPLATES: ReadonlyArray<TemplateConfig> = [
  wordpressSwellTemplate,
  wordpressLightningTemplate,
  wordpressCocoonTemplate,
  wordpressStandardTemplate,
  staticTemplate,
  laravelTemplate,
  phpSimpleTemplate,
];

// Validate every template at module load — catches authoring mistakes
// (bad id, missing description, unknown defaults key) at import time, not
// at first use.
const REGISTRY: ReadonlyMap<string, TemplateConfig> = new Map(
  ALL_TEMPLATES.map((t) => {
    const validated = TemplateConfigSchema.parse(t);
    return [validated.id, validated];
  }),
);

export function listTemplates(): ReadonlyArray<TemplateConfig> {
  return ALL_TEMPLATES;
}

export function getTemplate(id: string): TemplateConfig | undefined {
  return REGISTRY.get(id);
}

export function templateIds(): ReadonlyArray<string> {
  return ALL_TEMPLATES.map((t) => t.id);
}

export { TemplateConfigSchema, TemplateDefaultsSchema } from './types.js';
export type { TemplateConfig, TemplateDefaults } from './types.js';
