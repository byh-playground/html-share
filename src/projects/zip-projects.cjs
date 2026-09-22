const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const LIMITS = {
    entries: 5000,
    file: 128 * 1024 * 1024,
    total: 512 * 1024 * 1024,
    archive: 256 * 1024 * 1024,
};
const allowedName = (name) =>
    name !== '' &&
    !name.startsWith('.') &&
    !/[\\:\x00-\x1f<>"|?*]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
const inside = (root, file) => {
    const rel = path.relative(root, file);
    return (
        rel === '' ||
        (rel !== '..' &&
            !rel.startsWith('..' + path.sep) &&
            !path.isAbsolute(rel))
    );
};
const stamp = (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
class ZipProjects {
    constructor(cache, limits = LIMITS, publicRoot) {
        this.cache = path.resolve(cache);
        this.limits = limits;
        this.publicRoot = publicRoot;
        this.pending = new Map();
    }
    async load(archive) {
        const stat = await fs.stat(archive);
        const key = crypto
            .createHash('sha256')
            .update(archive + ':' + stamp(stat))
            .digest('hex');
        if (!this.pending.has(key)) {
            const job = this.extract(archive, stat, key);
            this.pending.set(key, job);
            job.catch(() => this.pending.delete(key));
        }
        return this.pending.get(key);
    }
    async extract(archive, stat, key) {
        let temporary;
        try {
            if (stat.size > this.limits.archive)
                throw new Error('ZIP exceeds compressed size limit');
            const data = await fs.readFile(archive);
            if (stamp(await fs.stat(archive)) !== stamp(stat))
                throw new Error('ZIP is still changing; refresh after copying');
            const zip = new AdmZip(data);
            if (zip.getEntryCount() > this.limits.entries)
                throw new Error('ZIP has too many entries');
            const entries = zip.getEntries();
            if (entries.length > this.limits.entries)
                throw new Error('ZIP has too many entries');
            const prepared = [];
            const names = new Set();
            let total = 0;
            for (const entry of entries) {
                const raw = entry.entryName;
                if (
                    raw.startsWith('/') ||
                    raw.includes('\\') ||
                    raw.split('/').some((p) => p === '..' || p === '.')
                )
                    throw new Error('Unsafe ZIP path');
                const parts = raw.replace(/\/$/, '').split('/');
                // macOS metadata and dotfiles are never extracted or exposed.
                if (parts.some((p) => p === '__MACOSX' || p.startsWith('.')))
                    continue;
                if (!parts.every(allowedName))
                    throw new Error('Unsafe ZIP name');
                const mode = (entry.header.attr >>> 16) & 0xf000;
                if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)
                    throw new Error(
                        'ZIP links and special files are not supported',
                    );
                if (entry.header.flags & 1)
                    throw new Error('Encrypted ZIP is not supported');
                const normalized = parts.join('/');
                if (names.has(normalized.toLowerCase()))
                    throw new Error('Duplicate ZIP path');
                names.add(normalized.toLowerCase());
                total += entry.header.size;
                if (
                    entry.header.size > this.limits.file ||
                    total > this.limits.total
                )
                    throw new Error('ZIP exceeds uncompressed size limit');
                prepared.push({ entry, parts });
            }
            await fs.mkdir(this.cache, { recursive: true });
            if ((await fs.lstat(this.cache)).isSymbolicLink())
                throw new Error('ZIP cache cannot be a link');
            const realCache = await fs.realpath(this.cache);
            if (this.publicRoot && inside(this.publicRoot, realCache))
                throw new Error('ZIP cache must be outside public');
            temporary = await fs.mkdtemp(path.join(this.cache, key + '-'));
            for (const { entry, parts } of prepared) {
                const destination = path.join(temporary, ...parts);
                if (!inside(temporary, destination))
                    throw new Error('Unsafe ZIP destination');
                if (entry.isDirectory) {
                    await fs.mkdir(destination, { recursive: true });
                    continue;
                }
                // The library does not cap inflation when the declared size is zero.
                if (entry.header.size === 0 && entry.header.compressedSize > 2)
                    throw new Error('Invalid empty ZIP entry');
                const bytes = entry.getData();
                if (
                    bytes.length !== entry.header.size ||
                    bytes.length > this.limits.file
                )
                    throw new Error('Invalid ZIP size');
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, bytes, { flag: 'wx' });
                const time = entry.header.time;
                if (time instanceof Date && Number.isFinite(time.getTime()))
                    await fs.utimes(destination, time, time);
            }
            if (stamp(await fs.stat(archive)) !== stamp(stat))
                throw new Error('ZIP is still changing; refresh after copying');
            let root = temporary;
            for (;;) {
                const items = await fs.readdir(root, { withFileTypes: true });
                if (items.length !== 1 || !items[0].isDirectory()) break;
                root = path.join(root, items[0].name);
            }
            // A unique, complete snapshot becomes visible only after this promise resolves.
            // Old snapshots are retained so in-flight streams are never deleted underneath.
            return { root };
        } catch (error) {
            if (
                temporary &&
                inside(this.cache, temporary) &&
                path.dirname(temporary) === this.cache
            )
                await fs.rm(temporary, { recursive: true, force: true });
            error.code = 'ZIP_INVALID';
            throw error;
        }
    }
}
module.exports = { ZipProjects, allowedName, inside, LIMITS };
