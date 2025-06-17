import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import AdmZip from 'adm-zip';
const MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest.json';
async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
async function loadExisting(outFile) {
    return (await fileExists(outFile))
        ? JSON.parse(await fs.readFile(outFile, 'utf8'))
        : {};
}
async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`${url} → ${res.status}`);
    return (await res.json());
}
async function fetchBuffer(url) {
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`${url} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}
/** Pull datapack/resourcepack numbers out of client.jar */
function extractPackVersion(jar) {
    const zip = new AdmZip(jar);
    const entry = zip.getEntry('version.json');
    if (!entry)
        throw new Error('version.json not found');
    const ver = JSON.parse(entry.getData().toString('utf8'));
    if (typeof ver.pack_version === 'number') {
        return { datapack: ver.pack_version, resourcepack: ver.pack_version };
    }
    const { data, resource } = ver.pack_version;
    return { datapack: data, resourcepack: resource };
}
async function main() {
    const outPath = process.argv[2] || 'formats.json';
    const mapping = await loadExisting(outPath);
    const { versions } = await fetchJSON(MANIFEST);
    for (const v of versions) {
        if (mapping[v.id])
            continue; // already known
        const meta = await fetchJSON(v.url);
        const jar = await fetchBuffer(meta.downloads.client.url);
        const formats = extractPackVersion(jar);
        mapping[v.id] = formats;
        console.log(`${v.id}: data=${formats.datapack}, res=${formats.resourcepack}`);
    }
    // Write updated map (pretty-printed)
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(mapping, null, 2) + '\n');
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
