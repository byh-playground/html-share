<#
.SYNOPSIS
HTML Share 실행·관리 도구. 전체 한글 도움말: .\share.ps1 help
.DESCRIPTION
로컬 웹 서버, ngrok 외부 공유, 비공개 관리 QR, PWA, 선택형 ntfy 알림을 관리합니다.
help는 서버를 실행하거나 인증 키·설정을 변경하지 않습니다.
.PARAMETER Action
실행할 명령입니다. 생략하면 start입니다.
setup, doctor, start, local, stop, status, configure, manage, qr, upload, pwa, ntfy, notify, help를 지원합니다.
.PARAMETER Port
start/local의 로컬 포트입니다. 기본값 8787, 범위 1024~65535입니다.
이미 실행 중이면 stop 후 포트를 바꿔 시작하세요.
.PARAMETER Provider
start/setup의 터널 제공자: cloudflare(무료 Quick Tunnel) 또는 ngrok.
선택은 저장되어 다음 start에 재사용됩니다. 최초 기본값은 ngrok입니다.
.PARAMETER Topic
ntfy 구독 토픽입니다. ntfy 명령에 사용합니다.
영문·숫자·밑줄·하이픈으로 1~64자입니다.
.PARAMETER Project
pwa, qr, notify의 대상 프로젝트 이름입니다. pwa에는 필수입니다.
공백이 있는 이름은 따옴표로 감싸세요.
.PARAMETER Disable
ntfy 알림을 모두 끕니다. 기존 토픽과 설정값·관리 키는 보존합니다.
.PARAMETER Updates
ntfy의 업로드·재적용·PWA 설정 저장 성공 자동 알림을 켭니다.
.PARAMETER NoUpdates
ntfy의 자동 업데이트 알림만 끄고 서버 시작 알림은 켭니다.
.PARAMETER Manage
notify에서 기존 비공개 관리 링크를 휴대폰으로 다시 보냅니다.
Project 옵션과 함께 사용할 수 없습니다.
.PARAMETER Rotate
manage 또는 upload에서 관리 인증 키와 URL을 새로 발급합니다.
기존 관리 링크·QR은 무효화됩니다. 프로젝트 공개 주소는 유지됩니다.
.PARAMETER Help
아무 작업 없이 전체 한글 명령 안내를 표시합니다. 별칭은 h입니다.
.PARAMETER Local
manage 또는 upload에서 외부 주소 대신 이 PC의 로컬 관리 주소를 표시합니다.
ngrok 실행 여부나 전송량 한도와 관계없이 동작하며 기존 공개 링크를 변경하지 않습니다.
.EXAMPLE
.\share.ps1 help
전체 명령과 옵션을 한글로 확인합니다.
.EXAMPLE
.\share.ps1 start -Port 8788
8788 포트로 외부 공유를 시작합니다.
.EXAMPLE
.\share.ps1 manage -Rotate
기존 관리 링크를 폐기하고 새 관리 URL을 발급합니다.
.EXAMPLE
.\share.ps1 notify -Manage
기존 관리 링크를 재발급 없이 휴대폰으로 다시 보냅니다.
.EXAMPLE
.\share.ps1 ntfy -Updates
업로드·재적용·PWA 설정 저장 성공 시 자동 알림을 켭니다.
#>
param(
    [Parameter(Position = 0)]
    [ValidateSet('setup', 'doctor', 'start', 'local', 'stop', 'status', 'configure', 'ntfy', 'notify', 'manage', 'qr', 'upload', 'pwa', 'help')][string]$Action = 'start',
    [ValidateRange(1024, 65535)][int]$Port = 8787,
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$Topic,
    [string]$Project,
    [switch]$Disable,
    [switch]$Updates,
    [switch]$NoUpdates,
    [switch]$Manage,
    [switch]$Rotate,
    [Alias('h')][switch]$Help,
    [switch]$Local,
    [ValidateSet('ngrok','cloudflare')][string]$Provider
)
if ($Help -or $Action -eq 'help') {
    @'
HTML Share — 한글 명령 안내

사용법: .\share.ps1 <명령> [옵션]
명령을 생략하면 start(외부 공유 시작)를 실행합니다.

[처음 시작]
  setup [-Provider 이름]   npm 의존성과 선택한 공식 터널 실행 파일을 설치합니다.
  doctor                   실행 환경과 설정 존재 여부를 확인합니다.
  start [-Port 8787]       외부 공유 시작. 최초 1회 ngrok 토큰을 입력합니다.
                           공개 주소와 비공개 관리 QR을 표시합니다.
  start -Provider cloudflare  계정 없이 Quick Tunnel로 전환합니다. 다음 start에도 유지됩니다.
  start -Provider ngrok    기존 ngrok 설정으로 복귀합니다.
  local [-Port 8787]       로컬 서버를 시작합니다. 이미 켜진 외부 터널은 유지합니다.
                           외부 공유 없이 시작하려면 stop 후 local을 실행하세요.
  status                   서버·터널 실행 상태와 현재 주소를 확인합니다.
  stop                     이 폴더의 서버·터널·자동 재연결을 종료합니다.
  configure                ngrok 인증 토큰을 다시 저장합니다. 관리 키와는 다릅니다.

[관리 링크와 QR]
  manage                   기존 비공개 관리 링크와 QR을 다시 표시합니다.
  manage -Local            이 PC의 로컬 관리 주소를 표시합니다. ngrok 한도와 무관합니다.
  manage -Rotate           관리 키·URL을 새로 발급합니다. 기존 링크·QR은 무효화됩니다.
  upload                   manage와 같은 동작을 하는 기존 호환 명령입니다.
  qr                       기존 비공개 관리 QR을 다시 표시합니다.
  qr -Project 이름         방문자에게 전달할 프로젝트 공개 QR을 표시합니다.
  pwa -Project 이름        해당 프로젝트에 공용 PWA 템플릿을 적용합니다.

[선택 기능: ntfy 알림]
  ntfy [-Topic 이름]        토픽을 설정·재사용하고 구독 QR과 시작 알림을 켭니다.
  ntfy -Updates            업로드·재적용·PWA 설정 저장 성공 자동 알림을 켭니다.
  ntfy -NoUpdates          자동 업데이트 알림만 끄고 시작 알림은 켭니다.
  ntfy -Disable            모든 알림을 끕니다. 토픽·이전 선택·관리 키는 보존합니다.
  notify                   현재 공개 링크와 관리 버튼이 담긴 알림을 보냅니다.
  notify -Manage           기존 관리 링크를 휴대폰으로 다시 보냅니다. 재발급하지 않습니다.
  notify -Project 이름     해당 프로젝트의 현재 페이지 링크를 보냅니다.

[옵션 전체]
  -Action 명령             첫 번째 위치 인수 대신 명령 이름을 지정합니다.
  -Port 숫자               start/local에서 사용. 기본 8787, 범위 1024~65535.
  -Provider 이름           start/setup 전용. cloudflare 또는 ngrok, 선택값을 저장합니다.
  -Topic 이름              ntfy에서 사용. 영문·숫자·밑줄·하이픈 1~64자.
  -Project 이름            pwa, qr, notify에서 사용. 공백이 있으면 따옴표로 감쌉니다.
  -Manage                  notify 전용. -Project와 함께 사용할 수 없습니다.
  -Rotate                  manage/upload 전용. 서버 실행 중에만 재발급합니다.
  -Local                   manage/upload 전용. 공개 주소 대신 127.0.0.1 관리 주소를 표시합니다.
  -Disable                 ntfy 전체 알림 끄기.
  -Updates                 ntfy 자동 업데이트 알림 켜기.
  -NoUpdates               ntfy 자동 업데이트 알림만 끄기.
                           위 세 가지 알림 옵션은 동시에 선택하지 않습니다.
  -Help 또는 -h            이 도움말만 표시합니다.
  -?                       PowerShell 기본 도움말을 표시합니다.

[자주 쓰는 흐름]
  처음 설치:       .\share.ps1 setup
  외부 공유 시작:  .\share.ps1 start
  관리 링크 확인:  .\share.ps1 manage
  로컬에서 관리:   .\share.ps1 manage -Local
  새 관리 URL:     .\share.ps1 manage -Rotate
  공개 QR:         .\share.ps1 qr -Project "내 프로젝트"
  링크 다시 받기:  .\share.ps1 notify -Manage
  종료:            .\share.ps1 stop

[구분해서 알아두세요]
  * start/manage/qr는 기존 관리 키를 재사용합니다. -Rotate만 의도적으로 교체합니다.
  * 관리 링크·관리 QR은 본인만 보관하세요. 다른 사람에게는 프로젝트 공개 QR을 전달합니다.
  * QR·notify는 외부 공유 실행이 필요합니다. manage는 로컬 미리보기에서도 쓸 수 있습니다.
  * 포트 변경은 stop 후 start/local -Port 숫자로 실행하세요.
  * PC에 직접 복사한 파일은 자동 알림 감시 대상이 아닙니다. notify -Project를 사용하세요.
  * 관리 URL을 재발급해도 ngrok 요금제·월간 전송량 한도는 초기화되지 않습니다.
  * ntfy 없이도 QR과 관리 페이지를 사용할 수 있습니다.
  * Quick Tunnel은 재생성 시 주소가 바뀝니다. ntfy가 켜져 있으면 새 링크를 자동 전송·재시도합니다.
  * 같은 주소로 연결만 복구되면 알림을 반복하지 않습니다. 기존 PWA 주소는 자동 변경되지 않습니다.
  * ngrok 한도 초기화 후 start -Provider ngrok으로 직접 복귀하세요.

[실행 정책 오류가 나면]
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\share.ps1 help
  마지막 help를 start, manage 등 필요한 명령으로 바꾸면 됩니다.

[더 자세한 안내]
  Get-Help .\share.ps1 -Full
  README.md / docs/USAGE.ko.md

'@
    return
}
$ErrorActionPreference = 'Stop'
$runtimeDir = Join-Path $PSScriptRoot '.runtime'
$statePath = Join-Path $runtimeDir 'ngrok-state.json'
$urlPath = Join-Path $runtimeDir 'url.txt'
$configPath = Join-Path $runtimeDir 'ngrok.yml'
$ngrokExe = Join-Path $PSScriptRoot '.tools\ngrok.exe'
if (!(Test-Path -LiteralPath $ngrokExe)) {
    $installedNgrok = Get-Command ngrok.exe -ErrorAction SilentlyContinue
    if ($installedNgrok) { $ngrokExe = $installedNgrok.Source }
}
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$ntfyPath = Join-Path $runtimeDir 'ntfy.json'
$providerPath = Join-Path $runtimeDir 'tunnel-settings.json'
$cloudflaredExe = Join-Path $PSScriptRoot '.tools\cloudflared.exe'

