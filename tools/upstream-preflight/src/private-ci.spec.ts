import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(process.cwd(), '../..');
const workflowRoot = path.join(repoRoot, '.github/workflows');

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<
    string,
    {
      if?: string;
      uses?: string;
      needs?: string | string[];
      steps?: WorkflowStep[];
    }
  >;
};
const workflow = (name: string): Workflow =>
  parse(fs.readFileSync(path.join(workflowRoot, name), 'utf8'));

const manualTemplates = [
  'auto-close.yml',
  'cli.yml',
  'close-duplicates.yml',
  'codeql-analysis.yml',
  'docker.yml',
  'fix-format.yml',
  'gallery-mobile-scale-test.yml',
  'gallery-pr-rc-cleanup.yml',
  'gallery-pr-rc-comment.yml',
  'gallery-prerelease-server.yml',
  'gallery-rebase-smoke.yml',
  'gallery-release-mobile.yml',
  'gallery-release-server-only.yml',
  'gallery-revert-to-immich-validation.yml',
  'org-pr-require-conventional-commit.yml',
  'pr-label-validation.yml',
  'pr-labeler.yml',
  'sdk.yml',
  'static_analysis.yml',
  'storage-migration-e2e.yml',
  'storage-migration-tests.yml',
  'weblate-lock.yml',
];

describe('private CI workflow policy', () => {
  it.each(manualTemplates)(
    '%s stays manual and every job is upstream-repository-gated',
    (name) => {
      const config = workflow(name);
      expect(Object.keys(config.on)).toEqual(['workflow_dispatch']);
      for (const job of Object.values(config.jobs)) {
        expect(job.if).toMatch(
          /^\$\{\{ github\.repository == '(immich-app\/immich|open-noodle\/gallery)'(?: && | \}\})/,
        );
      }
    },
  );

  it.each([
    'backport.yml',
    'docs-destroy.yml',
    'draft-release.yml',
    'prepare-release.yml',
    'gallery-rc-build.yml',
    'merge-translations.yml',
  ])('%s cannot run a job in the private fork', (name) => {
    for (const job of Object.values(workflow(name).jobs)) {
      expect(job.if).toMatch(
        /^\$\{\{ github\.repository == '(immich-app\/immich|open-noodle\/gallery)'(?: && | \}\})/,
      );
    }
  });

  it('keeps the explicit custom image publisher manual and independent of upstream gates', () => {
    const config = workflow('custom-docker.yml');
    expect(Object.keys(config.on)).toEqual(['workflow_dispatch']);
    expect(config.jobs.server.if).toBeUndefined();
    const build = config.jobs.server.steps?.find((step) =>
      step.uses?.startsWith('docker/build-push-action@'),
    );
    expect(build?.with).toMatchObject({
      context: '.',
      file: 'server/Dockerfile',
      platforms: 'linux/amd64',
      push: true,
    });
  });

  it('has no dangling local reusable workflow or job dependencies after retirement', () => {
    for (const name of fs
      .readdirSync(workflowRoot)
      .filter((name) => /\.ya?ml$/.test(name))) {
      const config = workflow(name);
      for (const job of Object.values(config.jobs ?? {})) {
        if (job.uses?.startsWith('./.github/workflows/')) {
          expect(
            fs.existsSync(path.join(repoRoot, job.uses)),
            `${name}: ${job.uses}`,
          ).toBe(true);
        }
        for (const dependency of Array.isArray(job.needs)
          ? job.needs
          : job.needs
            ? [job.needs]
            : []) {
          expect(config.jobs, `${name}: ${dependency}`).toHaveProperty(
            dependency,
          );
        }
      }
    }
  });

  it('checks the private base specification through authenticated checkouts, not public raw URLs', () => {
    for (const job of Object.values(workflow('check-openapi.yml').jobs)) {
      const base = job.steps?.find(
        (step) => step.name === 'Checkout base specification',
      );
      expect(base?.with).toMatchObject({
        path: '.openapi-base',
        'sparse-checkout': 'open-api/immich-openapi-specs.json',
        'sparse-checkout-cone-mode': false,
        'persist-credentials': false,
      });
      expect(base?.with?.ref).toBe("${{ github.base_ref || 'main' }}");
    }
  });

  it('retains native and mobile verification without the retired expensive E2E jobs', () => {
    const jobs = workflow('test.yml').jobs;
    expect(jobs).toHaveProperty('native-tests');
    const mobileRuns = jobs['mobile-unit-tests'].steps?.map((step) => step.run);
    expect(mobileRuns).toContain('mise //mobile:codegen');
    expect(mobileRuns).toContain('mise //mobile:test');
    for (const retired of [
      'e2e-tests-lint',
      'e2e-tests-server-cli',
      'e2e-tests-web',
      'success-check-e2e',
    ]) {
      expect(jobs).not.toHaveProperty(retired);
    }
  });

  it('stores the Zizmor report as an artifact without private-repo Code Security uploads', () => {
    const job = workflow('org-zizmor.yml').jobs.zizmor;
    expect(job.uses).toBeUndefined();
    expect(
      job.steps?.find((step) => step.name === 'Save audit report')?.with,
    ).toMatchObject({
      path: 'results.sarif',
      'if-no-files-found': 'error',
    });
  });
});
