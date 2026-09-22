const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const reservedProject = (name) =>
    ['upload', 'admin', 'manage', 'api', '_manage'].includes(
        String(name).toLowerCase(),
    );
function managementPath(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token))
        throw new Error('Invalid management token');
    return (
        '/_manage/' +
        crypto
            .createHmac('sha256', Buffer.from(token, 'utf8'))
            .update('html-share-admin-route-v1')
            .digest('hex')
            .slice(0, 32) +
        '/'
    );
}
async function readManagementToken(runtime) {
    let token = process.env.HTML_SHARE_UPLOAD_TOKEN;
    if (!token) {
        try {
            token = JSON.parse(
                (
                    await fs.readFile(
                        path.join(runtime, 'upload-auth.json'),
                        'utf8',
                    )
                ).replace(/^\uFEFF/, ''),
            ).token;
        } catch {
            return null;
        }
    }
    return typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token)
        ? token
        : null;
}
module.exports = {
    managementPath,
    readManagementToken,
    reservedProject,
    isReservedProject: reservedProject,
};
