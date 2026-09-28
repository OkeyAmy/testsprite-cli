import { promises as nodeFs } from 'node:fs';
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { CLIError, localValidationError } from '../lib/errors.js';
import { loadConfig, resolveProfileName } from '../lib/config.js';
import { type FetchImpl, type HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import type { Page } from '../lib/pagination.js';
import { assertNotLocal } from '../lib/target-url.js';
import {
  classifyLinkage,
  isValidRepoSlug,
  parseDeploymentsPayload,
  parseRepoSlug,
  type DeploymentRecord,
  type LinkageStatus,
  type LinkageVerdict,
} from '../lib/ci-linkage.js';
import { recordTelemetryExtras } from '../lib/telemetry.js';
import { VERSION } from '../version.js';
import type { CliProject } from './project.js';

// ── constants ────────────────────────────────────────────────────────────────

/** Platforms `ci init` can scaffold. One today; the positional arg leaves room. */
const SUPPORTED_PLATFORMS = ['github'] as const;
type Platform = (typeof SUPPORTED_PLATFORMS)[number];

/** Default location a GitHub Actions workflow must live to be picked up. */
const DEFAULT_WORKFLOW_PATH = '.github/workflows/testsprite.yml';

/** Default terminal-verdict wait, matching the CLI's own `test run` default. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** The repo secret the generated workflow reads the API key from. */
const API_KEY_SECRET_NAME = 'TESTSPRITE_API_KEY';

/** The published composite action the workflow delegates to, pinned to a tag. */
const ACTION_REF = 'TestSprite/testsprite-action@v1';

/** The CLI's built-in production endpoint (mirrors `config.ts`). Used to decide
 * whether the generated workflow needs an explicit `endpoint-url`. */
const DEFAULT_API_URL = 'https://api.testsprite.com';

// ── deps / options ───────────────────────────────────────────────────────────

/**
 * Minimal fs seam (mirrors `agent.ts`'s `AgentFs` semantics: exclusive writes to
 * refuse clobbering, recursive mkdir to create parent dirs). Kept local so `ci`
 * doesn't couple to the agent-install internals.
 */
export interface CiFs {
  writeFile(target: string, data: string, opts?: { exclusive?: boolean }): Promise<void>;
  mkdir(dir: string): Promise<void>;
  readFile(target: string): Promise<string>;
}

const defaultCiFs: CiFs = {
  // `target`/`dir` are the workflow output path (default `.github/workflows/testsprite.yml`,
  // or the caller's `--path`), resolved from cwd — a scaffold target the user is writing into
  // their own repo, never external/network input. Same risk profile as agent-install scaffolding.
  writeFile: (target, data, opts) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see above: caller-supplied scaffold output path, not external input.
    nodeFs.writeFile(target, data, { encoding: 'utf8', flag: opts?.exclusive ? 'wx' : 'w' }),
  mkdir: async dir => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- parent dir of the scaffold output path (above).
    await nodeFs.mkdir(dir, { recursive: true });
  },
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads back the scaffold output path for the --force backup, same path as writeFile.
  readFile: target => nodeFs.readFile(target, 'utf8'),
};

/** Injectable subprocess runner (defaults to a real `spawnSync`), so tests never
 * shell out. Runs `git` (default-branch detection), `gh` (optional secret set,
 * deployment history) and `npx vercel` (`ci connect`). */
export type SpawnImpl = (
  cmd: string,
  args: string[],
  opts: { input?: string; cwd?: string; shell?: boolean },
) => SpawnSyncReturns<string>;

const defaultSpawn: SpawnImpl = (cmd, args, opts) =>
  nodeSpawnSync(cmd, args, {
    input: opts.input,
    cwd: opts.cwd,
    encoding: 'utf8',
    shell: opts.shell ?? false,
    windowsHide: true,
  });

export interface CiDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  fs?: CiFs;
  spawn?: SpawnImpl;
  /** Injected by `ci doctor --wait` tests so polling never really sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /** OS seam for the Windows `npx` shim handling (defaults to `process.platform`). */
  platform?: NodeJS.Platform;
}

type CommonOptions = FactoryCommonOptions;

export interface CiInitOptions extends CommonOptions {
  platform: string;
  project?: string;
  filter?: string;
  timeoutSeconds: number;
  workflowPath: string;
  force: boolean;
  setSecret: boolean;
  repo?: string;
}

