'use strict';
const $ = (id) => document.getElementById(id);
let token = '';
let selected = null;
let activeRequest = null;
let authenticated = false;
let fileState = null;
let filesLoading = false;
let managementBusy = false;
let filesRequestId = 0;
let cleanupPreview = null;
const projectModes = new Map();
let pwaSettings = null;
let settingsProject = '';
let pwaDirty = false;
const tabNames = ['upload', 'files', 'pwa', 'share'];
let activeTab = 'upload';
let manageQrLoading = false;
let manageQrRequest = 0;
const limit = 256 * 1024 * 1024;
const isPwa = () => projectModes.get($('project').value) === true;
const fileHint = () =>
    isPwa()
        ? 'HTML · HTM / 공용 PWA 템플릿에 자동 적용'
        : 'ZIP · HTML · HTM / 파일당 최대 256 MiB';
function syncProjectMode() {
    $('pwa-mode').hidden = !isPwa();
    $('file').accept = isPwa() ? '.html,.htm' : '.zip,.html,.htm';
    if (selected && isPwa() && /\.zip$/i.test(selected.name)) {
        selected = null;
        $('file').value = '';
        $('file-title').textContent = 'HTML 파일을 선택해 주세요';
    }
    if (!selected) $('file-detail').textContent = fileHint();
    updateSubmit();
}

function status(message, error = false) {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
    if (error)
        $('status').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}
