# HTML Share

**HTML·ZIP을 프로젝트별로 공유하고, 모바일 관리와 공용 PWA 템플릿을 제공하는 개인용 웹 파일 서빙 도구입니다.**

> **[📖 사용 설명서 바로 보기](https://htmlpreview.github.io/?https://github.com/byh-playground/html-share/blob/main/docs/usage.html)**  
> 설치, 터널 연결, 업로드, PWA, QR·알림, 명령어와 문제 해결을 목차가 있는 웹 문서로 볼 수 있습니다.

## 프로젝트 소개

HTML Share는 PC에서 실행한 웹 서버를 터널로 공개하고, 휴대폰에서 파일을 올려 바로 확인하는 흐름을 지원합니다. 직접 만든 HTML이나 신뢰하는 웹 앱을 반복해서 수정·공유하는 개인 사용자를 위한 프로젝트입니다.

소유자 한 명이 파일과 설정을 관리하고, 방문자에게는 프로젝트의 보기 링크만 전달합니다. 방문자가 여러 명인 것은 괜찮지만, 서로 신뢰하지 않는 업로더를 격리하는 다중 사용자 호스팅을 목표로 하지는 않습니다.

## 주요 기능

| 영역 | 제공 기능 |
| --- | --- |
| 파일 서빙 | 프로젝트별 최신 HTML·HTM·ZIP 선택, ZIP 자동 압축 해제 |
| 모바일 관리 | 업로드·적용 관리·PWA 설정·공유 탭, 업로드 후 바로 페이지 확인 |
| 버전 관리 | 이전 파일 재적용, 원본 다운로드, 삭제 미리보기와 최신 파일만 남기기 |
| PWA | 공용 템플릿, 프로젝트별 메타데이터·서비스 워커·배포본, 원본 보존 |
| 외부 공유 | Cloudflare Quick Tunnel·ngrok 선택, 관리용·방문자용 QR 분리 |
| 알림 | 선택형 ntfy 시작·주소 변경·업데이트 알림 |

## 실행 환경과 기술 구성

- **실행 도구:** Windows 10/11 64비트, PowerShell 5.1 이상
- **서버:** Node.js 22.17 이상, 기본 HTTP 서버와 CommonJS 모듈
- **관리 화면:** HTML·CSS·JavaScript, 별도 프런트엔드 빌드 과정 없음
- **외부 접속:** Cloudflare Quick Tunnel 또는 ngrok
- **검증:** Node 테스트 러너, Playwright, GitHub Actions

Windows 실행 도구를 제공하며 서버 테스트는 Windows·Linux를 대상으로 구성되어 있습니다. 서버 PC가 실행 중이고 인터넷에 연결되어 있어야 외부에서 사용할 수 있습니다.

## 저장소 구조

```text
share.ps1                   사용자용 설치·실행·관리 명령
src/                        웹 서비스 구현
    server/                 HTTP 서버와 공개 라우팅
    projects/               최신 원본 선택·ZIP 검증과 압축 해제
    management/             관리 인증·업로드·다운로드·버전 관리
        ui/                 모바일 관리 화면
    pwa/                    PWA 설정과 배포본 생성
        template/           공용 서비스 워커와 기본 아이콘
    notifications/          ntfy 알림
scripts/                    실행 목적별 보조 도구
    tunnel/                 Quick Tunnel 실행 감시와 재연결
    sharing/                공유·ntfy 등록 QR 생성
    pwa/                    명령줄 PWA 설정
    development/            소스 검사·포맷·공개 소스 내보내기
tests/                      영역별 검증
    server/, projects/      서빙·원본 선택·ZIP 테스트
    management/, pwa/       관리 API·화면 상태·PWA 테스트
    notifications/, sharing/ 알림·QR 테스트
    cli/, tunnel/, release/ 명령·터널·공개 소스 구성 테스트
    browser/                모바일 화면·업로드·PWA 브라우저 검증
docs/                       사용 설명서와 설계 문서
public/example/             기본 예제
.github/workflows/          GitHub Actions 자동 검사
```

루트에는 실행 진입점, 저장소 문서, 공통 설정만 둡니다. 서비스 기능은 `src/`, 별도로 실행하는 도구는 `scripts/` 아래에서 역할별로 관리하고, 테스트도 같은 관점으로 나눕니다. 예를 들어 관리 화면은 `src/management/ui/`, PWA 공용 자산은 `src/pwa/template/`에서 찾을 수 있습니다.

개인 프로젝트·인증정보·캐시·터널 실행 파일은 `projects/`, `.runtime/`, `.tools/`에 보관하며 Git에서 제외합니다. 예제 외의 `public/` 프로젝트도 제외합니다.

## 개발과 검증

```powershell
npm ci --ignore-scripts
npm run check
npm run format:check
npm test
npx playwright install chromium
npm run test:browser
```

들여쓰기는 **공백 4칸**이며 EditorConfig와 Prettier 설정을 공유합니다. `npm run format`은 공개 소스만 정렬하고 개인 업로드와 런타임 파일은 건드리지 않습니다.

테스트는 임시 프로젝트와 가짜 인증 키를 사용합니다. GitHub Actions는 Windows·Linux의 Node.js 22·24 테스트와 브라우저 검사를 수행하며, 서비스를 배포하지 않습니다.

## 문서

- **[웹 사용 설명서](https://htmlpreview.github.io/?https://github.com/byh-playground/html-share/blob/main/docs/usage.html)** — 목차, 설치·사용 흐름, 명령어, 문제 해결
- [상세 사용 가이드 원문](docs/USAGE.ko.md)
- [관리 화면 UX 원칙](docs/UX.md)
- [보안 및 운영 범위](SECURITY.md)
- [변경 기록](CHANGELOG.md)

웹 설명서는 저장소의 HTML을 [HTML Preview](https://htmlpreview.github.io/)로 표시합니다. 문서가 공개 저장소의 `main` 브랜치에 올라간 뒤 사용할 수 있으며, 로컬에서는 `docs/usage.html`을 브라우저로 직접 열어도 됩니다.

## 지원 범위

본인이 신뢰하는 파일의 미리보기·공유를 위한 도구입니다. 프로젝트 간 독립 웹 출처, 여러 관리자 계정, 저장 공간 자동 정리, 상시 운영 보장은 제공하지 않습니다. 관리 링크와 관리 QR은 업로드·설정 권한을 포함하므로 소유자만 보관해야 합니다.

## 라이선스

현재 라이선스는 미정이며 `UNLICENSED`로 표시되어 있습니다. 재사용·수정·재배포 허용 조건은 라이선스 선정 후 안내합니다.
