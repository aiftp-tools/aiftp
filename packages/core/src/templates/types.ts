/**
 * v0.11 Pillar β — .aiftp.toml template presets.
 *
 * A Template carries default values that are merged into the freshly-init'd
 * .aiftp.toml so common stacks (WordPress + SWELL, Jamstack static, Laravel
 * shared hosting, etc.) get sensible hard-excludes and safety patterns out
 * of the box. Credentials, host, port, user etc. are NOT in templates —
 * those are still asked interactively by `aiftp init`.
 */

import { z } from 'zod';

export const TemplateDefaultsSchema = z
  .object({
    /** Override .aiftp.toml `[walk] local_root` (e.g. `"dist"` for static). */
    localRoot: z.string().optional(),
    /** Additional glob patterns appended to `[walk] exclude`. */
    excludeAdd: z.array(z.string()).default([]),
    /** Profile-name patterns flagged as production by `[safety] production_profile_patterns`. */
    safetyProductionPatterns: z.array(z.string()).default([]),
    /** Enable `[preflight] php_lint` (defaults to false / undefined). */
    preflightPhpLint: z.boolean().optional(),
    /** Enable `[preflight] json_check` (defaults to false / undefined). */
    preflightJsonCheck: z.boolean().optional(),
  })
  .strict();

export type TemplateDefaults = z.infer<typeof TemplateDefaultsSchema>;

export const TemplateConfigSchema = z
  .object({
    /** Template ID — value of `--template <id>` and select option `value`. */
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'template id must be lowercase ASCII + hyphen'),
    /** Short label shown in `aiftp init`'s template select prompt. */
    description: z.string().min(1),
    /** Longer description shown by `aiftp init --template list`. */
    longDescription: z.string().min(1),
    /** Preset values merged into the generated .aiftp.toml. */
    defaults: TemplateDefaultsSchema,
  })
  .strict();

export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