function Install-Cloudflared {
    if (Test-Path -LiteralPath $cloudflaredExe) { return }
    if (![Environment]::Is64BitOperatingSystem) { throw 'Cloudflare 자동 설치는 64비트 Windows가 필요합니다.' }
    $toolsDir = Split-Path $cloudflaredExe
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' -TimeoutSec 30
    $asset = $release.assets | Where-Object { $_.name -eq 'cloudflared-windows-amd64.exe' } | Select-Object -First 1
    if (!$asset -or $asset.digest -notmatch '^sha256:([a-f0-9]{64})$') { throw '공식 cloudflared 배포의 SHA256 정보를 확인하지 못했습니다.' }
    $expected = $Matches[1]
    $download = $cloudflaredExe + '.download'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $download -TimeoutSec 180
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'cloudflared 다운로드 무결성 검증 실패.' }
        Move-Item -LiteralPath $download -Destination $cloudflaredExe -Force
    } finally { Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue }
}

function Assert-Node {
    if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22.17+ (24 LTS recommended), reopen PowerShell, then run .\share.ps1 setup.' }
    $nodeVersion = & node.exe -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.17.0') { throw 'Node.js 22.17 or later is required.' }
}
function Install-Dependencies {
    Assert-Node
    Push-Location $PSScriptRoot
    try { & npm.cmd ci --ignore-scripts --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' } }
    finally { Pop-Location }
    if ($Provider -eq 'cloudflare') { Install-Cloudflared }
    elseif (!(Test-Path -LiteralPath $ngrokExe)) {
        if (![Environment]::Is64BitOperatingSystem) { throw 'Automatic ngrok setup requires 64-bit Windows.' }
        $toolDirectory = Join-Path $PSScriptRoot '.tools'
        New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
        $archive = Join-Path $toolDirectory 'ngrok-download.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri 'https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile $archive
        Expand-Archive -LiteralPath $archive -DestinationPath $toolDirectory -Force
        $signature = Get-AuthenticodeSignature -LiteralPath $ngrokExe
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'ngrok') { throw 'ngrok signature verification failed. Install the official ngrok agent and run setup again.' }
    }
    Write-Host 'Setup complete. Next: .\share.ps1 start'
    if ($Provider -eq 'ngrok') { Write-Host 'First start opens the ngrok account page. Sign in, copy YOUR AUTHTOKEN, and paste it here.' }
    else { Write-Host 'Quick Tunnel은 계정 없이 시작합니다. 주소 변경 알림: .\share.ps1 ntfy' }
    Write-Host 'After connecting, scan the management QR with your phone camera. No ntfy app is required.'
}

