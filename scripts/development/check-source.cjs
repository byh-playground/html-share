const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, files } = require('./publication.cjs');
let checked = 0;
for (const name of files()) {
    const full = path.join(root, name);
    if (/\.(cjs|js)$/.test(name)) {
        const result = spawnSync(process.execPath, ['--check', full], {
            encoding: 'utf8',
            windowsHide: true,
        });
        if (result.status !== 0) {
            process.stderr.write(result.stderr);
            process.exit(1);
        }
        checked++;
    }
    if (/\.(cjs|js|ps1|json|md|yml|yaml|html|css)$/.test(name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (
            /#key=[a-f0-9]{64}\b/i.test(text) ||
            /https:\/\/ntfy\.sh\/html-share-[a-f0-9]{32}\b/i.test(text) ||
            /[A-Z]:[\\/]Users[\\/][^\\/\r\n]+[\\/]/i.test(text)
        )
            throw new Error(
                'Private-machine path or credential-shaped value in release source: ' +
                    name,
            );
    }
}
console.log(`Release source check passed (${checked} JavaScript files).`);
