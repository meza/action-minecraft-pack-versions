"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_promises = __toESM(require("fs/promises"), 1);
var import_adm_zip = __toESM(require("adm-zip"), 1);
var import_core = __toESM(require("@actions/core"), 1);
var import_p_queue = __toESM(require("p-queue"), 1);
var import_os = require("os");
var import_github = __toESM(require("@actions/github"), 1);
var import_mustache = __toESM(require("mustache"), 1);
var import_node_buffer = require("buffer");
var EST_MEM_PER_JOB = 80 * 2 ** 20;
var MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest.json";
function autoConcurrency() {
  const cpuBound = (0, import_os.cpus)().length;
  const memBound = Math.floor((0, import_os.totalmem)() / EST_MEM_PER_JOB);
  const upperCap = 8;
  return Math.max(1, Math.min(upperCap, cpuBound, memBound));
}
async function fileExists(p) {
  try {
    await import_promises.default.access(p);
    return true;
  } catch {
    return false;
  }
}
async function loadExisting(outFile) {
  return await fileExists(outFile) ? JSON.parse(await import_promises.default.readFile(outFile, "utf8")) : {};
}
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} \u2192 ${res.status}`);
  return await res.json();
}
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} \u2192 ${res.status}`);
  return import_node_buffer.Buffer.from(await res.arrayBuffer());
}
function extractPackVersion(jar) {
  const zip = new import_adm_zip.default(jar);
  const entry = zip.getEntry("version.json");
  if (!entry) throw new Error("version.json not found");
  const ver = JSON.parse(entry.getData().toString("utf8"));
  if (typeof ver.pack_version === "number") {
    return { datapack: ver.pack_version, resourcepack: ver.pack_version };
  }
  const { data, resource } = ver.pack_version;
  return { datapack: data, resourcepack: resource };
}
async function main() {
  const outPath = import_core.default.getInput("output_path") || "formats.json";
  const commitEnabled = import_core.default.getBooleanInput("commit_enabled");
  const commitType = import_core.default.getInput("commit_type");
  const commitScope = import_core.default.getInput("commit_scope");
  const commitTpl = import_core.default.getInput("commit_template");
  const prBranch = import_core.default.getInput("pr_branch");
  const prBase = import_core.default.getInput("pr_base");
  const autoMerge = import_core.default.getBooleanInput("auto_merge");
  const token = import_core.default.getInput("github_token") || process.env.GITHUB_TOKEN;
  import_core.default.setOutput("path", outPath);
  const mapping = await loadExisting(outPath);
  let dirty = false;
  let flushing = false;
  async function flush() {
    if (!dirty || flushing) return;
    flushing = true;
    const tmp = `${outPath}.tmp`;
    await import_promises.default.writeFile(tmp, JSON.stringify(mapping, null, 2), "utf8");
    await import_promises.default.rename(tmp, outPath);
    dirty = false;
    flushing = false;
  }
  ["SIGINT", "SIGTERM", "SIGBREAK"].forEach(
    (sig) => process.once(sig, () => {
      flush().finally(() => process.exit(130));
    })
  );
  process.on("uncaughtException", (err) => {
    console.error(err);
    flush().finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (err) => {
    console.error(err);
    flush().finally(() => process.exit(1));
  });
  process.once("beforeExit", flush);
  const { versions } = await fetchJSON(MANIFEST);
  const referenceVersion = versions.find((v) => v.id === import_core.default.getInput("cutoff_version", {
    required: false,
    trimWhitespace: true
  }) || "18w47b");
  if (!referenceVersion) {
    throw new Error("Reference version `18w47b` not found in the manifest.");
  }
  const referenceTime = new Date(referenceVersion.releaseTime || referenceVersion.time);
  const newVersions = [];
  const concurrency = Number(import_core.default.getInput("concurrency", {
    required: false,
    trimWhitespace: true
  }) || 0) || autoConcurrency();
  import_core.default.info(`Running with concurrency = ${concurrency}`);
  const queue = new import_p_queue.default({ concurrency });
  for (const v of versions) {
    if (mapping[v.id]) continue;
    const versionTime = new Date(v.releaseTime || v.time);
    if (versionTime < referenceTime) {
      if (import_core.default.isDebug()) {
        import_core.default.info(`Skipping ${v.id} (${v.releaseTime || v.time}) as it doesn't have a version json inside.`);
      }
      continue;
    }
    queue.add(async () => {
      const meta = await fetchJSON(v.url);
      try {
        const jar = await fetchBuffer(meta.downloads.client.url);
        const formats = extractPackVersion(jar);
        mapping[v.id] = formats;
        dirty = true;
        newVersions.push(v.id);
        import_core.default.info(`${v.id}: data=${formats.datapack}, res=${formats.resourcepack}`);
      } catch (err) {
        import_core.default.error(`Failed to process ${v.id}: ${err}`);
      }
    });
  }
  await queue.onIdle();
  if (newVersions.length > 0) {
    import_core.default.setOutput("new_versions", newVersions.join(","));
  }
  await flush();
  if (dirty && commitEnabled && token) {
    await createCommitAndPR({
      token,
      outPath,
      prBranch,
      prBase,
      commitTpl,
      commitType,
      commitScope,
      versions: newVersions,
      autoMerge
    });
  }
  import_core.default.setOutput("did_update", dirty);
}
async function createCommitAndPR(opts) {
  const { owner, repo } = import_github.default.context.repo;
  const octo = import_github.default.getOctokit(opts.token);
  const baseRef = await octo.rest.git.getRef({ owner, repo, ref: `heads/${opts.prBase}` });
  const baseSha = baseRef.data.object.sha;
  const headRef = `heads/${opts.prBranch}`;
  try {
    await octo.rest.git.getRef({ owner, repo, ref: headRef });
    await octo.rest.git.updateRef({ owner, repo, ref: headRef, sha: baseSha, force: true });
  } catch {
    await octo.rest.git.createRef({ owner, repo, ref: `refs/${headRef}`, sha: baseSha });
  }
  const commitMsg = import_mustache.default.render(opts.commitTpl, {
    type: opts.commitType,
    scope: opts.commitScope || void 0,
    versions: opts.versions.join(", ")
  });
  const fileContent = await import_promises.default.readFile(opts.outPath);
  const pathInRepo = opts.outPath;
  let sha;
  try {
    const existing = await octo.rest.repos.getContent({ owner, repo, path: pathInRepo, ref: headRef });
    if (!Array.isArray(existing.data) && "sha" in existing.data) sha = existing.data.sha;
  } catch {
  }
  await octo.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch: opts.prBranch,
    path: pathInRepo,
    message: commitMsg,
    content: fileContent.toString("base64"),
    sha
  });
  const prs = await octo.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${opts.prBranch}`,
    base: opts.prBase,
    state: "open"
  });
  let prNumber;
  if (prs.data.length) {
    prNumber = prs.data[0].number;
  } else {
    const pr = await octo.rest.pulls.create({
      owner,
      repo,
      head: opts.prBranch,
      base: opts.prBase,
      title: commitMsg,
      body: `Automated update of **${pathInRepo}**.

Versions added: ${opts.versions.join(", ")}.`
    });
    prNumber = pr.data.number;
  }
  if (opts.autoMerge) {
    await octo.graphql(
      `
      mutation ($pr:ID!){ enablePullRequestAutoMerge
        (input:{pullRequestId:$pr, mergeMethod:SQUASH}) { clientMutationId } }`,
      { pr: `PR_${prNumber}` }
    );
  }
  import_core.default.info(`Pushed commit and PR #${prNumber}`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
