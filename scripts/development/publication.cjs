const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
// Explicit release allowlist: never discover private project or runtime files.
const top = [
    '.editorconfig',
    '.prettierrc.json',
    '.prettierignore',
    '.gitignore',
    '.gitattributes',
    'package.json',
    'package-lock.json',
    'README.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'share.ps1',
];
const folders = ['src', 'scripts', 'tests', 'docs', '.github'];
function files() {
    const result = [...top, 'public/example/hello.html'];

    function visit(directory) {
        for (const entry of fs.readdirSync(path.join(root, directory), {
            withFileTypes: true,
        })) {
            if (entry.isSymbolicLink())
                throw new Error('Release sources must not contain links');
            const relative = directory + '/' + entry.name;
            if (
                relative === 'docs/READINESS.md' ||
                relative === 'docs/research'
            )
                continue;
            if (entry.isDirectory()) visit(relative);
            else if (entry.isFile()) result.push(relative);
        }
    }
    folders.forEach(visit);
    for (const name of result) {
        const info = fs.lstatSync(path.join(root, name));
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error('Invalid release source: ' + name);
    }
    return result.sort();
}
module.exports = { root, files };
