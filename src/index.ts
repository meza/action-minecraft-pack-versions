import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import {getInput, getBooleanInput, info, error, setOutput, isDebug} from '@actions/core';
import PQueue from 'p-queue';
import { cpus, totalmem } from 'os';
import github from '@actions/github';
import Mustache from 'mustache';
import { Buffer } from 'node:buffer';

/** Approximate bytes of heap required while a JAR is in memory. */
const EST_MEM_PER_JOB = 80 * 2**20;   // 80 MiB

type Mapping = Record<string, { datapack: number; resourcepack: number }>;

const MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';

function autoConcurrency(): number {
    const cpuBound = cpus().length;                         // logical cores
    const memBound = Math.floor(totalmem() / EST_MEM_PER_JOB);
    const upperCap = 8;                                     // safety-limit

    return Math.max(1, Math.min(upperCap, cpuBound, memBound));
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function loadExisting(outFile: string): Promise<Mapping> {
    return (await fileExists(outFile))
        ? JSON.parse(await fs.readFile(outFile, 'utf8'))
        : {};
}

async function fetchJSON<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return (await res.json()) as T;
}

async function fetchBuffer(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/** Pull datapack/resourcepack numbers out of client.jar */
function extractPackVersion(jar: Buffer): { datapack: number; resourcepack: number } {
    const zip = new AdmZip(jar);
    const entry = zip.getEntry('version.json');
    if (!entry) throw new Error('version.json not found');
    const ver = JSON.parse(entry.getData().toString('utf8'));
    if(isDebug()) {
        info(JSON.stringify(ver));
    }
    if (typeof ver.pack_version === 'number') {
        return {datapack: ver.pack_version, resourcepack: ver.pack_version};
    }
    if ('data' in ver.pack_version && 'resource' in ver.pack_version) {
        return {datapack: ver.pack_version.data, resourcepack: ver.pack_version.resource};
    }
    // New format: data_major/data_minor, resource_major/resource_minor
    const normalize = (major: number, minor: number) => minor === 0 ? Number(major) : Number(`${major}.${minor}`);
    return {
        datapack: normalize(ver.pack_version.data_major, ver.pack_version.data_minor),
        resourcepack: normalize(ver.pack_version.resource_major, ver.pack_version.resource_minor)
    };
}

async function main() {
    const outPath = getInput("output_path") || 'formats.json';
    const commitEnabled = getBooleanInput('commit_enabled');
    const commitType    = getInput('commit_type');
    const commitScope   = getInput('commit_scope');
    const commitTpl     = getInput('commit_template');
    const prBranch      = getInput('pr_branch');
    const prBase        = getInput('pr_base');
    const autoMerge     = getBooleanInput('auto_merge');
    const token         = getInput('github_token') || process.env.GITHUB_TOKEN;


    setOutput("path", outPath);

    const mapping = await loadExisting(outPath);

    let dirty = false;                // tracks whether anything new was added
    let flushing = false;             // prevents double-flushes

    async function flush(): Promise<void> {
        if (!dirty || flushing) return;
        flushing = true;
        const tmp = `${outPath}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(mapping, null, 2), 'utf8'); // atomic
        await fs.rename(tmp, outPath);
        dirty = false;
        flushing = false;
    }

// Flush on ^C, “Stop workflow”, time-outs, etc.
    ['SIGINT', 'SIGTERM', 'SIGBREAK'].forEach(sig =>
        process.once(sig as NodeJS.Signals, () => {
            flush().finally(() => process.exit(130));   // 130 = 128 + SIGINT
        })
    );

// Flush on unhandled errors
    process.on('uncaughtException', err => {
        console.error(err);
        flush().finally(() => process.exit(1));
    });
    process.on('unhandledRejection', err => {
        console.error(err);
        flush().finally(() => process.exit(1));
    });

// Optional: final safety-net if nothing else fired
    process.once('beforeExit', flush);

    const {versions} = await fetchJSON<{
        versions: {
            releaseTime: string;
            time: string;
            id: string; url: string
        }[]
    }>(MANIFEST);

    const cutoffVersion = getInput("cutoff_version", {
        required: false,
        trimWhitespace: true
    }) || '18w47a';

    const referenceVersion = versions.find(v => v.id === cutoffVersion);

    if(isDebug()) {
        info(`Cutoff version: ${cutoffVersion}`);
        info(`Reference version found: ${!!referenceVersion}`);
        info(`Reference version details: ${JSON.stringify(referenceVersion)}`);
    }

    if (!referenceVersion) {
        throw new Error(`Reference version ${cutoffVersion} not found in the manifest.`);
    }

    const referenceTime = new Date(referenceVersion.releaseTime || referenceVersion.time);
    const newVersions: string[] = [];

    // Honour a user-supplied override, else fall back to the heuristic.
    const concurrency =
        Number(getInput("concurrency", {
            required: false,
            trimWhitespace: true
        }) || 0) || autoConcurrency();

    info(`Running with concurrency = ${concurrency}`);
    info(`Reference version: ${referenceVersion.id} (${referenceVersion.releaseTime || referenceVersion.time})`);

    const queue = new PQueue({ concurrency: concurrency });

    for (const v of versions) {
        if (mapping[v.id]) continue; // Skip already processed versions

        const versionTime = new Date(v.releaseTime || v.time);
        if (versionTime < referenceTime) {
            if (isDebug()) {
                info(`Skipping ${v.id} (${v.releaseTime || v.time}) as it doesn't have a version json inside.`);
            }
            continue; // Skip versions before the reference version
        }
        queue.add(async () => {
            const meta = await fetchJSON<{ downloads: { client: { url: string } } }>(v.url);

            try {
                const jar = await fetchBuffer(meta.downloads.client.url);
                const formats = extractPackVersion(jar);
                if(isDebug()) {
                    info(JSON.stringify(formats));
                }
                mapping[v.id] = formats;
                dirty = true;
                newVersions.push(v.id);

                info(`${v.id}: data=${formats.datapack}, res=${formats.resourcepack}`);
            } catch (err) {
                error(`Failed to process ${v.id}: ${err}`);
            }
        });
    }

    await queue.onIdle();

    // Write new versions to GITHUB_OUTPUT for GitHub Actions
    if (newVersions.length > 0) {
        setOutput("new_versions", newVersions.join(','));
    }

    await flush();

    if (dirty && commitEnabled && token) {
        await createCommitAndPR({
            token, outPath, prBranch, prBase, commitTpl,
            commitType, commitScope, versions: newVersions, autoMerge
        });
    }

    setOutput('did_update', dirty);  // or use your existing logic
}


