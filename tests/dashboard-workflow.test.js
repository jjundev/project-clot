import './setup-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const workflow = fs.readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
const steps = workflow.split(/(?=^      - (?:name:|uses:|id:))/m);
const namedStep = name => {
  const step = steps.find(text => text.startsWith(`      - name: ${name}\n`));
  assert.ok(step, `Missing step: ${name}`);
  return step;
};

test('deploy observes the validation helper and runs its regression tests', () => {
  const push = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  workflow_run:'));
  assert.match(push, /^      - src\/site4910\/price-validation\.js$/m);
  assert.match(namedStep('Validate dashboard model and build'), /run: node --test .*tests\/site4910-price-validation\.test\.js/);
});
test('freshness policy changes rebuild the dashboard and run observation regressions',()=>{
  const push=workflow.slice(workflow.indexOf('  push:'),workflow.indexOf('  workflow_run:'));
  assert.match(push,/^      - src\/price-observation\.js$/m);
  assert.match(namedStep('Validate dashboard model and build'),/tests\/tracking-freshness\.test\.js/);
});

test('build and verification keep separate measured failure boundaries', () => {
  const build = namedStep('Build dashboard from watched and wide snapshots');
  const verify = namedStep('Verify generated dashboard');
  assert.match(build, /CLOT_REQUIRE_MUSINSA_WIDE: '1'/);
  assert.match(build, /CLOT_MUSINSA_POINTS_ENABLED: \$\{\{ vars\.CLOT_MUSINSA_POINTS_ENABLED \}\}/);
  assert.match(build, /CLOT_DASHBOARD_PATH=_site\/index\.html \/usr\/bin\/time -v node --max-old-space-size=4096 src\/cli\.js visualize --no-open/);
  assert.doesNotMatch(build, /verify-dashboard-build\.js/);
  assert.match(verify, /\/usr\/bin\/time -v node --max-old-space-size=4096 scripts\/verify-dashboard-build\.js _site\/index\.html/);
  assert.ok(workflow.indexOf(verify) < workflow.indexOf('uses: actions/upload-pages-artifact'));
  for (const step of [build, verify]) assert.doesNotMatch(step, /continue-on-error|\|\|\s*true/);
});
