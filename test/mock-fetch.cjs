const manifest = JSON.parse(process.env.TEST_MANIFEST);

global.fetch = async (url) => {
  if (url === 'https://launchermeta.mojang.com/mc/game/version_manifest.json') {
    return Response.json({versions: manifest.versions});
  }
  if (url === 'https://example.invalid/version.json') {
    return Response.json({downloads: {client: {url: 'https://example.invalid/client.jar'}}});
  }
  if (url === 'https://example.invalid/client.jar' && manifest.jar) {
    return new Response(Buffer.from(manifest.jar, 'base64'));
  }
  throw new Error(`Unexpected fetch: ${url}`);
};
