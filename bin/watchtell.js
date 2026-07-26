#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv).catch((err) => {
  process.stderr.write(`watchtell: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
