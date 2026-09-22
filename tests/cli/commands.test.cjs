const repositoryRoot = require('node:path').resolve(__dirname, '../..');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test(
    'help lists all commands/options without creating runtime or starting services',
    { skip: process.platform !== 'win32' },
    async (t) => {
        const fixture = await fs.mkdtemp(
            path.join(os.tmpdir(), 'html-share-help-'),
        );
        t.after(async () => {
            assert.equal(path.dirname(fixture), os.tmpdir());
            await fs.rm(fixture, { recursive: true, force: true });
        });
        await fs.copyFile(
            path.join(repositoryRoot, 'share.ps1'),
            path.join(fixture, 'share.ps1'),
        );
        const source = await fs.readFile(
            path.join(fixture, 'share.ps1'),
            'utf8',
        );
        assert.match(source, /한글 명령 안내/);
        const declaredCommands = [
            ...source
                .match(/\[ValidateSet\(([^)]*)\)\]\[string\]\$Action/)[1]
                .matchAll(/'([^']+)'/g),
        ].map((match) => match[1]);
        const parameterBlock = source.slice(
            source.indexOf('param('),
            source.indexOf('\n)', source.indexOf('param(')),
        );
        const declaredOptions = [
            ...parameterBlock.matchAll(/\[(?:string|int|switch)\]\$(\w+)/g),
        ].map((match) => '-' + match[1]);
        for (const args of [['help'], ['-Help'], ['-h']]) {
            const result = spawnSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    path.join(fixture, 'share.ps1'),
                    ...args,
                ],
                { encoding: 'utf8', windowsHide: true, timeout: 15000 },
            );
            assert.equal(result.status, 0, result.stderr);
            for (const word of [...declaredCommands, ...declaredOptions])
                assert.ok(
                    result.stdout.includes(word),
                    'Missing help entry: ' + word,
                );
        }
        assert.deepEqual(await fs.readdir(fixture), ['share.ps1']);
    },
);

test(
    'ntfy CLI preserves the topic and key, opts updates in explicitly, and validates switches',
    { skip: process.platform !== 'win32' },
    async (t) => {
        const fixture = await fs.mkdtemp(
            path.join(os.tmpdir(), 'html-share-commands-'),
        );
        t.after(async () => {
            assert.equal(path.dirname(fixture), os.tmpdir());
            await fs.rm(fixture, { recursive: true, force: true });
        });
        await fs.copyFile(
            path.join(repositoryRoot, 'share.ps1'),
            path.join(fixture, 'share.ps1'),
        );
        await fs.mkdir(path.join(fixture, 'scripts/sharing'), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(fixture, 'scripts/sharing', 'ntfy-qr.cjs'),
            'console.log("QR rendering is covered by qr.test.cjs");',
        );
        await fs.mkdir(path.join(fixture, 'node_modules', 'adm-zip'), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(fixture, 'node_modules', 'adm-zip', 'package.json'),
            '{}',
        );
        await fs.mkdir(path.join(fixture, '.runtime'));
        const key = JSON.stringify({ token: 'e'.repeat(64) });
        await fs.writeFile(
            path.join(fixture, '.runtime', 'upload-auth.json'),
            key,
        );
        const run = (...args) =>
            spawnSync(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-ExecutionPolicy',
                    'Bypass',
                    '-File',
                    path.join(fixture, 'share.ps1'),
                    ...args,
                ],
                { encoding: 'utf8', windowsHide: true, timeout: 15000 },
            );
        const read = async () =>
            JSON.parse(
                (
                    await fs.readFile(
                        path.join(fixture, '.runtime', 'ntfy.json'),
                        'utf8',
                    )
                ).replace(/^\uFEFF/, ''),
            );
        for (const [args, enabled, updates] of [
            [['ntfy', '-Topic', 'html-share-command-test'], true, false],
            [['ntfy', '-Updates'], true, true],
            [['ntfy', '-Disable'], false, true],
            [['ntfy'], true, true],
            [['ntfy', '-NoUpdates'], true, false],
        ]) {
            const result = run(...args);
            assert.equal(result.status, 0, result.stderr);
            const settings = await read();
            assert.equal(settings.topic, 'html-share-command-test');
            assert.equal(settings.enabled, enabled);
            assert.equal(settings.updates, updates);
        }
        assert.notEqual(run('ntfy', '-Updates', '-NoUpdates').status, 0);
        assert.notEqual(run('notify', '-Manage', '-Project', 'demo').status, 0);
        assert.equal(
            await fs.readFile(
                path.join(fixture, '.runtime', 'upload-auth.json'),
                'utf8',
            ),
            key,
        );
        const rotateTest = path.join(fixture, 'rotate-test.ps1');
        await fs.writeFile(
            rotateTest,
            `$ErrorActionPreference='Stop'
$runtimeDir=Join-Path $PSScriptRoot '.runtime'
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'share.ps1'),[ref]$null,[ref]$null)
$fn=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Rotate-ManagementKey'},$true)
. ([scriptblock]::Create($fn.Extent.Text))
Rotate-ManagementKey
`,
        );
        const rotated = spawnSync(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', rotateTest],
            { encoding: 'utf8', windowsHide: true, timeout: 15000 },
        );
        assert.equal(rotated.status, 0, rotated.stderr);
        const newKey = JSON.parse(
            await fs.readFile(
                path.join(fixture, '.runtime', 'upload-auth.json'),
                'utf8',
            ),
        ).token;
        assert.match(newKey, /^[a-f0-9]{64}$/);
        assert.notEqual(newKey, 'e'.repeat(64));
    },
);