function Get-NtfyConfig {
    if (!(Test-Path -LiteralPath $ntfyPath)) {
        @{ topic = ('html-share-' + [Guid]::NewGuid().ToString('N')) } | ConvertTo-Json | Set-Content -LiteralPath $ntfyPath -Encoding UTF8
    }
    $settings = Get-Content -LiteralPath $ntfyPath -Raw | ConvertFrom-Json
    if ($settings.topic -notmatch '^[A-Za-z0-9_-]{1,64}$') { throw 'Invalid ntfy topic. Run .\share.ps1 ntfy -Topic YOUR_TOPIC.' }
    return $settings
}
function Get-UploadLink([string]$PublicUrl, [switch]$NoSave) {
    $authPath = Join-Path $runtimeDir 'upload-auth.json'
    if (!(Test-Path -LiteralPath $authPath)) {
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object byte[] 32
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $key = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
        $json = @{ token = $key } | ConvertTo-Json
        # Never replace an existing key, including when another process created it.
        $file = [IO.File]::Open($authPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $encoded = [Text.Encoding]::UTF8.GetBytes($json); $file.Write($encoded, 0, $encoded.Length) } finally { $file.Dispose() }
    }
    $auth = Get-Content -LiteralPath $authPath -Raw | ConvertFrom-Json
    if ($auth.token -notmatch '^[a-f0-9]{64}$') { throw 'The saved upload key is invalid. Restore .runtime/upload-auth.json from your backup; it will not be automatically replaced.' }
    $hmac = New-Object Security.Cryptography.HMACSHA256
    try {
        $hmac.Key = [Text.Encoding]::UTF8.GetBytes($auth.token)
        $route = [BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('html-share-admin-route-v1'))).Replace('-', '').ToLowerInvariant().Substring(0,32)
    } finally { $hmac.Dispose() }
    $link = $PublicUrl.TrimEnd('/') + '/_manage/' + $route + '/#key=' + $auth.token
    if (!$NoSave) { Set-Content -LiteralPath (Join-Path $runtimeDir 'upload-url.txt') -Value $link -Encoding ASCII }
    return $link
}
function Rotate-ManagementKey {
    if ($env:HTML_SHARE_UPLOAD_TOKEN) { throw 'The management key is controlled by HTML_SHARE_UPLOAD_TOKEN. Change that environment setting and restart instead.' }
    $authPath = Join-Path $runtimeDir 'upload-auth.json'
    $temporary = Join-Path $runtimeDir ('upload-auth-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $key = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    try {
        [IO.File]::WriteAllText($temporary, (@{ token = $key } | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $authPath) { [IO.File]::Replace($temporary, $authPath, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $authPath) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    Remove-Item -LiteralPath (Join-Path $runtimeDir 'manage-qr.png') -Force -ErrorAction SilentlyContinue
    Write-Host 'Management key rotated. Previous management links and QR codes no longer authenticate.'
}
function Show-ShareQR([string]$ProjectName) {
    $script = Join-Path $PSScriptRoot 'scripts\sharing\share-qr.cjs'
    if ($ProjectName) { & node.exe $script $ProjectName } else { & node.exe $script }
    if ($LASTEXITCODE -ne 0) { throw 'QR generation failed. Use the management link printed by .\share.ps1 manage.' }
}
function Send-ShareNotification([string]$PublicUrl, [switch]$UploadOnly, [string]$TargetProject) {
    if (!(Test-Path -LiteralPath $ntfyPath)) { Write-Host 'Phone notifications are off. Enable them with .\share.ps1 ntfy.'; return }
    try {
        $settings = Get-NtfyConfig
        if ($settings.enabled -eq $false) { Write-Host 'Phone notifications are disabled.'; return }
        $baseUrl = $PublicUrl.TrimEnd('/') + '/'
        $projects = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'public') -Directory | Where-Object { $_.Name -ne 'upload' -and !$_.Name.StartsWith('.') -and !($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } | Sort-Object Name)
        $clickUrl = $baseUrl
        if ($projects.Count -eq 1) { $clickUrl += [Uri]::EscapeDataString($projects[0].Name) + '/' }
        $message = "HTML sharing is ready.`n$baseUrl"
        foreach ($project in ($projects | Select-Object -First 10)) {
            $line = "`n$($project.Name): $baseUrl$([Uri]::EscapeDataString($project.Name))/"
            if ([Text.Encoding]::UTF8.GetByteCount($message + $line) -gt 3500) { break }
            $message += $line
        }
        $uploadUrl = Get-UploadLink $PublicUrl
        $title = 'HTML share started'
        if ($TargetProject) {
            if ($TargetProject -match '[\\/:*?"<>|\x00-\x1f]' -or $TargetProject -match '(^\.|[ .]$)' -or $TargetProject -match '^(upload|admin|manage|api|_manage|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$') { throw 'Choose a valid public project name.' }
            $folder = Get-Item -LiteralPath (Join-Path (Join-Path $PSScriptRoot 'public') $TargetProject) -ErrorAction Stop
            if (!$folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Project must be a regular directory.' }
            $clickUrl = $baseUrl + [Uri]::EscapeDataString($TargetProject) + '/'
            $title = 'HTML Share - Project update'
            $message = "$TargetProject`nOpen the current applied page.`n$clickUrl"
        }
        $actions = @(@{ action = 'view'; label = 'Open page'; url = $clickUrl }, @{ action = 'view'; label = 'Manage'; url = $uploadUrl })
        if ($UploadOnly) {
            $title = 'HTML Share - Manage'
            $clickUrl = $uploadUrl
            $message = 'Tap to upload ZIP or HTML to a project. Keep this management link private. This link is reused; no new key was issued.'
            $actions = @(@{ action = 'view'; label = 'Manage'; url = $uploadUrl })
        }
        $payload = @{ topic = $settings.topic; title = $title; message = $message; click = $clickUrl; tags = @('link'); actions = $actions } | ConvertTo-Json -Depth 5 -Compress
        $result = Invoke-RestMethod -Method Post -Uri 'https://ntfy.sh' -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 8
        if (!$result.id) { throw 'ntfy did not acknowledge the message.' }
        @{ id = $result.id; url = $clickUrl; topic = $settings.topic; sentAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'ntfy-last.json') -Encoding UTF8
        Write-Host "Phone notification sent. Subscribe: https://ntfy.sh/$($settings.topic)"
    } catch {
        # A notification outage must never stop the server or the tunnel.
        Write-Warning "ntfy notification failed; HTML sharing stays online. Retry with .\share.ps1 notify. $($_.Exception.Message)"
    }
}

function Owned-Process($Record) {
    if (!$Record) { return $null }
    $item = Get-Process -Id $Record.id -ErrorAction SilentlyContinue
    if ($item -and $item.StartTime.ToUniversalTime().Ticks.ToString() -eq $Record.started -and $item.Path -eq $Record.path) { return $item }
    return $null
}
function Process-Record($Item, [string]$ExecutablePath) {
    # Path can be empty immediately after Start-Process, before the image is loaded.
    return @{ id = $Item.Id; started = $Item.StartTime.ToUniversalTime().Ticks.ToString(); path = [IO.Path]::GetFullPath($ExecutablePath) }
}
function Save-State($State) {
    $State | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
}
function Stop-Owned($State) {
    if (!$State) { return }
    foreach ($record in @($State.tunnel, $State.server)) {
        $item = Owned-Process $record
        if ($item) { Stop-OwnedTree $record }
    }
}
function Stop-OwnedTree($Record) {
    $item = Owned-Process $Record
    if (!$item) { return }
    & taskkill.exe /PID $item.Id /T /F 2>&1 | Out-Null
    if (Owned-Process $Record) { throw '소유 프로세스를 종료하지 못했습니다.' }
}
function Configure-Ngrok {
    if (!(Test-Path -LiteralPath $ngrokExe)) { throw 'Install ngrok with .\share.ps1 setup first.' }
    Write-Host 'One-time ngrok setup (not needed again on normal restarts):'
    Write-Host '1. Sign up or sign in to your ngrok account in the browser.'
    Write-Host '2. Open YOUR AUTHTOKEN and copy its value (not an API key or the whole command).'
    Write-Host '3. Return here, paste the token, then press Enter. Input stays hidden.'
    Write-Host '4. The public URL and private management QR will appear once the tunnel connects.'
    Write-Host 'https://dashboard.ngrok.com/get-started/your-authtoken'
    Start-Process 'https://dashboard.ngrok.com/get-started/your-authtoken'
    $secureToken = Read-Host 'Paste only the authtoken (input is hidden)' -AsSecureString
    $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try {
        $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr).Trim()
        if ($plainToken -notmatch '^[A-Za-z0-9_-]{20,}$') { throw 'Paste the token value, not the full ngrok command.' }
        # JSON is valid YAML. The token never appears in command arguments or output.
        $config = @{ version = '3'; agent = @{ authtoken = $plainToken; web_addr = '127.0.0.1:4047' } }
        $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
        $check = & $ngrokExe config check --config $configPath 2>&1
        if ($LASTEXITCODE -ne 0) { throw 'ngrok rejected the config. Run .\share.ps1 configure again.' }
        Write-Host 'Token saved locally. Account authentication is checked when starting the tunnel.'
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr)
        $plainToken = $null
        $config = $null
        $secureToken.Dispose()
    }
}

# Serialize this folder's controls so repeated commands cannot launch duplicates.
$hashProvider = [Security.Cryptography.SHA256]::Create()
$folderHash = [BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant()))).Replace('-', '')
$hashProvider.Dispose()
$controlMutex = New-Object Threading.Mutex($false, "Local\HtmlShare-$folderHash")
$locked = $false
try {
    try { $locked = $controlMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { throw 'Another HTML sharing command is running. Wait for it to finish.' }
    $state = $null
    if (Test-Path -LiteralPath $statePath) { $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
    if ($Topic -and $Action -ne 'ntfy') { throw '-Topic is used with .\share.ps1 ntfy.' }
    if ($Project -and $Action -notin @('pwa','qr','notify')) { throw '-Project is used with pwa, qr, or notify.' }
    if ($Disable -and $Action -ne 'ntfy') { throw '-Disable is used with .\share.ps1 ntfy.' }
    if (($Updates -or $NoUpdates) -and $Action -ne 'ntfy') { throw '-Updates and -NoUpdates are used with .\share.ps1 ntfy.' }
    if (($Updates -and $NoUpdates) -or ($Disable -and ($Updates -or $NoUpdates))) { throw 'Choose only one notification setting switch.' }
    if ($Manage -and ($Action -ne 'notify' -or $Project)) { throw 'Use .\share.ps1 notify -Manage without -Project.' }
    if ($Rotate -and $Action -notin @('manage','upload')) { throw 'Use .\share.ps1 manage -Rotate to replace the management URL.' }
    if ($Local -and $Action -notin @('manage','upload')) { throw '-Local is used with manage or upload.' }
    if ($Local -and $Rotate) { throw 'Rotate with manage -Rotate first, then use manage -Local to view the local URL.' }
    if ($Provider -and $Action -notin @('start','setup')) { throw '-Provider는 start/setup에서 사용합니다.' }
    if (!$Provider -and (Test-Path -LiteralPath $providerPath)) { $Provider = (Get-Content -LiteralPath $providerPath -Raw | ConvertFrom-Json).provider }
    if (!$Provider) { $Provider = 'ngrok' }
    if ($Provider -notin @('ngrok','cloudflare')) { throw '저장된 터널 제공자 설정이 올바르지 않습니다.' }
    if ($Action -in @('start','setup')) { @{ provider = $Provider } | ConvertTo-Json | Set-Content -LiteralPath $providerPath -Encoding UTF8 }
    if ($Action -eq 'setup') { Install-Dependencies; exit 0 }
    if ($Action -eq 'doctor') {
        Assert-Node
        Write-Host ('Node: ' + (& node.exe --version))
        Write-Host ('Dependencies installed: ' + (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\adm-zip\package.json')))
        Write-Host ('ngrok installed: ' + (Test-Path -LiteralPath $ngrokExe))
        Write-Host ('Tunnel provider: ' + $Provider)
        Write-Host ('cloudflared installed: ' + (Test-Path -LiteralPath $cloudflaredExe))
        Write-Host ('ngrok configured: ' + (Test-Path -LiteralPath $configPath))
        Write-Host ('Phone notifications configured: ' + (Test-Path -LiteralPath $ntfyPath))
        Write-Host ('Persistent upload key exists: ' + (Test-Path -LiteralPath (Join-Path $runtimeDir 'upload-auth.json')))
        exit 0
    }
    if ($Action -in @('start','local','ntfy','pwa','qr','manage','upload')) {
        Assert-Node
        if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\adm-zip\package.json'))) { throw 'Run .\share.ps1 setup (or npm ci) before using the server.' }
    }
    if ($Action -eq 'pwa') {
        if (!$Project) { throw 'Choose a project: .\share.ps1 pwa -Project PROJECT_NAME' }
        & node.exe (Join-Path $PSScriptRoot 'scripts\pwa\configure.cjs') $Project
        if ($LASTEXITCODE -ne 0) { throw 'PWA initialization failed. Check the message above.' }
        exit 0
    }
    if ($Action -eq 'ntfy') {
        if ($Disable) {
            if (Test-Path -LiteralPath $ntfyPath) {
                $settings = Get-NtfyConfig
                @{ topic = $settings.topic; enabled = $false; updates = ($settings.updates -eq $true) } | ConvertTo-Json | Set-Content -LiteralPath $ntfyPath -Encoding UTF8
            }
            Write-Host 'ntfy notifications disabled. Management QR and links still work.'
            exit 0
        }
        $settings = Get-NtfyConfig
        if ($Topic) { $settings.topic = $Topic }
        $projectUpdates = $settings.updates -eq $true
        if ($Updates) { $projectUpdates = $true }
        if ($NoUpdates) { $projectUpdates = $false }
        @{ topic = $settings.topic; enabled = $true; updates = $projectUpdates } | ConvertTo-Json | Set-Content -LiteralPath $ntfyPath -Encoding UTF8
        Write-Host "Start notifications enabled. Automatic project update notifications: $projectUpdates"
        Write-Host 'In the ntfy phone app, add this topic on server https://ntfy.sh:'
        Write-Host $settings.topic
        Write-Host "Subscription: https://ntfy.sh/$($settings.topic)"
        & node.exe (Join-Path $PSScriptRoot 'scripts\sharing\ntfy-qr.cjs')
        if ($LASTEXITCODE -ne 0) { throw 'Could not generate the ntfy QR code.' }
        exit 0
    }
    if ($Action -eq 'notify') {
        if (!$state -or !(Owned-Process $state.server) -or !(Owned-Process $state.tunnel) -or !$state.url) { throw 'Start sharing first: .\share.ps1 start' }
        Send-ShareNotification $state.url -UploadOnly:$Manage -TargetProject $Project
        exit 0
    }
    if ($Action -eq 'qr') {
        if (!$state -or !(Owned-Process $state.server) -or !(Owned-Process $state.tunnel) -or !$state.url) { throw 'Phone QR requires public sharing. Run .\share.ps1 start first.' }
        Get-UploadLink $state.url | Out-Null
        Show-ShareQR $Project
        exit 0
    }
    if ($Action -in @('manage','upload')) {
        if ($Local) {
            if (!$state -or !(Owned-Process $state.server)) { throw '로컬 서버가 꺼져 있습니다. .\share.ps1 local을 실행한 뒤 다시 시도하세요.' }
            Write-Host ('로컬 관리 주소 (이 PC 전용): ' + (Get-UploadLink "http://127.0.0.1:$($state.port)" -NoSave))
            Write-Host 'ngrok 연결이나 전송량 한도와 무관합니다. 휴대폰에서는 이 로컬 주소로 접속할 수 없습니다.'
            exit 0
        }
        if ($Rotate) {
            if (!$state -or !(Owned-Process $state.server)) { throw 'Start the server before rotating the management link.' }
            Rotate-ManagementKey
        }
        if ($state -and (Owned-Process $state.server) -and (Owned-Process $state.tunnel) -and $state.url) {
            Write-Host ('Manage (private): ' + (Get-UploadLink $state.url))
            Show-ShareQR
            if ($Rotate) { Send-ShareNotification $state.url -UploadOnly }
        } elseif ($state -and (Owned-Process $state.server)) {
            Write-Host ('Manage on this PC (private): ' + (Get-UploadLink "http://127.0.0.1:$($state.port)"))
        } elseif (Test-Path -LiteralPath (Join-Path $runtimeDir 'upload-url.txt')) {
            Write-Host ('Manage (private): ' + (Get-Content -LiteralPath (Join-Path $runtimeDir 'upload-url.txt') -Raw).Trim())
            Write-Host 'Start sharing to use this saved link: .\share.ps1 start'
        } else { throw 'Start sharing first: .\share.ps1 start' }
        exit 0
    }
    if ($Action -eq 'configure') { Configure-Ngrok; exit 0 }
    if ($Action -eq 'stop') {
        Stop-Owned $state
        Remove-Item -LiteralPath $statePath, $urlPath -Force -ErrorAction SilentlyContinue
        Write-Host 'HTML 서버와 터널·자동 재연결을 종료했습니다.'
        exit 0
    }
    if ($Action -eq 'status') {
        if ($state -and (Owned-Process $state.server)) {
            Write-Host "Local: http://127.0.0.1:$($state.port)"
            if (Owned-Process $state.tunnel) { Write-Host "Public: $($state.url)" }
            else { Write-Host '터널이 실행 중이 아닙니다.' }
        } else { Write-Host 'HTML sharing is stopped.' }
        exit 0
    }
    if ($Action -eq 'start' -and $Provider -eq 'cloudflare') { Install-Cloudflared }
    if ($Action -eq 'start' -and $Provider -eq 'ngrok' -and !(Test-Path -LiteralPath $configPath)) {
        Configure-Ngrok
    }
    $runningProvider = 'ngrok'
    if ($state -and $state.provider) { $runningProvider = $state.provider }
    if ($state -and (Owned-Process $state.server) -and ($Action -eq 'local' -or ($Provider -eq $runningProvider -and (Owned-Process $state.tunnel)))) {
        Write-Host "Already running: http://127.0.0.1:$($state.port) $($state.url)"
        if ($Action -eq 'start' -and $state.url) { Get-UploadLink $state.url | Out-Null; try { Show-ShareQR } catch { Write-Warning $_.Exception.Message } }
        elseif ($Action -eq 'start') { Write-Host '터널 재연결 중입니다. 새 주소는 ntfy로 알립니다.' }
        exit 0
    }
    if ($state -and (Owned-Process $state.server)) {
        $Port = $state.port
        $state = @{ server = $state.server; tunnel = $state.tunnel; port = $Port; url = $null }
        $oldTunnel = Owned-Process $state.tunnel
        if ($oldTunnel) { Stop-OwnedTree $state.tunnel }
        $state.tunnel = $null
    } else {
        Stop-Owned $state
        $state = @{ server = $null; tunnel = $null; port = $Port; url = $null }
    }
    Remove-Item -LiteralPath $urlPath -Force -ErrorAction SilentlyContinue
    try {
        if (!(Owned-Process $state.server)) {
            $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
            $serverLog = Join-Path $runtimeDir 'server.log'
            $serverError = Join-Path $runtimeDir 'server-error.log'
            $server = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + (Join-Path $PSScriptRoot 'src\server\server.cjs') + '"'), "$Port") -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $serverLog -RedirectStandardError $serverError -PassThru
            $state.server = Process-Record $server $nodeExe
            Save-State $state
            $deadline = (Get-Date).AddSeconds(10)
            do {
                Start-Sleep -Milliseconds 100
                if ($server.HasExited) { throw 'Local server failed. Check .runtime/server-error.log (the port may already be in use).' }
                $ready = (Get-Content -LiteralPath $serverLog -Raw -ErrorAction SilentlyContinue) -match 'Serving '
            } until ($ready -or (Get-Date) -gt $deadline)
            if (!$ready) { throw 'Local server did not become ready.' }
        }
        Write-Host "Local: http://127.0.0.1:$Port"
        if ($Action -eq 'local') { Save-State $state; Get-UploadLink "http://127.0.0.1:$Port" | Out-Null; exit 0 }
        $state.provider = $Provider
        if ($Provider -eq 'cloudflare') {
            Get-UploadLink "http://127.0.0.1:$Port" -NoSave | Out-Null
            $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
            $argsQuick = @(('"' + (Join-Path $PSScriptRoot 'scripts\tunnel\quick-tunnel.cjs') + '"'), ('"' + $cloudflaredExe + '"'), "$Port")
            $tunnel = Start-Process -FilePath $nodeExe -ArgumentList $argsQuick -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'cloudflare.log') -RedirectStandardError (Join-Path $runtimeDir 'cloudflare-error.log') -PassThru
            $state.tunnel = Process-Record $tunnel $nodeExe
            Save-State $state
            Write-Host 'Cloudflare Quick Tunnel 연결 중...'
            $deadline = (Get-Date).AddSeconds(45)
            do {
                Start-Sleep -Milliseconds 250
                if ($tunnel.HasExited) { throw 'Quick Tunnel 실행 실패. .runtime/cloudflare-error.log를 확인하세요.' }
                try { $current = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { continue }
                if ($current.tunnel.id -eq $tunnel.Id -and $current.url) { $state = $current; break }
            } until ((Get-Date) -gt $deadline)
            if ($state.url) {
                Write-Host "Public: $($state.url)"
                try { Show-ShareQR } catch { Write-Warning $_.Exception.Message }
            } else { Write-Host '백그라운드에서 연결을 재시도합니다. 주소가 준비되면 ntfy로 알립니다. status로 확인하세요.' }
            exit 0
        }
        $tunnelLog = Join-Path $runtimeDir 'ngrok.log'
        $tunnelError = Join-Path $runtimeDir 'ngrok-error.log'
        $tunnelArgs = @('http', "http://127.0.0.1:$Port", '--config', ('"' + $configPath + '"'), '--log', 'stdout', '--log-format', 'json', '--inspect=false')
        $tunnel = Start-Process -FilePath $ngrokExe -ArgumentList $tunnelArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelError -PassThru
        $state.tunnel = Process-Record $tunnel $ngrokExe
        Save-State $state
        Write-Host 'Connecting ngrok...'
        $deadline = (Get-Date).AddSeconds(30)
        do {
            Start-Sleep -Milliseconds 100
            if ($tunnel.HasExited) { throw 'ngrok exited. Check .runtime/ngrok-error.log and ngrok.log; verify your token/account with .\share.ps1 configure.' }
            $lines = @(Get-Content -LiteralPath $tunnelLog -ErrorAction SilentlyContinue)
            foreach ($line in $lines) {
                try { $event = $line | ConvertFrom-Json } catch { continue }
                if ($event.msg -eq 'started tunnel' -and $event.url -match '^https://') { $state.url = $event.url }
            }
        } until ($state.url -or (Get-Date) -gt $deadline)
        if (!$state.url) { throw 'ngrok did not provide a URL within 30 seconds. Check .runtime/ngrok.log.' }
        Save-State $state
        Set-Content -LiteralPath $urlPath -Value $state.url -Encoding ASCII
        Write-Host "Public: $($state.url)"
        Write-Host 'Each public/<project>/ folder is available at /<project>/.'
        Write-Host 'Running in the background. Use .\share.ps1 stop to stop sharing.'
        Get-UploadLink $state.url | Out-Null
        try { Show-ShareQR } catch { Write-Warning $_.Exception.Message }
        Send-ShareNotification $state.url
    } catch {
        Stop-Owned $state
        Remove-Item -LiteralPath $statePath, $urlPath -Force -ErrorAction SilentlyContinue
        throw
    }
} finally {
    if ($locked) { $controlMutex.ReleaseMutex() }
    $controlMutex.Dispose()
}
