#!/usr/bin/env node
import { run } from './program.js';
import { processRuntime } from './runtime.js';

process.exitCode = await run(processRuntime(), process.argv.slice(2));
