const fs = require('node:fs');
const path = require('node:path');
const { root, files } = require('./publication.cjs');
const destination = path.resolve(
    process.argv[2] || path.join(root, '.runtime', 'source-export'),
);
if (fs.existsSync(destination))
    throw new Error(
        'Choose a new output directory; existing exports are never overwritten',
    );
fs.mkdirSync(destination, { recursive: true });
const names = files();
for (const name of names) {
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, name), target);
}
console.log(`Exported ${names.length} source files to ${destination}`);
