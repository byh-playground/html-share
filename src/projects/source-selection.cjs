const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { allowedName } = require('./zip-projects.cjs');

const sourceType = (name) =>
    /\.zip$/i.test(name) ? 'zip' : /\.html?$/i.test(name) ? 'html' : null;
const compareSources = (a, b) =>
    b.info.mtimeMs - a.info.mtimeMs ||
    (sourceType(a.name) === 'zip' ? 0 : 1) -
        (sourceType(b.name) === 'zip' ? 0 : 1) ||
    (sourceType(a.name) === 'zip'
        ? a.name.localeCompare(b.name)
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0);
const identity = (info) =>
    [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, info.mode].join(
        ':',
    );
async function sources(directory) {
    const files = [];
    for (const name of await fs.readdir(directory)) {
        if (!allowedName(name) || !sourceType(name)) continue;
        const file = path.join(directory, name);
        const info = await fs.lstat(file);
        if (info.isFile() && !info.isSymbolicLink())
            files.push({ name, file, info });
    }
    return files.sort(compareSources);
}
async function snapshot(directory) {
    const files = await sources(directory);
    const revision = crypto
        .createHash('sha256')
        .update(
            identity(await fs.lstat(directory)) +
                JSON.stringify(
                    files.map((entry) => [entry.name, identity(entry.info)]),
                ),
        )
        .digest('hex');
    return { files, revision };
}
function listing(project, state) {
    const active = state.files[0]?.name || null;
    return {
        project,
        revision: state.revision,
        active,
        files: state.files.map((entry) => ({
            name: entry.name,
            type: sourceType(entry.name),
            size: entry.info.size,
            modifiedAt: entry.info.mtime.toISOString(),
            active: entry.name === active,
        })),
        cleanup: {
            count: Math.max(0, state.files.length - 1),
            bytes: state.files
                .slice(1)
                .reduce((sum, entry) => sum + entry.info.size, 0),
        },
    };
}
module.exports = {
    sourceType,
    compareSources,
    identity,
    sources,
    snapshot,
    listing,
};