function rememberProject(project) {
    if (!authenticated || !window.history?.replaceState) return;
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (project) fragment.set('project', project);
    else fragment.delete('project');
    fragment.set('tab', activeTab);
    window.history.replaceState(
        null,
        '',
        location.pathname + location.search + '#' + fragment.toString(),
    );
}
function renderTabs() {
    $('workspace').hidden = !authenticated;
    const busy = !!activeRequest || managementBusy;
    for (const name of tabNames) {
        const current = name === activeTab;
        $('panel-' + name).hidden = !current;
        $('tab-' + name).setAttribute('aria-selected', String(current));
        $('tab-' + name).tabIndex = current ? 0 : -1;
        $('tab-' + name).disabled = busy;
    }
    $('pwa-empty').hidden = !!pwaSettings;
    $('pwa-draft-badge').hidden = !pwaDirty;
    $('share-current-name').textContent = '상단에서 프로젝트를 선택해 주세요.';
    $('share-current-name').hidden = !!$('project').value;
}
function selectTab(name, focus = false) {
    if (
        !authenticated ||
        activeRequest ||
        managementBusy ||
        !tabNames.includes(name)
    )
        return;
    activeTab = name;
    rememberProject($('project').value);
    renderTabs();
    if (focus) $('tab-' + name).focus?.();
    window.scrollTo?.({ top: 0, behavior: 'auto' });
}
function projectPage(project, fresh = false) {
    const url = new URL(
        '/' + encodeURIComponent(project) + '/',
        location.origin,
    );
    if (fresh) url.searchParams.set('hs_preview', Date.now().toString());
    return url.href;
}
function renderCurrentProject() {
    const project = $('project').value;
    $('current-project').hidden = !authenticated || !project;
    $('current-open').hidden = !fileState?.active || filesLoading;
    $('current-file').textContent = filesLoading
        ? '적용 정보 확인 중…'
        : fileState?.active || '아직 적용된 파일이 없습니다';
    $('current-build').textContent = fileState?.pwa?.build
        ? 'PWA 빌드 ' + fileState.pwa.build
        : '';
    if (project) $('current-open').href = projectPage(project, true);
}
function updateSubmit() {
    $('submit').disabled =
        !authenticated ||
        !selected ||
        !$('project').value ||
        !!activeRequest ||
        managementBusy ||
        filesLoading ||
        !pwaSettings ||
        settingsProject !== $('project').value;
    $('submit').textContent = filesLoading
        ? '프로젝트 불러오는 중'
        : pwaDirty
          ? '설정 저장 후 업로드'
          : '업로드만 하기';
    $('submit-open').disabled = $('submit').disabled;
    $('submit-open').textContent = activeRequest
        ? '업로드 중…'
        : filesLoading
          ? '프로젝트 불러오는 중'
          : pwaDirty
            ? '설정 저장·업로드 후 열기 →'
            : '업로드 후 페이지 열기 →';
    updateManagementControls();
}
function lock() {
    dismissManageDialog();
    authenticated = false;
    $('locked').hidden = false;
    $('upload-form').hidden = true;
    $('management').hidden = true;
    $('current-project').hidden = true;
    $('pwa-settings').hidden = true;
    $('workspace').hidden = true;
    pwaSettings = null;
    settingsProject = '';
    pwaDirty = false;
    fileState = null;
    filesLoading = false;
    filesRequestId++;
    $('auth-badge').textContent = '인증 링크 필요';
    $('auth-badge').classList.remove('ready');
}
async function loadProjects() {
    $('refresh').disabled = true;
    try {
        const response = await fetch('./api/projects', {
            headers: {
                Authorization: `Bearer ${token}`,
                'ngrok-skip-browser-warning': '1',
            },
            credentials: 'omit',
            cache: 'no-store',
        });
        if (response.status === 401 || response.status === 403) {
            lock();
            status(
                'PC에서 표시한 비공개 관리 QR이나 저장한 관리 링크로 다시 열어 주세요.',
                true,
            );
            return;
        }
        if (!response.ok)
            throw new Error(
                '프로젝트 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
            );
        if (
            !(response.headers.get('content-type') || '').includes(
                'application/json',
            )
        )
            throw new Error(
                '프로젝트 목록 대신 안내 페이지가 반환됐습니다. 페이지를 새로고침하거나 비공개 관리 링크로 다시 열어 주세요.',
            );
        const data = await response.json();
        projectModes.clear();
        for (const project of data.projects)
            projectModes.set(project.name, project.pwa === true);
        const previous =
            new URLSearchParams(location.hash.slice(1)).get('project') ||
            $('project').value;
        $('project').replaceChildren(new Option('프로젝트를 선택하세요', ''));
        for (const project of data.projects)
            $('project').add(new Option(project.name, project.name));
        if (data.projects.some((project) => project.name === previous))
            $('project').value = previous;
        else if (data.projects.length === 1)
            $('project').value = data.projects[0].name;
        $('project').disabled = !data.projects.length;
        $('empty-projects').hidden = !!data.projects.length;
        authenticated = true;
        rememberProject($('project').value);
        $('locked').hidden = true;
        $('upload-form').hidden = false;
        $('management').hidden = false;
        $('auth-badge').textContent = '업로드 가능';
        $('auth-badge').classList.add('ready');
        status('');
        syncProjectMode();
        await loadFiles();
    } catch (error) {
        status(error.message, true);
    } finally {
        $('refresh').disabled = false;
        updateSubmit();
    }
}
function choose(files) {
    if (activeRequest || managementBusy) return;
    selected = null;
    $('result').hidden = true;
    $('file-title').textContent = '파일 선택 또는 여기로 끌어놓기';
    $('file-detail').textContent = fileHint();
    if (!files.length) {
        updateSubmit();
        return;
    }
    if (files.length !== 1) {
        status('한 번에 파일 하나를 선택해 주세요.', true);
        updateSubmit();
        return;
    }
    const file = files[0];
    if (isPwa() && !/\.html?$/i.test(file.name)) {
        status(
            'PWA 프로젝트에는 HTML 또는 HTM 파일만 올려 주세요. PWA 베이스는 그대로 유지됩니다.',
            true,
        );
        updateSubmit();
        return;
    }
    if (!/\.(zip|html|htm)$/i.test(file.name)) {
        status('ZIP, HTML, HTM 파일만 업로드할 수 있습니다.', true);
        updateSubmit();
        return;
    }
    if (!file.size || file.size > limit) {
        status('0바이트보다 크고 256 MiB 이하인 파일을 선택해 주세요.', true);
        updateSubmit();
        return;
    }
    selected = file;
    $('file-title').textContent = file.name;
    $('file-detail').textContent =
        `${(file.size / 1024 / 1024).toFixed(2)} MiB · ${isPwa() ? 'PWA 배포본으로 적용' : /\.zip$/i.test(file.name) ? '압축 검사 후 자동 적용' : 'HTML 페이지로 적용'}`;
    status('');
    updateSubmit();
}
const errors = {
    401: '인증 링크가 유효하지 않습니다. PC에서 표시한 비공개 관리 QR로 다시 열어 주세요.',
    403: '이 프로젝트나 파일명으로는 업로드할 수 없습니다.',
    404: '프로젝트가 없습니다. 목록을 새로고침해 주세요.',
    409: '파일 목록이 변경됐습니다. 새 목록을 확인한 뒤 다시 시도해 주세요.',
    413: '파일이 업로드 용량 제한을 넘었습니다.',
    415: 'ZIP, HTML, HTM 파일만 업로드할 수 있습니다.',
    422: 'ZIP을 열 수 없습니다. 손상·암호 설정·압축 해제 용량을 확인해 주세요.',
};
function requestError(code) {
    if (isPwa() && code === 415)
        return 'PWA 프로젝트에는 HTML 또는 HTM만 업로드할 수 있습니다.';
    if (isPwa() && code === 422)
        return 'PWA 배포본을 만들 수 없습니다. HTML 또는 PWA 설정을 확인해 주세요. 기존 적용본은 유지됩니다.';
    return (
        errors[code] ||
        '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    );
}
$('upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (
        !authenticated ||
        !selected ||
        !$('project').value ||
        activeRequest ||
        managementBusy ||
        filesLoading ||
        !pwaSettings ||
        settingsProject !== $('project').value
    )
        return;
    const project = $('project').value;
    const file = selected;
    const openAfterUpload = event.submitter?.id === 'submit-open';
    let readyToOpen = '';
    if (pwaDirty) {
        if ($('pwa-enabled').checked && !/\.html?$/i.test(file.name)) {
            status(
                'PWA 설정을 적용하려면 HTML 또는 HTM 파일을 선택해 주세요.',
                true,
            );
            return;
        }
        if (!(await savePwaSettings())) return;
        if (
            !authenticated ||
            $('project').value !== project ||
            selected !== file ||
            filesLoading ||
            !pwaSettings ||
            settingsProject !== project
        )
            return;
    }
    const xhr = new XMLHttpRequest();
    activeRequest = xhr;
    $('result').hidden = true;
    $('progress-area').hidden = false;
    $('progress').value = 0;
    $('percent').textContent = '0%';
    $('progress-label').textContent = '전송 중';
    $('cancel').hidden = false;
    $('project').disabled = true;
    $('file').disabled = true;
    $('refresh').disabled = true;
    status('업로드 중에는 이 페이지를 열어 두세요.');
    updateSubmit();
    xhr.open(
        'PUT',
        `./api/file?project=${encodeURIComponent(project)}&filename=${encodeURIComponent(file.name)}`,
    );
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('ngrok-skip-browser-warning', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.addEventListener('progress', (e) => {
        if (!e.lengthComputable) return;
        const percent = Math.round((e.loaded / e.total) * 100);
        $('progress').value = percent;
        $('percent').textContent = `${percent}%`;
        if (percent === 100)
            $('progress-label').textContent = '파일 검사 및 저장 중';
    });
    xhr.addEventListener('load', () => {
        if (xhr.status < 200 || xhr.status >= 300) {
            status(requestError(xhr.status), true);
            if (xhr.status === 401) lock();
            return;
        }
        try {
            const result = JSON.parse(xhr.responseText);
            const url = new URL(result.url, location.origin);
            if (
                url.origin !== location.origin ||
                url.pathname !== '/' + encodeURIComponent(project) + '/' ||
                url.hash
            )
                throw new Error('Invalid result URL');
            $('result-project').textContent = '새 파일을 적용했습니다';
            $('result-file').textContent = result.filename;
            $('result-build').textContent =
                (result.pwa?.build
                    ? 'PWA 빌드 ' + result.pwa.build + ' · '
                    : '') +
                new Date().toLocaleTimeString('ko-KR') +
                ' 적용 완료';
            $('open-project').href = url.href;
            $('open-latest').href = projectPage(project, true);
            $('result').hidden = false;
            $('file').value = '';
            selected = null;
            $('file-title').textContent = '다른 파일 선택 또는 여기로 끌어놓기';
            $('file-detail').textContent = fileHint();
            status('최신 파일로 반영됐습니다. 페이지를 열어 확인하세요.');
            rememberProject(project);
            if (openAfterUpload) readyToOpen = projectPage(project, true);
            else {
                loadFiles();
                $('result').focus?.({ preventScroll: true });
                $('result').scrollIntoView?.({
                    block: 'start',
                    behavior: 'smooth',
                });
            }
        } catch {
            status(
                '서버 응답을 확인하지 못했습니다. 프로젝트 페이지에서 저장 여부를 확인해 주세요.',
                true,
            );
        }
    });
    xhr.addEventListener('error', () =>
        status(
            '연결이 끊겼습니다. 서버 상태와 프로젝트의 저장 여부를 확인해 주세요.',
            true,
        ),
    );
    xhr.addEventListener('timeout', () =>
        status(
            '전송 시간이 초과됐습니다. 연결 상태와 저장 여부를 확인해 주세요.',
            true,
        ),
    );
    xhr.addEventListener('abort', () =>
        status(
            '전송을 취소했습니다. 저장이 진행 중이었다면 프로젝트에서 결과를 확인해 주세요.',
        ),
    );
    xhr.addEventListener('loadend', () => {
        activeRequest = null;
        $('project').disabled = false;
        $('file').disabled = false;
        $('refresh').disabled = false;
        $('cancel').hidden = true;
        $('progress-area').hidden = true;
        updateSubmit();
        if (readyToOpen) window.location.assign(readyToOpen);
    });
    xhr.send(file);
});
$('file').addEventListener('change', (event) => choose(event.target.files));
$('project').addEventListener('change', () => {
    $('result').hidden = true;
    rememberProject($('project').value);
    syncProjectMode();
    loadFiles();
});
$('upload-next').addEventListener('click', () => {
    selectTab('upload');
    $('upload-form').scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    $('file').focus?.();
    $('file').click();
});
$('refresh').addEventListener('click', loadProjects);
$('cancel').addEventListener('click', () => activeRequest?.abort());
for (const type of ['dragenter', 'dragover'])
    $('drop-zone').addEventListener(type, (event) => {
        event.preventDefault();
        $('drop-zone').classList.add('dragging');
    });