async function createCommitAndPR(opts: {
    token: string;
    outPath: string;
    prBranch: string;
    prBase: string;
    commitTpl: string;
    commitType: string;
    commitScope: string;
    versions: string[];
    autoMerge: boolean;
}) {
    const {owner, repo} = github.context.repo;
    const octo = github.getOctokit(opts.token);

    // 1. Resolve base SHA
    const baseRef = await octo.rest.git.getRef({owner, repo, ref: `heads/${opts.prBase}`});
    const baseSha = baseRef.data.object.sha;

    // 2. Create or reset branch
    const headRef = `heads/${opts.prBranch}`;
    try {
        await octo.rest.git.getRef({owner, repo, ref: headRef});
        await octo.rest.git.updateRef({owner, repo, ref: headRef, sha: baseSha, force: true});
    } catch {
        await octo.rest.git.createRef({owner, repo, ref: `refs/${headRef}`, sha: baseSha});
    }

    // 3. Build commit message from template
    const commitMsg = Mustache.render(opts.commitTpl, {
        type: opts.commitType,
        scope: opts.commitScope || undefined,
        versions: opts.versions.join(', ')
    });

    // 4. Push the file
    const fileContent = await fs.readFile(opts.outPath);
    const pathInRepo  = opts.outPath;                // same relative path
    let sha: string | undefined;

    try {
        const existing = await octo.rest.repos.getContent({owner, repo, path: pathInRepo, ref: headRef});
        if (!Array.isArray(existing.data) && 'sha' in existing.data) sha = existing.data.sha;
    } catch {/* file doesn’t exist yet */}

    await octo.rest.repos.createOrUpdateFileContents({
        owner, repo, branch: opts.prBranch, path: pathInRepo,
        message: commitMsg,
        content: fileContent.toString('base64'),
        sha
    });

    // 5. Create or reuse a PR
    const prs = await octo.rest.pulls.list({
        owner, repo, head: `${owner}:${opts.prBranch}`, base: opts.prBase, state: 'open'
    });

    let prNumber: number;
    if (prs.data.length) {
        prNumber = prs.data[0].number;
    } else {
        const pr = await octo.rest.pulls.create({
            owner, repo, head: opts.prBranch, base: opts.prBase, title: commitMsg,
            body: `Automated update of **${pathInRepo}**.\n\nVersions added: ${opts.versions.join(', ')}.`
        });
        prNumber = pr.data.number;
    }

    // 6. Enable auto-merge if requested
    if (opts.autoMerge) {
        await octo.graphql(`
      mutation ($pr:ID!){ enablePullRequestAutoMerge
        (input:{pullRequestId:$pr, mergeMethod:SQUASH}) { clientMutationId } }`,
            {pr: `PR_${prNumber}`});
    }

    info(`Pushed commit and PR #${prNumber}`);
}


main().catch(err => {
    console.error(err);
    process.exit(1);
});
