#!/usr/bin/env node
// GitHub Actions only. `restore`: MUSINSA_COOKIE secret -> ~/.clot session cache.
// `check`: after the run, report whether the tokens rotated; a rotated cookie is written to
// $CLOT_ROTATED_COOKIE_FILE (0600) for the workflow to push back into the secret. Never prints a value.
import fs from 'node:fs';
import { restoreSessionFromSecret, detectSessionChange, maskableValues } from '../src/actions-session.js';

const secret = process.env.MUSINSA_COOKIE || '';

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const command = process.argv[2];
try {
  if (command === 'restore') {
    restoreSessionFromSecret(secret);
    console.log('🔐 Musinsa session restored from the MUSINSA_COOKIE secret.');
  } else if (command === 'check') {
    const change = detectSessionChange(secret);
    if (change.status === 'rotated') {
      for (const v of maskableValues(change.cookie)) console.log(`::add-mask::${v}`);
      const out = process.env.CLOT_ROTATED_COOKIE_FILE;
      if (out) fs.writeFileSync(out, change.cookie, { mode: 0o600 });
      console.log('::warning::Musinsa tokens rotated during this run; the MUSINSA_COOKIE secret must be updated.');
    } else if (change.status === 'cleared') {
      console.log('::warning::The run dropped the Musinsa cookie (expired or revoked); log in on the Mac and update MUSINSA_COOKIE.');
    } else {
      console.log('🔐 Musinsa tokens unchanged.');
    }
    setOutput('status', change.status);
  } else {
    throw new Error('usage: actions-session.js restore|check');
  }
} catch (err) {
  console.error(`::error::${err.message}`);
  process.exit(1);
}
