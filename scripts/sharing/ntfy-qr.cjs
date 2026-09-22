const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');

(async () => {
    const runtime = path.join(__dirname, '../..', '.runtime');
    const { topic } = JSON.parse(
        fs
            .readFileSync(path.join(runtime, 'ntfy.json'), 'utf8')
            .replace(/^\uFEFF/, ''),
    );
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(topic))
        throw new Error('Invalid ntfy topic');
    const link = `ntfy://ntfy.sh/${topic}?display=HTML%20Share`;
    const output = path.join(runtime, 'ntfy-subscribe.png');
    await QRCode.toFile(output, link, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 4,
        scale: 8,
    });
    console.log('Scan with your Android camera, then open in the ntfy app.');
    console.log(await QRCode.toString(link, { type: 'terminal', small: true }));
    console.log(`QR image: ${output}`);
})().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
