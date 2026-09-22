const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const {
    managementPath,
    readManagementToken,
    isReservedProject,
} = require('../../src/management/management-route.cjs');
const { allowedName } = require('../../src/projects/zip-projects.cjs');

function publicBase(value) {
    const url = new URL(value);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    )
        throw new Error(
            'A running public HTTPS tunnel is required for phone QR codes',
        );
    return url.origin;
}
function projectUrl(base, project) {
    if (
        !project ||
        !allowedName(project) ||
        /[\/\\]/.test(project) ||
        isReservedProject(project)
    )
        throw new Error('Choose a valid project');
    return publicBase(base) + '/' + encodeURIComponent(project) + '/';
}
function manageUrl(base, token) {
    return publicBase(base) + managementPath(token) + '#key=' + token;
}
async function generate(root, project) {
    const runtime = path.join(root, '.runtime');
    const state = JSON.parse(
        (
            await fs.readFile(path.join(runtime, 'ngrok-state.json'), 'utf8')
        ).replace(/^\uFEFF/, ''),
    );
    let url, output;
    if (project) {
        url = projectUrl(state.url, project);
        const directory = path.join(root, 'public', project),
            info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new Error('Project does not exist');
        output = path.join(
            runtime,
            'project-qr-' +
                crypto
                    .createHash('sha256')
                    .update(project)
                    .digest('hex')
                    .slice(0, 12) +
                '.png',
        );
    } else {
        const token = await readManagementToken(runtime);
        if (!token)
            throw new Error(
                'Management key missing; run share.ps1 start first',
            );
        url = manageUrl(state.url, token);
        output = path.join(runtime, 'manage-qr.png');
    }
    await QRCode.toFile(output, url, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 4,
        scale: 8,
    });
    return { url, output, private: !project };
}
if (require.main === module) {
    const project = process.argv[2];
    generate(path.resolve(__dirname, '../..'), project)
        .then(async (result) => {
            console.log(
                result.private
                    ? 'PRIVATE management QR - scan with your phone. Keep it to yourself.'
                    : 'PUBLIC project QR - safe to share with visitors.',
            );
            console.log(
                await QRCode.toString(result.url, {
                    type: 'terminal',
                    small: true,
                }),
            );
            console.log('QR image: ' + result.output);
            console.log('Link: ' + result.url);
        })
        .catch((error) => {
            console.error(error.message);
            process.exitCode = 1;
        });
}
module.exports = { publicBase, projectUrl, manageUrl, generate };