for (const type of ['dragleave', 'drop'])
    $('drop-zone').addEventListener(type, (event) => {
        event.preventDefault();
        $('drop-zone').classList.remove('dragging');
    });
$('drop-zone').addEventListener('drop', (event) =>
    choose(event.dataTransfer.files),
);
function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    return bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
        : `${(bytes / 1024).toFixed(1)} KiB`;
}
function updateManagementControls() {
    const busy = !!activeRequest || managementBusy || filesLoading;
    $('cleanup').disabled = busy || !fileState || fileState.cleanup.count === 0;
    $('files-refresh').disabled = busy || !authenticated || !$('project').value;
    $('share-project').disabled = busy || !authenticated || !$('project').value;
    $('manage-qr').disabled = busy || !authenticated || manageQrLoading;
    $('manage-copy').disabled = busy || !authenticated || manageQrLoading;
    for (const button of $('files-list').querySelectorAll('button'))
        button.disabled = busy;
    $('pwa-settings').disabled = busy;
    $('pwa-save').disabled =
        busy ||
        !pwaSettings ||
        !pwaDirty ||
        settingsProject !== $('project').value;
    renderTabs();
}
async function managementApi(route, body) {
    const headers = {
        Authorization: `Bearer ${token}`,
        'ngrok-skip-browser-warning': '1',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(route, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
    });
    if (!response.ok) {
        if (response.status === 401) lock();
        const error = new Error(requestError(response.status));
        error.status = response.status;
        throw error;
    }
    if (
        !(response.headers.get('content-type') || '').includes(
            'application/json',
        )
    )
        throw new Error(
            '안내 페이지가 반환됐습니다. 비공개 관리 링크로 다시 열어 주세요.',
        );
    return response.json();
}
function renderFiles() {
    renderCurrentProject();
    $('files-list').replaceChildren();
    $('pwa-build').hidden = !fileState?.pwa?.enabled;
    if (fileState?.pwa?.enabled) {
        $('pwa-build').textContent = fileState.pwa.error
            ? 'PWA 배포 오류: ' + fileState.pwa.error
            : `PWA 적용 빌드: ${fileState.pwa.build || '아직 없음'} · 베이스 파일은 정리 대상에서 제외됩니다.`;
        $('pwa-build').classList.toggle('error', !!fileState.pwa.error);
    }
    if (!fileState) {
        $('files-summary').textContent = '위에서 프로젝트를 선택해 주세요.';
        $('cleanup').textContent = '최신만 남기기';
        updateManagementControls();
        return;
    }
    $('files-summary').textContent = fileState.active
        ? `${fileState.files.length}개 파일 · 현재 적용 1개`
        : 'HTML 또는 ZIP 파일이 없습니다.';
    for (const file of fileState.files) {
        const card = document.createElement('article');
        card.className = `file-card${file.active ? ' applied' : ''}`;
        const heading = document.createElement('div');
        heading.className = 'file-heading';
        const name = document.createElement('span');
        name.className = 'file-name';
        name.textContent = file.name;
        const badge = document.createElement('span');
        badge.className = 'file-badge';
        badge.textContent = file.active ? '현재 적용' : '보관 중';
        heading.append(name, badge);
        const meta = document.createElement('p');
        meta.className = 'file-meta';
        meta.textContent = `${file.type.toUpperCase()} · ${formatSize(file.size)} · ${new Date(file.modifiedAt).toLocaleString('ko-KR')}`;
        const actions = document.createElement('div');
        actions.className = 'file-actions';
        if (file.active) {
            const link = document.createElement('a');
            link.href = `/${encodeURIComponent(fileState.project)}/`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = '적용 페이지 열기 ↗';
            actions.append(link);
        } else {
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.textContent = '이 파일 적용';
            apply.addEventListener('click', () => applyFile(file.name));
            actions.append(apply);
        }
        const download = document.createElement('button');
        download.type = 'button';
        download.textContent = '원본 다운로드';
        download.setAttribute('aria-label', `${file.name} 원본 다운로드`);
        download.addEventListener('click', () => downloadOriginal(file.name));
        actions.append(download);
        card.append(heading, meta, actions);
        $('files-list').append(card);
    }
    $('cleanup').textContent = fileState.cleanup.count
        ? `최신만 남기기 · ${fileState.cleanup.count}개 정리`
        : '정리할 이전 파일 없음';
    updateManagementControls();
}
async function downloadOriginal(filename) {
    if (
        !authenticated ||
        !fileState ||
        managementBusy ||
        activeRequest ||
        filesLoading
    )
        return;
    const snapshot = fileState;
    managementWorking(true);
    status(`${filename} 원본을 내려받는 중…`);
    try {
        const query = new URLSearchParams({
            project: snapshot.project,
            filename,
            revision: snapshot.revision,
        });
        const response = await fetch(`./api/download?${query}`, {
            headers: {
                Authorization: `Bearer ${token}`,
                'ngrok-skip-browser-warning': '1',
            },
            credentials: 'omit',
            cache: 'no-store',
        });
        if (!response.ok) {
            if (response.status === 401) lock();
            throw new Error(
                response.status === 409
                    ? '파일 목록이 바뀌었습니다. 새로고침 후 다시 다운로드해 주세요.'
                    : requestError(response.status),
            );
        }
        if (
            !(response.headers.get('content-type') || '').startsWith(
                'application/octet-stream',
            )
        )
            throw new Error(
                '원본 대신 안내 페이지가 반환됐습니다. 잠시 후 다시 시도해 주세요.',
            );
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        status(`${filename} 원본 다운로드를 브라우저에 전달했습니다.`);
    } catch (error) {
        status(error.message, true);
    } finally {
        managementWorking(false);
    }
}
async function loadFiles() {
    const project = $('project').value;
    const requestId = ++filesRequestId;
    pwaSettings = null;
    settingsProject = '';
    pwaDirty = false;
    $('pwa-settings').hidden = true;
    filesLoading = Boolean(project && authenticated);
    fileState = null;
    renderFiles();
    updateSubmit();
    if (!project || !authenticated) return;
    $('files-summary').textContent = '적용 파일을 불러오는 중…';
    try {
        const [data, settings] = await Promise.all([
            managementApi(`./api/files?project=${encodeURIComponent(project)}`),
            managementApi(`./api/pwa?project=${encodeURIComponent(project)}`),
        ]);
        if (
            requestId !== filesRequestId ||
            $('project').value !== project ||
            !authenticated
        )
            return;
        fillPwaSettings(settings, project);
        fileState = data;
        renderFiles();
    } catch (error) {
        if (requestId === filesRequestId) {
            $('files-summary').textContent = '목록을 불러오지 못했습니다.';
            status(error.message, true);
        }
    } finally {
        if (requestId === filesRequestId) {
            filesLoading = false;
            renderCurrentProject();
            updateSubmit();
        }
    }
}
function managementWorking(value) {
    managementBusy = value;
    $('project').disabled = value;
    $('file').disabled = value;
    $('refresh').disabled = value;
    updateSubmit();
}
function fillPwaSettings(settings, project = $('project').value) {
    if (project !== $('project').value) return;
    pwaSettings = settings;
    settingsProject = project;
    pwaDirty = false;
    projectModes.set($('project').value, settings.enabled === true);
    $('pwa-settings').hidden = false;
    $('pwa-enabled').checked = settings.enabled === true;
    $('pwa-fields').hidden = !settings.enabled;
    $('pwa-name').value = settings.name || '';
    $('pwa-short-name').value = settings.shortName || '';
    $('pwa-description').value = settings.description || '';
    $('pwa-theme').value = settings.themeColor || '#245fd6';
    $('pwa-background').value = settings.backgroundColor || '#eef2f5';
    $('pwa-save-state').textContent = settings.enabled
        ? 'PWA 설정이 적용되어 있습니다.'
        : '일반 HTML·ZIP 프로젝트입니다.';
    syncProjectMode();
}
for (const id of [
    'pwa-enabled',
    'pwa-name',
    'pwa-short-name',
    'pwa-description',
    'pwa-theme',
    'pwa-background',
]) {
    $(id).addEventListener('input', () => {
        const draft = pwaDraft();
        pwaDirty =
            !!pwaSettings &&
            Object.keys(draft).some(
                (key) => key !== 'revision' && draft[key] !== pwaSettings[key],
            );
        $('pwa-fields').hidden = !$('pwa-enabled').checked;
        $('pwa-save-state').textContent = pwaDirty
            ? '설정 저장 버튼 또는 파일 업로드 시 함께 저장됩니다.'
            : '저장된 설정과 같습니다.';
        updateSubmit();
    });
}
function pwaDraft() {
    return {
        revision: pwaSettings?.revision,
        enabled: $('pwa-enabled').checked,
        name: $('pwa-name').value.trim(),
        shortName: $('pwa-short-name').value.trim(),
        description: $('pwa-description').value.trim(),
        themeColor: $('pwa-theme').value,
        backgroundColor: $('pwa-background').value,
    };
}
async function savePwaSettings() {
    if (
        !authenticated ||
        !pwaSettings ||
        activeRequest ||
        managementBusy ||
        filesLoading ||
        settingsProject !== $('project').value
    )
        return false;
    if (!pwaDirty) return true;
    const project = $('project').value;
    const body = pwaDraft();
    if (body.enabled && (!body.name || !body.shortName)) {
        status('앱 이름과 짧은 이름을 입력해 주세요.', true);
        return false;
    }
    managementWorking(true);
    status('PWA 설정을 저장하고 배포본에 반영하는 중…');
    try {
        const settings = await managementApi(
            `./api/pwa?project=${encodeURIComponent(project)}`,
            body,
        );
        if (!authenticated || $('project').value !== project) return false;
        fillPwaSettings(settings, project);
        await loadFiles();
        status(
            body.enabled
                ? 'PWA 설정을 저장하고 반영했습니다. HTML만 업로드하면 됩니다.'
                : 'PWA 생성을 해제했습니다. 원본 파일은 유지됩니다.',
        );
        return true;
    } catch (error) {
        status(error.message, true);
        return false;
    } finally {
        managementWorking(false);
    }
}
$('pwa-save').addEventListener('click', savePwaSettings);
async function applyFile(filename) {
    if (!fileState || managementBusy || activeRequest || filesLoading) return;
    const snapshot = fileState;
    managementWorking(true);
    status('선택한 파일을 적용하는 중…');
    try {
        fileState = await managementApi(
            `./api/apply?project=${encodeURIComponent(snapshot.project)}`,
            { revision: snapshot.revision, filename },
        );
        renderFiles();
        status(`${filename}을 적용했습니다.`);
        $('result').hidden = true;
    } catch (error) {
        await loadFiles();
        status(error.message, true);
    } finally {
        managementWorking(false);
    }
}
$('files-refresh').addEventListener('click', loadFiles);
$('share-project').addEventListener('click', async () => {
    const project = $('project').value;
    if (
        !project ||
        !authenticated ||
        activeRequest ||
        managementBusy ||
        filesLoading
    )
        return;
    $('share-project').disabled = true;
    try {
        const data = await managementApi(
            `./api/share-qr?project=${encodeURIComponent(project)}`,
        );
        if ($('project').value !== project || !authenticated) return;
        const publicUrl = new URL(data.url);
        if (
            publicUrl.origin !== location.origin ||
            publicUrl.pathname !== `/${encodeURIComponent(project)}/` ||
            publicUrl.hash ||
            publicUrl.search ||
            !/^data:image\/png;base64,/.test(data.image)
        )
            throw new Error('공유 QR 응답을 확인하지 못했습니다.');
        $('share-image').src = data.image;
        $('share-local-note').hidden = ![
            'localhost',
            '127.0.0.1',
            '[::1]',
        ].includes(publicUrl.hostname);
        $('share-url').value = data.url;
        $('share-copy').textContent = '링크 복사';
        $('share-dialog').showModal();
    } catch (error) {
        status(error.message, true);
    } finally {
        updateManagementControls();
    }
});
$('share-close').addEventListener('click', () => $('share-dialog').close());
$('share-copy').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText($('share-url').value);
        $('share-copy').textContent = '복사했습니다';
    } catch {
        $('share-url').focus();
        $('share-url').select();
        $('share-copy').textContent = '선택한 주소를 복사하세요';
    }
});
function privateManagementLink() {
    const url = new URL('.', location.href);
    url.search = '';
    url.hash = 'key=' + token;
    return url.href;
}
function clearManageDialog() {
    $('manage-image').removeAttribute?.('src');
    $('manage-image').hidden = true;
    $('manage-url').value = '';
    $('manage-dialog-copy').textContent = '관리 링크 복사';
}
function dismissManageDialog() {
    manageQrRequest++;
    if ($('manage-dialog').open) $('manage-dialog').close();
    clearManageDialog();
}
function fillManageDialog(url, image) {
    clearManageDialog();
    $('manage-url').value = url;
    $('manage-local-note').hidden = ![
        'localhost',
        '127.0.0.1',
        '[::1]',
    ].includes(new URL(url).hostname);
    if (image) {
        $('manage-image').src = image;
        $('manage-image').hidden = false;
    }
    if (!$('manage-dialog').open) $('manage-dialog').showModal();
}
$('manage-qr').addEventListener('click', async () => {
    if (!authenticated || activeRequest || managementBusy || manageQrLoading)
        return;
    const requestId = ++manageQrRequest;
    const requestToken = token;
    manageQrLoading = true;
    updateManagementControls();
    try {
        const data = await managementApi('./api/manage-qr');
        if (
            requestId !== manageQrRequest ||
            requestToken !== token ||
            !authenticated ||
            activeTab !== 'share'
        )
            return;
        if (
            data.url !== privateManagementLink() ||
            !/^data:image\/png;base64,/.test(data.image)
        )
            throw new Error('관리 QR 응답을 확인하지 못했습니다.');
        fillManageDialog(data.url, data.image);
    } catch (error) {
        if (requestId === manageQrRequest) status(error.message, true);
    } finally {
        manageQrLoading = false;
        updateManagementControls();
    }
});
async function copyManagementLink() {
    if (!authenticated) return;
    const url = privateManagementLink();
    try {
        await navigator.clipboard.writeText(url);
        $('manage-copy-status').textContent =
            '기존 관리 링크를 복사했습니다. 본인 기기에서 열어 주세요.';
        $('manage-dialog-copy').textContent = '복사했습니다';
    } catch {
        if (!$('manage-dialog').open) fillManageDialog(url);
        $('manage-url').focus();
        $('manage-url').select();
        $('manage-dialog-copy').textContent = '선택한 주소를 복사하세요';
    }
}
$('manage-copy').addEventListener('click', copyManagementLink);
$('manage-dialog-copy').addEventListener('click', copyManagementLink);
$('manage-close').addEventListener('click', dismissManageDialog);
$('manage-dialog').addEventListener('close', clearManageDialog);
window.addEventListener('pagehide', dismissManageDialog);
$('cleanup').addEventListener('click', () => {
    if (
        !fileState ||
        !fileState.cleanup.count ||
        activeRequest ||
        managementBusy ||
        filesLoading
    )
        return;
    cleanupPreview = fileState;
    $('cleanup-keep').textContent = cleanupPreview.active;
    $('cleanup-summary').textContent =
        `${cleanupPreview.cleanup.count}개 파일, ${formatSize(cleanupPreview.cleanup.bytes)}를 정리합니다.`;
    $('cleanup-files').replaceChildren();
    for (const file of cleanupPreview.files.filter((file) => !file.active)) {
        const item = document.createElement('li');
        item.textContent = file.name;
        $('cleanup-files').append(item);
    }
    $('cleanup-dialog').showModal();
});
$('cleanup-cancel').addEventListener('click', () =>
    $('cleanup-dialog').close(),
);
$('cleanup-confirm').addEventListener('click', async () => {
    const snapshot = cleanupPreview;
    $('cleanup-dialog').close();
    cleanupPreview = null;
    if (!snapshot || managementBusy || activeRequest) return;
    managementWorking(true);
    status('이전 HTML·ZIP 파일을 정리하는 중…');
    try {
        const result = await managementApi(
            `./api/cleanup?project=${encodeURIComponent(snapshot.project)}`,
            { revision: snapshot.revision },
        );
        await loadFiles();
        status(
            `${result.deleted.length}개 파일을 정리했습니다. 최신 적용 파일은 유지했습니다.`,
        );
    } catch (error) {
        await loadFiles();
        status(error.message, true);
    } finally {
        managementWorking(false);
    }
});
function authenticateLink() {
    dismissManageDialog();
    if (activeRequest) activeRequest.abort();
    token = new URLSearchParams(location.hash.slice(1)).get('key') || '';
    const requestedTab = new URLSearchParams(location.hash.slice(1)).get('tab');
    activeTab = tabNames.includes(requestedTab) ? requestedTab : 'upload';
    if (/^[a-f0-9]{64}$/i.test(token)) loadProjects();
    else lock();
}
for (const name of tabNames) {
    $('tab-' + name).addEventListener('click', () => selectTab(name));
    $('tab-' + name).addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            return;
        event.preventDefault();
        const index = tabNames.indexOf(name);
        const next =
            event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabNames.length - 1
                  : (index +
                        (event.key === 'ArrowRight' ? 1 : -1) +
                        tabNames.length) %
                    tabNames.length;
        selectTab(tabNames[next], true);
    });
}
window.addEventListener('hashchange', authenticateLink);
window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !authenticated) return;
    if (activeRequest) activeRequest.abort();
    activeRequest = null;
    managementBusy = false;
    filesLoading = true;
    const requestedTab = new URLSearchParams(location.hash.slice(1)).get('tab');
    activeTab = tabNames.includes(requestedTab) ? requestedTab : 'upload';
    $('file').disabled = false;
    $('project').disabled = false;
    $('refresh').disabled = false;
    $('cancel').hidden = true;
    $('progress-area').hidden = true;
    updateSubmit();
    loadProjects();
});
authenticateLink();
