const repositoryRoot = require('node:path').resolve(__dirname, '../..');
// Optional local equivalent of the upload page's PWA checkbox.
const path = require('node:path');
const fs = require('node:fs/promises');
const { PwaProjects } = require('../../src/pwa/pwa-projects.cjs');
const { allowedName } = require('../../src/projects/zip-projects.cjs');
(async () => {
    const name = process.argv[2];
    if (
        !name ||
        !allowedName(name) ||
        /[\/\\]/.test(name) ||
        name.toLowerCase() === 'upload'
    )
        throw new Error('Provide a valid project name');
    const root = await fs.realpath(path.join(repositoryRoot, 'public'));
    const directory = path.join(root, name),
        info = await fs.lstat(directory);
    if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (await fs.realpath(directory)) !== directory
    )
        throw new Error('Project must be a regular public directory');
    const pwa = new PwaProjects(root, path.join(repositoryRoot, '.runtime'));
    const settings = await pwa.settings(name);
    if (settings.revision === 'initial' || !settings.enabled)
        await pwa.configure(name, { ...settings, enabled: true });
    console.log(`Shared PWA template enabled: ${name}`);
    console.log(
        'Edit app name, description, and colors in the authenticated upload page.',
    );
    const sources = await fs.readdir(await pwa.directory(name));
    if (sources.some((file) => /\.html?$/i.test(file))) {
        const active = await pwa.resolve(name);
        console.log(`Applied build: ${active.build}`);
    } else console.log('Upload an HTML file to create the first release.');
})().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