/** Machine summary emitted under `--output json`. */
export interface CiInitSummary {
  platform: Platform;
  path: string;
  action: string;
  projectId: string;
  wrote: boolean;
  /** Distinguishes the two `wrote: false` cases a scripted caller can't otherwise
   * tell apart: `preview` (a --dry-run) vs `unchanged` (the file was already
   * byte-identical). `written` is the wrote-true case. */
  status: 'written' | 'unchanged' | 'preview';
  backupPath: string | null;
  filter: string | null;
  endpointUrl: string | null;
  endpointWarning: string | null;
  timeoutSeconds: number;
  secret: {
    name: string;
    attempted: boolean;
    set: boolean;
    reason: string | null;
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveCommonOptions(command: Command, env?: NodeJS.ProcessEnv): CommonOptions {
  const g = command.optsWithGlobals() as Partial<CommonOptions> & { requestTimeout?: string };
  return {
    profile: resolveProfileName(g.profile, env),
    output: resolveOutputMode(g.output),
    endpointUrl: g.endpointUrl,
    debug: g.debug ?? false,
    verbose: g.verbose ?? false,
    dryRun: g.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(g.requestTimeout),
  };
}

function makeClient(opts: CommonOptions, deps: CiDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

export function parseTimeoutSeconds(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw localValidationError('timeout', 'must be an integer between 1 and 3600 seconds');
  }
  return n;
}

/**
 * Reject a value that will be interpolated into a double-quoted YAML scalar in
 * the generated workflow. `"` breaks the scalar, a newline breaks the mapping,
 * and `` ` ``/`$` (which also covers `${{ … }}`, evaluated by Actions before the
 * job runs) or `\` could change what the workflow does. A filter is a substring
 * of a test name and a project id/URL never needs any of these, so refusing is
 * safe and keeps the scaffold from ever emitting a workflow GitHub can't parse.
 */
function assertSafeWorkflowValue(
  field: 'filter' | 'project' | 'endpoint-url',
  value: string,
): void {
  if (/[\r\n"`$\\]/.test(value)) {
    throw localValidationError(
      field,
      'must not contain quotes, backticks, $, backslashes, or newlines',
      undefined,
      'field',
    );
  }
}

/**
 * The endpoint the workflow should pin, or undefined for the default production
 * host. Resolved the SAME way the CLI resolves it at runtime (`loadConfig`:
 * flag > TESTSPRITE_API_URL > credentials file > built-in default), so a caller
 * whose profile points at a non-prod backend gets a workflow that targets the
 * same backend their `ci init` just auto-detected the project from — instead of
 * silently emitting a prod workflow that 404s in CI.
 */
function resolveEndpointUrl(opts: CiInitOptions, deps: CiDeps): string | undefined {
  const { apiUrl } = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env: deps.env,
    credentialsPath: deps.credentialsPath,
  });
  const strip = (u: string) => u.replace(/\/+$/, '');
  return strip(apiUrl) === strip(DEFAULT_API_URL) ? undefined : apiUrl;
}

/**
 * The repo's default branch, so the `push` trigger fires there and not on every
 * feature-branch push (each run costs credits). Best-effort via `git`; falls
 * back to `main` on any failure (not a git repo yet, no `origin`, git absent).
 */
function detectDefaultBranch(cwd: string, spawn: SpawnImpl): string {
  try {
    const res = spawn('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd });
    if (!res.error && res.status === 0) {
      const ref = (res.stdout ?? '').trim().replace(/^origin\//, '');
      if (ref && !/[\r\n"`$\\[\]]/.test(ref)) return ref;
    }
  } catch {
    /* fall through to the default */
  }
  return 'main';
}

/**
 * Build the GitHub Actions workflow. It delegates to the published
 * `TestSprite/testsprite-action` (design A) rather than inlining the CLI, so the
 * partial-run guard (`allow-partial: false` by default), the JUnit upload, the
 * annotations, and the CLI-version pin all come from one maintained place.
 */
export function buildGithubWorkflow(input: {
  projectId: string;
  filter?: string;
  timeoutSeconds: number;
  endpointUrl?: string;
  cliVersion: string;
  defaultBranch: string;
}): string {
  assertSafeWorkflowValue('project', input.projectId);
  if (input.filter) assertSafeWorkflowValue('filter', input.filter);
  if (input.endpointUrl) assertSafeWorkflowValue('endpoint-url', input.endpointUrl);

  const withLines = [
    `          api-key: \${{ secrets.${API_KEY_SECRET_NAME} }}`,
    `          project: "${input.projectId}"`,
    `          cli-version: "${input.cliVersion}"`,
    `          timeout: "${input.timeoutSeconds}"`,
    ...(input.filter ? [`          filter: "${input.filter}"`] : []),
    ...(input.endpointUrl ? [`          endpoint-url: "${input.endpointUrl}"`] : []),
  ];

  return `# Generated by \`testsprite ci init github\`. Gates this repo on TestSprite tests.
# The run, the JUnit report, the annotations, and the skipped-test guard all live
# in ${ACTION_REF}; regenerate with \`testsprite ci init github --force\`.
# Note: tests run against the project's CONFIGURED environment, not this PR's code
# (there is no checkout) — a green check means the tests passed, not that the diff is safe.
name: TestSprite

on:
  push:
    branches: ["${input.defaultBranch}"]
  pull_request:

# The job only needs to read the checkout metadata.
permissions:
  contents: read

jobs:
  testsprite:
    runs-on: ubuntu-latest
    # Fork PRs run without repository secrets, so the API key would be empty and
    # this check permanently red. Skip forks (a maintainer's push still runs it).
    if: \${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository }}
    steps:
      - uses: ${ACTION_REF}
        with:
${withLines.join('\n')}
`;
}

/**
 * Resolve the project id the workflow pins. An explicit `--project` always wins.
 * Otherwise, list the caller's projects: exactly one ⇒ use it; zero ⇒ ask them to
 * create one; more than one ⇒ ask them to pass `--project` (never guess). Under
 * `--dry-run` we make no network call — a preview uses a placeholder id.
 */
async function resolveProjectId(opts: CiInitOptions, deps: CiDeps): Promise<string> {
  if (opts.project) return opts.project;
  if (opts.dryRun) return '<your-project-id>';

  const client = makeClient(opts, deps);
  // pageSize=2 is enough to distinguish none / exactly-one / more-than-one
  // without paginating: a full page (or a nextToken) means "more than one".
  const page = await client.get<Page<CliProject>>('/projects?pageSize=2');
  const items = page.items ?? [];
  const only = items[0];
  if (!only) {
    throw localValidationError(
      'project',
      'no projects found for this API key — create one (testsprite project create) or pass --project <id>',
    );
  }
  if (items.length > 1 || page.nextToken) {
    throw localValidationError(
      'project',
      'multiple projects found — pass --project <id> to pick one (list them with: testsprite project list)',
    );
  }
  return only.id;
}

/** Walk `<path>.bak`, `.bak.1`, … until a free slot; write the prior content there. */
async function backupExisting(fs: CiFs, target: string, prior: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? `${target}.bak` : `${target}.bak.${i}`;
    try {
      await fs.writeFile(candidate, prior, { exclusive: true });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new CLIError('Could not find a free .bak slot to back up the existing workflow.', 1);
}

/**
 * Optionally set the repo secret via `gh` (soft dependency — never fails the
 * scaffold). Reads the API key from the resolved profile/env and passes it on
 * STDIN (not argv, so it can't leak via the process list). Absent/unauthed `gh`,
 * or a missing key, degrades to the printed instruction. Runs in `cwd` so `gh`
 * infers the right repo when `--repo` is omitted.
 */
function trySetSecret(
  opts: CiInitOptions,
  deps: CiDeps,
  cwd: string,
): { attempted: boolean; set: boolean; reason: string | null } {
  const spawn = deps.spawn ?? defaultSpawn;
  const { apiKey } = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env: deps.env,
    credentialsPath: deps.credentialsPath,
  });
  if (!apiKey) {
    return { attempted: true, set: false, reason: 'no API key resolved from profile or env' };
  }

  const args = ['secret', 'set', API_KEY_SECRET_NAME];
  if (opts.repo) args.push('--repo', opts.repo);

  let result: SpawnSyncReturns<string>;
  try {
    result = spawn('gh', args, { input: apiKey, cwd });
  } catch (err) {
    return { attempted: true, set: false, reason: `failed to run gh: ${(err as Error).message}` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const reason =
      code === 'ENOENT' ? 'gh CLI not found on PATH' : `gh failed: ${result.error.message}`;
    return { attempted: true, set: false, reason };
  }
  if (result.status !== 0) {
    // gh's stderr can be multi-line and echo back input; keep only the first
    // line so a stray token can never sprawl into the JSON `reason`.
    const stderr = (result.stderr ?? '').split('\n')[0]?.trim() ?? '';
    return {
      attempted: true,
      set: false,
      reason: `gh exited ${result.status}${stderr ? `: ${stderr}` : ''} (is gh authenticated?)`,
    };
  }
  return { attempted: true, set: true, reason: null };
}

// ── orchestrator ─────────────────────────────────────────────────────────────

export async function runCiInit(opts: CiInitOptions, deps: CiDeps = {}): Promise<void> {
  if (!SUPPORTED_PLATFORMS.includes(opts.platform as Platform)) {
    throw localValidationError(
      'platform',
      `unsupported "${opts.platform}" — supported: ${SUPPORTED_PLATFORMS.join(', ')}`,
      undefined,
      'field',
    );
  }
  const platform = opts.platform as Platform;

  // Telemetry facts for this invocation (see lib/telemetry.ts — low-cardinality
  // only: never the path, the project id, or the filter). `workflowExisted` is
  // learned only once the write is attempted, so it is filled in below and the
  // whole set is recorded on every exit path, including a thrown error.
  let workflowExisted: boolean | undefined;
  try {
    await runCiInitScaffold(opts, deps, platform, existed => {
      workflowExisted = existed;
    });
  } finally {
    recordTelemetryExtras({
      platform,
      force: opts.force,
      projectResolved: opts.project ? 'flag' : 'auto',
      ...(workflowExisted !== undefined ? { workflowExisted } : {}),
    });
  }
}

/**
 * The scaffold proper (everything after platform validation). Reports whether a
 * workflow file already existed at the target path via `onExisted` the moment
 * that is known — BEFORE the `--force` decision throws or overwrites. Under
 * `--dry-run` it returns before the write is attempted, so `onExisted` is never
 * called and the fact stays unknown.
 */
async function runCiInitScaffold(
  opts: CiInitOptions,
  deps: CiDeps,
  platform: Platform,
  onExisted: (existed: boolean) => void,
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fs = deps.fs ?? defaultCiFs;
  const spawn = deps.spawn ?? defaultSpawn;
  const cwd = deps.cwd ?? process.cwd();
  const out = new Output(opts.output, { stdout, stderr });

  // Validate the caller's own inputs up front — BEFORE the project-list round
  // trip — so a bad --filter/--project fails fast without a wasted request.
  if (opts.filter) assertSafeWorkflowValue('filter', opts.filter);
  if (opts.project) assertSafeWorkflowValue('project', opts.project);

  const projectId = await resolveProjectId(opts, deps);
  const endpointUrl = resolveEndpointUrl(opts, deps);
  const defaultBranch = detectDefaultBranch(cwd, spawn);
  const workflow = buildGithubWorkflow({
    projectId,
    filter: opts.filter,
    timeoutSeconds: opts.timeoutSeconds,
    endpointUrl,
    cliVersion: VERSION,
    defaultBranch,
  });
  const relPath = opts.workflowPath;
  const absPath = path.isAbsolute(relPath) ? relPath : path.join(cwd, relPath);

  // A loopback / private endpoint pinned into a committed workflow is
  // unreachable from a GitHub-hosted runner (the check reds on first push with
  // nothing explaining why). Reuse `assertNotLocal`'s classifier to WARN — not
  // error, since a self-hosted runner legitimately reaches such hosts.
  let endpointWarning: string | null = null;
  if (endpointUrl) {
    try {
      assertNotLocal(endpointUrl, {
        field: 'endpoint-url',
        helpCommand: 'testsprite ci init',
      });
    } catch {
      endpointWarning = `the workflow pins ${endpointUrl}, which a GitHub-hosted runner cannot reach — pass --endpoint-url <public-url>, or run this workflow on a self-hosted runner.`;
      stderr(`[warn] ${endpointWarning}`);
    }
  }

  const baseSummary = {
    platform,
    path: relPath,
    action: ACTION_REF,
    projectId,
    filter: opts.filter ?? null,
    endpointUrl: endpointUrl ?? null,
    endpointWarning,
    timeoutSeconds: opts.timeoutSeconds,
  };

  // --dry-run: preview to stderr, emit the summary, and make no writes / no gh call.
  if (opts.dryRun) {
    stderr('[dry-run] would write the workflow below — no files changed, no secret set:');
    stderr('');
    for (const line of workflow.split('\n')) stderr(`  ${line}`);
    const summary: CiInitSummary = {
      ...baseSummary,
      wrote: false,
      status: 'preview',
      backupPath: null,
      secret: { name: API_KEY_SECRET_NAME, attempted: false, set: false, reason: null },
    };
    out.print(summary, d => renderCiInitText(d as CiInitSummary));
    return;
  }

  await fs.mkdir(path.dirname(absPath));

  let backupPath: string | null = null;
  let wrote = true;
  try {
    await fs.writeFile(absPath, workflow, { exclusive: true });
    onExisted(false);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EISDIR') {
      throw localValidationError(
        'path',
        `${relPath} is a directory, not a file — pass --path <file> to a writable location`,
        undefined,
        'field',
      );
    }
    if (code !== 'EEXIST') throw err;
    onExisted(true);
    const prior = await fs.readFile(absPath);
    if (prior === workflow) {
      // Already exactly what we'd write — no rewrite, no `.bak` churn. This also
      // makes re-running (with or without --force) on identical content a no-op
      // rather than an error, so it never burns a backup slot.
      wrote = false;
    } else if (!opts.force) {
      throw localValidationError(
        'path',
        `${relPath} already exists — re-run with --force to overwrite (a .bak backup is kept)`,
        undefined,
        'field',
      );
    } else {
      backupPath = await backupExisting(fs, absPath, prior);
      await fs.writeFile(absPath, workflow, { exclusive: false });
    }
  }

  const secret = opts.setSecret
    ? trySetSecret(opts, deps, cwd)
    : { attempted: false, set: false, reason: null };
  if (opts.setSecret && !secret.set) {
    stderr(`[warn] could not set the ${API_KEY_SECRET_NAME} secret (${secret.reason}).`);
  }

  const summary: CiInitSummary = {
    ...baseSummary,
    wrote,
    status: wrote ? 'written' : 'unchanged',
    backupPath: backupPath ? path.relative(cwd, backupPath) : null,
    secret: { name: API_KEY_SECRET_NAME, ...secret },
  };
  out.print(summary, d => renderCiInitText(d as CiInitSummary));
}

// ── ci doctor / ci connect ───────────────────────────────────────────────────

export interface CiDoctorOptions extends CommonOptions {
  repo?: string;
  /** Poll until a NEW deployment record arrives (the post-connect check). */
  wait: boolean;
  /** Bound for `--wait`, in seconds; undefined = `--timeout` was not given. */
  waitTimeoutSeconds?: number;
}

export interface CiDoctorSummary {
  repo: string;
  status: LinkageStatus;
  ok: boolean;
  detail: string;
  lastDeployAt: string | null;
  creators: string[];
  hasPreview: boolean;
  /** Whether this run watched for a new record (`--wait`). */
  waited: boolean;
  /** `--wait` only: the record whose arrival ended the wait, or null. */
  newDeployment: DeploymentRecord | null;
  /** Set when history could not be read at all — then the rest is not a verdict. */
  error: string | null;
}

/** Poll interval for `--wait`. A deploy takes minutes; 15 s keeps it cheap. */
const DOCTOR_POLL_INTERVAL_MS = 15_000;

/**
 * `owner/repo` for the check: the explicit `--repo`, else the `origin` remote.
 * Returns null when neither resolves — the caller turns that into guidance
 * rather than an opaque failure.
 */
export function resolveRepoSlug(
  explicit: string | undefined,
  cwd: string,
  spawn: SpawnImpl,
): string | null {
  if (explicit !== undefined && explicit !== '') {
    return isValidRepoSlug(explicit) ? explicit : null;
  }
  try {
    const res = spawn('git', ['remote', 'get-url', 'origin'], { cwd });
    if (res.error || res.status !== 0) return null;
    return parseRepoSlug(res.stdout ?? '');
  } catch {
    return null;
  }
}

/**
 * Read the repo's deployment history through `gh` — the same soft dependency
 * `--set-secret` already uses, so this adds no new requirement. It carries the
 * user's own GitHub credentials, which a private repo needs.
 */
function fetchDeploymentHistory(
  repo: string,
  cwd: string,
  spawn: SpawnImpl,
): { records: DeploymentRecord[] } | { error: string } {
  let result: SpawnSyncReturns<string>;
  try {
    // 100 (the API maximum) rather than a small page: the classifier separates
    // preview from production records, and a busy repo can push dozens of
    // production deploys past its newest preview — a short page would then read
    // as a false `production-only`.
    result = spawn('gh', ['api', `repos/${repo}/deployments?per_page=100`], { cwd });
  } catch (err) {
    return { error: `failed to run gh: ${(err as Error).message}` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      error:
        code === 'ENOENT'
          ? 'gh CLI not found on PATH — install it (https://cli.github.com), then `gh auth login`'
          : `gh failed: ${result.error.message}`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').split('\n')[0]?.trim() ?? '';
    return { error: `gh exited ${result.status}${stderr ? `: ${stderr}` : ''}` };
  }
  return { records: parseDeploymentsPayload(result.stdout ?? '') };
}

/**
 * Diagnose whether deployment events reach this repo — the precondition every
 * deployment-gated workflow rests on, and the only one that fails *silently*.
 *
 * Exits non-zero when the chain is not live, so a script (or `ci init`) can
 * gate on it. `--wait` makes the post-connect verification one command instead
 * of "go watch GitHub yourself": it baselines the history on the first read and
 * succeeds when a NEW record arrives. That success condition is a hard fact,
 * deliberately independent of the preview/production heuristic — pushing to a
 * default branch produces a *production* deployment, and that still proves the
 * link is live.
 */
export async function runCiDoctor(opts: CiDoctorOptions, deps: CiDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = new Output(opts.output, { stdout, stderr });
  const cwd = deps.cwd ?? process.cwd();
  const spawn = deps.spawn ?? defaultSpawn;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  if (opts.waitTimeoutSeconds !== undefined && !opts.wait) {
    throw localValidationError(
      'timeout',
      'only applies with --wait — add --wait, or drop --timeout',
    );
  }
  const waitTimeoutSeconds = opts.waitTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  const repo = resolveRepoSlug(opts.repo, cwd, spawn);
  if (repo === null) {
    throw localValidationError(
      'repo',
      opts.repo
        ? 'must look like owner/name (e.g. acme/storefront)'
        : 'could not read a GitHub `origin` remote here — run from the repo, or pass --repo <owner/name>',
    );
  }

  const deadline = Date.now() + waitTimeoutSeconds * 1000;
  let verdict: LinkageVerdict | undefined;
  let readError: string | null = null;
  /** Newest record's timestamp on the first successful read; -∞ when it saw none. */
  let baselineNewestMs: number | undefined;
  let newDeployment: DeploymentRecord | null = null;

  for (;;) {
    const budgetLeft = Date.now() + DOCTOR_POLL_INTERVAL_MS <= deadline;
    const history = fetchDeploymentHistory(repo, cwd, spawn);
    if ('error' in history) {
      // A transient `gh` failure (rate limit, network blip) must not abort a
      // ten-minute watch — keep polling while budget remains. It surfaces as
      // exit 10 only when the whole wait ends without one successful read.
      readError = history.error;
      if (!opts.wait || !budgetLeft) break;
      stderr(`[wait] could not read deployment history (${history.error}) — retrying`);
      await sleep(DOCTOR_POLL_INTERVAL_MS);
      continue;
    }
    verdict = classifyLinkage(history.records, new Date());
    if (!opts.wait) break;

    const newestMs = history.records.reduce(
      (max, r) => Math.max(max, new Date(r.createdAt).getTime()),
      Number.NEGATIVE_INFINITY,
    );
    if (baselineNewestMs === undefined) {
      // What already exists only anchors the comparison — `--wait` is about
      // the record the user's connect + push is producing right now.
      baselineNewestMs = newestMs;
    } else if (newestMs > baselineNewestMs) {
      newDeployment =
        history.records.find(r => new Date(r.createdAt).getTime() === newestMs) ?? null;
      break;
    }
    if (!budgetLeft) break;
    stderr(
      `[wait] no new deployment record yet — checking again in ${DOCTOR_POLL_INTERVAL_MS / 1000}s`,
    );
    await sleep(DOCTOR_POLL_INTERVAL_MS);
  }

  // A read failure on the LAST attempt does not erase an earlier verdict; the
  // error only stands when no read ever succeeded.
  const unread = verdict === undefined;
  const summary: CiDoctorSummary = {
    repo,
    status: verdict?.status ?? 'none',
    ok: verdict?.ok ?? false,
    detail: verdict?.detail ?? readError ?? 'could not read deployment history',
    lastDeployAt: verdict?.lastDeployAt ?? null,
    creators: verdict?.creators ?? [],
    hasPreview: verdict?.hasPreview ?? false,
    waited: opts.wait,
    newDeployment,
    error: unread ? readError : null,
  };
  out.print(summary, d => renderCiDoctorText(d as CiDoctorSummary));

  // A read failure is NOT a verdict — reporting "not linked" because `gh` is
  // missing would send the user to fix the wrong thing.
  if (unread) {
    throw new CLIError(`ci doctor: could not read deployment history for ${repo}`, 10);
  }
  // A new record arriving is what `--wait` verifies: events reach this repo.
  // The verdict above still tells the user what KIND of gate that supports.
  if (newDeployment !== null) return;
  if (!summary.ok) {
    throw new CLIError(
      `ci doctor: ${repo} is not ready for a deployment-gated workflow (${summary.status})`,
      1,
    );
  }
}

export function renderCiDoctorText(s: CiDoctorSummary): string {
  const lines: string[] = [];
  const mark = s.error ? '[FAIL]' : s.ok ? '[OK]  ' : '[WARN]';
  lines.push(`${mark} deployment events   ${s.repo}`);
  if (s.newDeployment) {
    const day = s.newDeployment.createdAt.slice(0, 10);
    lines.push(
      `       new deployment record: ${s.newDeployment.environment} (${day}) ✓ — events reach this repo`,
    );
  }
  lines.push(`       ${s.detail}`);
  if (s.error) {
    lines.push('');
    lines.push("Could not read the repo's deployment history, so this is not a verdict:");
    lines.push(`  ${s.error}`);
    return lines.join('\n');
  }
  if (s.waited && !s.newDeployment) {
    lines.push(
      '       (no NEW deployment record arrived while waiting — the verdict above is from the existing history)',
    );
  }
  if (s.ok) return lines.join('\n');

  lines.push('');
  lines.push('Next steps:');
  if (s.status === 'none') {
    lines.push('  1. Link your deploy platform to this repo:');
    lines.push('       testsprite ci connect          # runs `vercel git connect` for you');
    lines.push("     …or link the repo in your platform's dashboard.");
    // A branch, not the default branch: a default-branch push deploys as
    // PRODUCTION, which proves the link but is not what a PR gate keys on.
    lines.push('  2. Push a commit on a branch so a preview deployment lands:');
    lines.push('       git checkout -b verify-testsprite-ci');
    lines.push(
      '       git commit --allow-empty -m "verify testsprite ci" && git push -u origin HEAD',
    );
    lines.push('  3. Confirm the events arrive (any new deployment record counts):');
    lines.push('       testsprite ci doctor --wait');
  } else if (s.status === 'production-only') {
    lines.push('  → Enable preview deployments for pull requests on your deploy platform.');
    lines.push('    A PR gate keys on preview deployments; production-only events fire on');
    lines.push('    releases instead, so the check would never run on a PR.');
  } else {
    lines.push('  → Push a commit and re-run `testsprite ci doctor --wait` to confirm the link');
    lines.push('    is still live before scaffolding a gate on it.');
  }
  lines.push('');
  lines.push('Self-hosted pipeline? Report each deploy yourself, and every path works the same:');
  // `required_contexts: []` is load-bearing: without it GitHub answers 409 when
  // any commit status on the SHA is failing — i.e. exactly when a PR pipeline is
  // deploying its preview. JSON input because `-f` would send the empty array as
  // a string. (Both learned the hard way running this against a real repo.)
  lines.push(
    `  ID=$(printf '{"ref":"%s","environment":"preview","auto_merge":false,"required_contexts":[]}' "$SHA" \\`,
  );
  lines.push(`    | gh api repos/${s.repo}/deployments --input - --jq .id)`);
  lines.push(
    `  gh api repos/${s.repo}/deployments/$ID/statuses -f state=success -f environment_url=$URL`,
  );
  return lines.join('\n');
}

export interface CiConnectOptions extends CommonOptions {
  /** Vercel project to link when this directory is not linked yet. */
  project?: string;
}

export interface CiConnectSummary {
  platform: 'vercel';
  /** The commands that were actually spawned, in order — no secrets in them. */
  ran: string[];
  connected: boolean;
  alreadyConnected: boolean;
  reason: string | null;
}

/**
 * The Vercel CLI, pinned to the major this command's flag semantics were
 * verified against (59.23.2). Unpinned, a breaking Vercel release could change
 * what `--non-interactive` refuses or creates under a tool people run in CI.
 * (Unrelated to the TestSprite CLI's own `latest` policy — this pins a THIRD
 * PARTY whose behavior we shell out to.) Bump deliberately, re-testing the
 * ladder below.
 */
const VERCEL_CLI_SPEC = 'vercel@59';

/** What Vercel accepts as a project name — and all that may reach the Windows
 * shell path below, so keep it strict. */
const VERCEL_PROJECT_NAME_RE = /^[a-z0-9._-]{1,100}$/;

/**
 * `--non-interactive` refusals come back as one JSON object with a `reason`
 * and often a `next[]` of literal commands — relay those, since Vercel's own
 * instructions beat anything we could paraphrase. Anything else falls back to
 * the first non-empty output line.
 */
function vercelFailureDetail(result: SpawnSyncReturns<string>): string {
  for (const chunk of [result.stdout ?? '', result.stderr ?? '']) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as { reason?: unknown; next?: unknown };
      if (typeof parsed.reason === 'string') {
        const next = Array.isArray(parsed.next)
          ? parsed.next.filter((n): n is string => typeof n === 'string')
          : [];
        return next.length > 0 ? `${parsed.reason} — next: ${next.join(' && ')}` : parsed.reason;
      }
    } catch {
      /* prose after all — fall through */
    }
  }
  return (
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`
      .split('\n')
      .find(l => l.trim() !== '')
      ?.trim() ?? ''
  );
}

/**
 * Link the deploy platform to the repo — the fix for `ci doctor`'s `none`.
 *
 * Runs the platform's OWN CLI as a subprocess (`npx vercel …`, so nothing needs
 * pre-installing) rather than calling Vercel's API ourselves. That is a
 * deliberate boundary: any other approach would require the user to hand us a
 * Vercel token, and a third-party credential should never pass through this
 * CLI. Vercel's CLI keeps its own credentials; we only read exit codes.
 *
 * Every step runs `--non-interactive`, and `--yes` is NEVER passed to the
 * Vercel CLI on any path. `--yes` does not mean "skip confirmations": on an
 * unlinked directory `vercel link --yes` answers the new-project questions
 * with the default scope and the current directory name — creating a project
 * nobody asked for, which `git connect` then wires the repo to and starts
 * deploying. `ci doctor` would report that as `linked`: the exact silent
 * false-green this command exists to prevent. When Vercel needs a decision it
 * refuses with a structured reason instead, and that is relayed.
 *
 * `vercel git connect` is effectively idempotent — an already-connected repo
 * says so, which also resolves the one ambiguity `ci doctor` cannot see from
 * GitHub: "never linked" vs "linked but never deployed".
 */
export async function runCiConnect(opts: CiConnectOptions, deps: CiDeps = {}): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = new Output(opts.output, { stdout, stderr });
  const cwd = deps.cwd ?? process.cwd();
  const spawn = deps.spawn ?? defaultSpawn;
  const fs = deps.fs ?? defaultCiFs;
  const platform = deps.platform ?? process.platform;
  const ran: string[] = [];

  // Input gate before any subprocess or fs read: a bad name must fail as a
  // validation error, not as a spawned command's stderr.
  if (opts.project !== undefined && !VERCEL_PROJECT_NAME_RE.test(opts.project)) {
    throw localValidationError(
      'project',
      'must be a Vercel project name (lowercase letters, digits, ".", "_", "-"; max 100 chars)',
    );
  }

  const finish = (over: Partial<CiConnectSummary>, failure?: string): void => {
    const summary: CiConnectSummary = {
      platform: 'vercel',
      ran,
      connected: false,
      alreadyConnected: false,
      reason: null,
      ...over,
    };
    out.print(summary, d => renderCiConnectText(d as CiConnectSummary));
    if (failure !== undefined) throw new CLIError(failure, 1);
  };

  const run = (args: string[]): SpawnSyncReturns<string> | { failure: string } => {
    ran.push(`npx ${VERCEL_CLI_SPEC} ${args.join(' ')}`);
    try {
      // npx's own `--yes` only suppresses its install prompt; nothing after the
      // package spec is a `--yes` (see the function comment). On Windows `npx`
      // is a `.cmd` shim, which `spawnSync` cannot launch with `shell: false`
      // (EINVAL since Node 20.12's CVE-2024-27980 hardening, ENOENT before) —
      // go through the shell there. Safe because every argument is a literal or
      // validated against VERCEL_PROJECT_NAME_RE, never free text.
      return platform === 'win32'
        ? spawn('npx.cmd', ['--yes', VERCEL_CLI_SPEC, ...args], { cwd, shell: true })
        : spawn('npx', ['--yes', VERCEL_CLI_SPEC, ...args], { cwd });
    } catch (err) {
      return { failure: `failed to run npx: ${(err as Error).message}` };
    }
  };

  // `.vercel/project.json` is how the Vercel CLI itself records which project
  // this directory is linked to. Present → the project is already decided and
  // `git connect` is safe to run directly.
  let dirLinked = false;
  try {
    await fs.readFile(path.join(cwd, '.vercel', 'project.json'));
    dirLinked = true;
  } catch {
    /* not linked */
  }

  if (!dirLinked) {
    if (opts.project === undefined || opts.project === '') {
      // Refuse rather than guess: picking (or worse, creating) a project is
      // the one decision this command must never make for the user.
      finish(
        { reason: 'this directory is not linked to a Vercel project' },
        'ci connect: this directory is not linked to a Vercel project — pass --project <name>, or run `npx vercel link` to pick one interactively, then re-run',
      );
      return;
    }
    // `link --project <name>` targets an EXISTING project by name, so it needs
    // no `--yes` and cannot create one as a side effect.
    const link = run(['link', '--project', opts.project, '--non-interactive']);
    if ('failure' in link) {
      finish({ reason: link.failure }, `ci connect: ${link.failure}`);
      return;
    }
    if (link.status !== 0) {
      const detail = vercelFailureDetail(link);
      finish(
        { reason: `vercel link failed${detail ? `: ${detail}` : ''}` },
        `ci connect: could not link this directory to Vercel project "${opts.project}"${detail ? ` — ${detail}` : ''}`,
      );
      return;
    }
  }

  const connect = run(['git', 'connect', '--non-interactive']);
  if ('failure' in connect) {
    finish({ reason: connect.failure }, `ci connect: ${connect.failure}`);
    return;
  }
  // "already connected" is prose on exit 1 with no JSON — Vercel offers no
  // structured way to see it (`project inspect` does not expose git-link
  // state), so a regex on the CLI's wording is load-bearing here. If Vercel
  // rephrases it, this degrades to the generic relay below (a hard failure
  // with Vercel's own message), never to a wrong success.
  const output = `${connect.stdout ?? ''}\n${connect.stderr ?? ''}`;
  const alreadyConnected = /already connected/i.test(output);
  if (connect.status !== 0 && !alreadyConnected) {
    const detail = vercelFailureDetail(connect);
    // The common dead ends — not logged in (browser OAuth), the Vercel GitHub
    // App not installed, missing org permission — all need a human. Relay the
    // CLI's own message verbatim rather than paraphrasing the fix away.
    finish(
      { reason: detail || `vercel git connect exited ${connect.status}` },
      `ci connect: ${detail || 'could not connect the repo'}`,
    );
    return;
  }

  finish({ connected: true, alreadyConnected });
  stderr(
    alreadyConnected
      ? '[info] the repo was already connected — if `ci doctor` still reports no events, it simply has not deployed yet.'
      : '[info] connected. Linking only affects FUTURE pushes.',
  );
  stderr('Next: push a commit on a branch so a preview deployment lands:');
  stderr('  git checkout -b verify-testsprite-ci');
  stderr('  git commit --allow-empty -m "verify testsprite ci" && git push -u origin HEAD');
  stderr('Then: testsprite ci doctor --wait');
}

export function renderCiConnectText(s: CiConnectSummary): string {
  if (s.connected) {
    return s.alreadyConnected
      ? 'Vercel is already connected to this repo.'
      : 'Connected Vercel to this repo.';
  }
  const lines = [`Could not connect automatically: ${s.reason ?? 'unknown reason'}.`, ''];
  lines.push('Do it manually:');
  lines.push('  npx vercel login        # if you are not signed in');
  lines.push('  npx vercel link         # pick the Vercel project for this directory');
  lines.push('  npx vercel git connect  # link it to the git remote');
  lines.push('');
  lines.push('…then re-run `testsprite ci connect`, or finish from the Vercel dashboard');
  lines.push('(Project → Settings → Git).');
  return lines.join('\n');
}

// ── text rendering ───────────────────────────────────────────────────────────

export function renderCiInitText(s: CiInitSummary): string {
  const lines: string[] = [];
  const verb =
    s.status === 'written'
      ? `Wrote ${s.path}`
      : s.status === 'preview'
        ? `Would write ${s.path}`
        : `${s.path} is already up to date`;
  lines.push(`${verb} (${s.action}, project ${s.projectId}).`);
  if (s.backupPath) lines.push(`Backed up the previous file to ${s.backupPath}.`);
  lines.push('');
  lines.push('Next steps:');
  if (s.secret.set) {
    lines.push(`  ✓ ${s.secret.name} repo secret set via gh.`);
    lines.push(`  → Commit and push ${s.path}, then open a PR to see the check.`);
  } else {
    lines.push(`  1. Add the ${s.secret.name} repo secret (the workflow reads the key from it):`);
    lines.push(`       gh secret set ${s.secret.name}          # paste your key when prompted`);
    lines.push('     …or in the GitHub UI: Settings → Secrets and variables → Actions.');
    lines.push(`  2. Commit and push ${s.path}, then open a PR to see the check.`);
  }
  return lines.join('\n');
}

// ── command builder ──────────────────────────────────────────────────────────

export function createCiCommand(deps: CiDeps = {}): Command {
  const ci = new Command('ci').description('Scaffold CI integration for TestSprite');

  ci.command('init <platform>')
    .description('Write a CI workflow that runs your TestSprite tests (platform: github)')
    .option('--project <id>', 'project id to run (auto-detected if you have exactly one)')
    .option('--filter <substr>', 'only run tests whose name contains this substring')
    .option(
      '--timeout <s>',
      'max seconds to wait for a terminal verdict (1-3600)',
      String(DEFAULT_TIMEOUT_SECONDS),
    )
    .option('--path <file>', 'output path for the workflow', DEFAULT_WORKFLOW_PATH)
    .option('--force', 'overwrite an existing workflow (a .bak backup is kept)', false)
    .option(
      '--set-secret',
      `set the ${API_KEY_SECRET_NAME} repo secret via gh (if installed + authenticated); OVERWRITES an existing secret of that name`,
      false,
    )
    .option(
      '--repo <owner/name>',
      'target repo for --set-secret (gh infers from the cwd if omitted)',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (platform: string, cmdOpts, command: Command) => {
      const common = resolveCommonOptions(command, deps.env);
      const opts: CiInitOptions = {
        ...common,
        platform,
        project: cmdOpts.project,
        filter: cmdOpts.filter,
        timeoutSeconds: parseTimeoutSeconds(cmdOpts.timeout),
        workflowPath: cmdOpts.path ?? DEFAULT_WORKFLOW_PATH,
        force: cmdOpts.force ?? false,
        setSecret: cmdOpts.setSecret ?? false,
        repo: cmdOpts.repo,
      };
      await runCiInit(opts, deps);
    });

  ci.command('doctor')
    .description(
      'Check that deployment events reach this repo — the precondition a deployment-gated workflow rests on',
    )
    .option('--repo <owner/name>', 'repo to check (inferred from the `origin` remote if omitted)')
    .option(
      '--wait',
      'keep checking until a NEW deployment record arrives (use right after connecting + pushing)',
      false,
    )
    .option('--timeout <s>', 'with --wait, how long to keep checking (1-3600, default 600)')
    .addHelpText(
      'after',
      '\nWhy this exists:\n' +
        '  A workflow triggered by deployments only fires if the repo actually receives\n' +
        "  GitHub Deployment events. When the deploy platform isn't linked to the repo,\n" +
        '  nothing is ever written and the gate stays silent — with no error anywhere.\n' +
        '\n--wait succeeds when any new deployment record arrives, whatever its\n' +
        'environment — a new record is the hard fact that events reach this repo.\n' +
        '\nExit codes:\n' +
        '  0  events reach this repo (a gate will fire), or --wait saw a new record\n' +
        '  1  no usable events yet — see the printed next steps\n' +
        '  5  validation error (bad --repo, or no GitHub remote here)\n' +
        ' 10  could not read the history (gh missing / unauthenticated) — not a verdict',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts, command: Command) => {
      const common = resolveCommonOptions(command, deps.env);
      await runCiDoctor(
        {
          ...common,
          repo: cmdOpts.repo,
          wait: cmdOpts.wait === true,
          // undefined = flag not given; runCiDoctor refuses it without --wait.
          waitTimeoutSeconds:
            cmdOpts.timeout === undefined ? undefined : parseTimeoutSeconds(cmdOpts.timeout),
        },
        deps,
      );
    });

  ci.command('connect')
    .description('Link your deploy platform (Vercel) to this repo so deployment events are emitted')
    .option(
      '--project <name>',
      'Vercel project to link when this directory is not linked yet (must already exist)',
    )
    .addHelpText(
      'after',
      "\nRuns the platform's own CLI (`npx vercel link` / `vercel git connect`) as a\n" +
        'subprocess, always non-interactively: when a decision is needed (which project\n' +
        'to link) it refuses and says so rather than creating anything you did not pick.\n' +
        'Your Vercel credentials stay with the Vercel CLI — this command never asks for,\n' +
        'stores, or transmits a platform token.\n' +
        '\nNote: `vercel link` itself writes `.vercel/`, may add a VERCEL_OIDC_TOKEN line\n' +
        'to `.env.local`, and may update `.gitignore` — the Vercel CLI’s own behavior.\n' +
        '\nLinking only affects FUTURE pushes: push a commit afterwards, then confirm with\n' +
        '`testsprite ci doctor --wait`.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts, command: Command) => {
      const common = resolveCommonOptions(command, deps.env);
      await runCiConnect({ ...common, project: cmdOpts.project }, deps);
    });

  return ci;
}
