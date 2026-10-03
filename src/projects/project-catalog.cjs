const fs = require('node:fs/promises');
const path = require('node:path');
const { allowedName, inside } = require('./zip-projects.cjs');
const { isReservedProject } = require('../management/management-route.cjs');

const problem = (status, message) =>
    Object.assign(new Error(message), { status });

const validProjectName = (name) =>
    typeof name === 'string' &&
    name.length <= 180 &&
    !name.includes('/') &&
    allowedName(name) &&
    !isReservedProject(name);

const validDisplayName = (value) =>
    typeof value === 'string' &&
    value === value.trim() &&
    [...value].length >= 1 &&
    [...value].length <= 80 &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value);

async function noSymlinks(file) {
    const full = path.resolve(file);
    const parsed = path.parse(full);
    let current = parsed.root;
    for (const part of full
        .slice(parsed.root.length)
        .split(path.sep)
        .filter(Boolean)) {
        current = path.join(current, part);
        try {
            if ((await fs.lstat(current)).isSymbolicLink())
                throw problem(500, 'Unsafe project storage');
        } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
    }
}

class ProjectCatalog {
    constructor(publicRoot, projectsRoot) {
        this.publicRoot = path.resolve(publicRoot);
        this.projectsRoot = path.resolve(projectsRoot);
        if (inside(this.publicRoot, this.projectsRoot))
            throw new Error('Project metadata must be outside public');
    }

    metadata(name) {
        if (!validProjectName(name)) throw problem(400, 'Invalid project name');
        return path.join(this.projectsRoot, name, 'project.json');
    }

    async displayName(name) {
        const file = this.metadata(name);
        try {
            await noSymlinks(file);
            const data = JSON.parse(await fs.readFile(file, 'utf8'));
            return validDisplayName(data.displayName) ? data.displayName : name;
        } catch {
            return name;
        }
    }

    async create(name, displayName) {
        const metadata = this.metadata(name);
        if (!validDisplayName(displayName))
            throw problem(400, 'Invalid display name');
        const publicDirectory = path.join(this.publicRoot, name);
        const privateDirectory = path.dirname(metadata);
        await noSymlinks(this.publicRoot);
        await noSymlinks(this.projectsRoot);
        await fs.mkdir(this.projectsRoot, { recursive: true });
        await noSymlinks(this.projectsRoot);
        let privateCreated = false;
        let metadataCreated = false;
        try {
            try {
                await fs.lstat(publicDirectory);
                throw problem(409, 'Project already exists');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            try {
                await fs.mkdir(privateDirectory);
                privateCreated = true;
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                const info = await fs.lstat(privateDirectory);
                if (!info.isDirectory() || info.isSymbolicLink())
                    throw problem(409, 'Project metadata path is in use');
            }
            await noSymlinks(metadata);
            try {
                const handle = await fs.open(metadata, 'wx');
                metadataCreated = true;
                try {
                    await handle.writeFile(
                        JSON.stringify({ displayName }) + '\n',
                    );
                } finally {
                    await handle.close();
                }
            } catch (error) {
                if (error.code === 'EEXIST')
                    throw problem(409, 'Project metadata already exists');
                throw error;
            }
            try {
                await fs.mkdir(publicDirectory);
            } catch (error) {
                if (error.code === 'EEXIST')
                    throw problem(409, 'Project already exists');
                throw error;
            }
            return { name, displayName };
        } catch (error) {
            if (metadataCreated) await fs.unlink(metadata).catch(() => {});
            if (privateCreated)
                await fs.rmdir(privateDirectory).catch(() => {});
            throw error;
        }
    }
}

module.exports = { ProjectCatalog };
