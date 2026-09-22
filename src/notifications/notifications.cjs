const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
    readManagementToken,
    managementPath,
    isReservedProject,
} = require('../management/management-route.cjs');
const { allowedName } = require('../projects/zip-projects.cjs');

const readJson = async (file) =>
    JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
function publicOrigin(value) {
    const url = new URL(value);
    const hostname = url.hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, '')
        .replace(/\.$/, '');
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    )
        return null;
    if (
        !hostname.includes('.') ||
        /(?:^|\.)(?:localhost|local)$/.test(hostname) ||
        /^(?:0|10|127)\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^169\.254\./.test(hostname) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
    )
        return null;
    return url.origin;
}
async function notifyProjectUpdate(
    runtime,
    project,
    reason,
    { fetch: send = globalThis.fetch } = {},
) {
    let temporary;
    try {
        if (
            typeof project !== 'string' ||
            project.includes('/') ||
            !allowedName(project) ||
            isReservedProject(project) ||
            !['upload', 'applied', 'PWA settings'].includes(reason)
        )
            return false;
        const config = await readJson(path.join(runtime, 'ntfy.json'));
        if (
            config.enabled === false ||
            config.updates !== true ||
            typeof config.topic !== 'string' ||
            !/^[A-Za-z0-9_-]{1,64}$/.test(config.topic)
        )
            return false;
        const state = await readJson(path.join(runtime, 'ngrok-state.json'));
        const origin = publicOrigin(state.url);
        if (!origin) return false;
        const url = origin + '/' + encodeURIComponent(project) + '/';
        const actions = [{ action: 'view', label: 'Open page', url }];
        const token = await readManagementToken(runtime);
        if (token)
            actions.push({
                action: 'view',
                label: 'Manage',
                url:
                    origin +
                    managementPath(token) +
                    '#key=' +
                    encodeURIComponent(token) +
                    '&project=' +
                    encodeURIComponent(project),
            });
        const response = await send('https://ntfy.sh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                topic: config.topic,
                title: 'HTML Share updated',
                message: project + ': ' + reason,
                click: url,
                actions,
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return false;
        const result = await response.json();
        if (
            typeof result.id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(result.id)
        )
            return false;
        temporary = path.join(
            runtime,
            'ntfy-last-update-' + randomUUID() + '.tmp',
        );
        await fs.writeFile(
            temporary,
            JSON.stringify({
                id: result.id,
                time: new Date().toISOString(),
                project,
                reason,
            }) + '\n',
            { flag: 'wx' },
        );
        await fs.rename(temporary, path.join(runtime, 'ntfy-last-update.json'));
        temporary = null;
        return true;
    } catch {
        return false;
    } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
    }
}
module.exports = { notifyProjectUpdate };
