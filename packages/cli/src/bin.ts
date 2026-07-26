#!/usr/bin/env node
import { main, reportCliError } from './index.js';

main().catch((error: unknown) => {
  process.exitCode = reportCliError(error);
});
