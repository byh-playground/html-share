const { spawnSync } = require('node:child_process');
const { root, files } = require('./publication.cjs');

const mode = process.argv[2];
if (!['--write', '--check'].includes(mode)) {
    throw new Error('Use --write or --check');
}
// Format only public source files; never touch private uploads or runtime data.
const targets = files().filter((name) =>
    /\.(cjs|js|json|html|css|ya?ml)$/.test(name),
);
const result = spawnSync(
    process.execPath,
    [require.resolve('prettier/bin/prettier.cjs'), mode, ...targets],
    { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
