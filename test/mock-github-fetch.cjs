const fs = require('node:fs');
const http = require('node:http');

const manifest = JSON.parse(process.env.TEST_MANIFEST);
const scenario = JSON.parse(process.env.TEST_GITHUB_SCENARIO);
const events = [];
let pullRequestOpen = scenario.existingPr;

function persist() {
  fs.writeFileSync(process.env.TEST_GITHUB_LOG, JSON.stringify({events, pullRequestOpen}));
}

function sendJson(response, data, status = 200) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(data));
}

const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const method = request.method;
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = rawBody ? JSON.parse(rawBody) : undefined;
    events.push({method, path, body});

    if (method === 'GET' && path === '/repos/acme/repo/git/ref/heads/main') {
      sendJson(response, {object: {sha: 'base-sha'}});
    } else if (method === 'GET' && path === '/repos/acme/repo/git/ref/heads/bot/pack-format') {
      scenario.branchExists
        ? sendJson(response, {object: {sha: 'old-head-sha'}})
        : sendJson(response, {message: 'Not Found'}, 404);
    } else if (method === 'GET' && path === '/repos/acme/repo/git/commits/base-sha') {
      sendJson(response, {sha: 'base-sha', tree: {sha: 'base-tree-sha'}, parents: []});
    } else if (method === 'POST' && path === '/repos/acme/repo/git/blobs') {
      sendJson(response, {sha: 'blob-sha'}, 201);
    } else if (method === 'POST' && path === '/repos/acme/repo/git/trees') {
      sendJson(response, {sha: 'tree-sha'}, 201);
    } else if (method === 'POST' && path === '/repos/acme/repo/git/commits') {
      scenario.failAt === 'createCommit'
        ? sendJson(response, {message: 'commit failed'}, 500)
        : sendJson(response, {sha: 'commit-sha'}, 201);
    } else if (method === 'PATCH' && path === '/repos/acme/repo/git/refs/heads/bot/pack-format') {
      if (body.sha === 'base-sha') pullRequestOpen = false;
      sendJson(response, {object: {sha: body.sha}});
    } else if (method === 'POST' && path === '/repos/acme/repo/git/refs') {
      if (body.sha === 'base-sha') pullRequestOpen = false;
      sendJson(response, {object: {sha: body.sha}}, 201);
    } else if (method === 'GET' && path === '/repos/acme/repo/pulls') {
      sendJson(response, pullRequestOpen ? [{number: 17, node_id: 'PR_node'}] : []);
    } else if (method === 'POST' && path === '/repos/acme/repo/pulls') {
      pullRequestOpen = true;
      sendJson(response, {number: 18, node_id: 'PR_new'}, 201);
    } else {
      sendJson(response, {message: `Unexpected request: ${method} ${path}`}, 500);
    }
    persist();
  });
});

server.listen(Number(process.env.TEST_GITHUB_PORT), '127.0.0.1');
server.unref();
process.env.GITHUB_API_URL = `http://127.0.0.1:${process.env.TEST_GITHUB_PORT}`;

global.fetch = async (url) => {
  if (url === 'https://launchermeta.mojang.com/mc/game/version_manifest.json') {
    return Response.json({versions: manifest.versions});
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

