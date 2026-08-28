#!/usr/bin/env node
// node:sqlite is still flagged experimental on Node 22, and the warning it
// prints on first import is noise in a CLI. Everything else still warns.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning(warning, ...rest);
};

const { cli } = await import('../lib/cli.js');
process.exitCode = await cli(process.argv.slice(2));
