# AGENTS.md

이 문서는 `C:\Develop\rosemary-app`에서 작업하는 에이전트를 위한 프로젝트 전용 가이드입니다.

## 1) 프로젝트 개요

- 목적: 로컬 폴더를 스캔해 압축 파일을 수집하고, 중복을 확인한 뒤 저장소로 이동/보관하는 Electron 데스크톱 앱
- 런타임: Electron (`main`/`preload`/`renderer` 분리)
- UI: React + Tailwind CSS v4 + DaisyUI
- 언어: TypeScript
- 패키지 매니저: `pnpm` (`pnpm-lock.yaml` 기준)
- 포맷/린트: Biome (`biome.json`)

## 2) 디렉터리 구조(핵심)

- `src/main/index.ts`
  - 파일 시스템 작업, 설정 저장/로드, IPC 핸들러의 단일 진입점
- `src/preload/index.ts`, `src/preload/index.d.ts`
  - 렌더러 브리지 정의
- `src/renderer/src/*`
  - React UI, 훅, 컴포넌트, 파일명 파싱 로직
- `electron.vite.config.ts`
  - renderer alias: `@renderer -> src/renderer/src`
- `electron-builder.yml`
  - 패키징 설정

## 3) 개발 명령어

- 설치: `pnpm install`
- 개발 실행: `pnpm dev`
- 정적 점검:
  - `pnpm check`
  - `pnpm typecheck`
- 빌드:
  - `pnpm build`
  - 플랫폼별: `pnpm build:win`, `pnpm build:mac`, `pnpm build:linux`

작업 후 기본 검증은 `pnpm check && pnpm typecheck`를 우선한다.

## 4) 코드 스타일/규칙

- 포맷/린트의 기준은 Biome이다.
  - `biome.json` 기준 탭 들여쓰기, 더블 쿼트 사용
- `.editorconfig`와 포맷 설정이 일부 상충할 수 있으므로, 최종 기준은 Biome 결과로 맞춘다.
- 새 코드도 기존 패턴대로 함수형 React + 훅 중심으로 작성한다.
- 사용자 노출 메시지는 기존 UI 흐름에 맞춰 한국어를 기본으로 유지한다.

## 5) IPC 및 아키텍처 규칙

이 프로젝트의 파일/OS 접근은 반드시 `main` 프로세스 IPC를 통해 처리한다.

현재 사용 중인 주요 채널:
- `get-target-path`
- `get-settings`, `save-settings`
- `select-file-path`
- `scan-files`
- `check-duplicate-files`
- `move-all-files-to-store`
- `copy-file`, `move-file`, `delete-file`, `keep-file`
- `open-with-bandiview`

IPC를 추가/변경할 때는 반드시 아래를 함께 수정한다.
- `src/main/index.ts`의 `ipcMain.handle(...)`
- 렌더러 호출부(`window.electron.ipcRenderer.invoke`)
- 타입 경계(`src/preload/index.d.ts` 또는 관련 타입 선언)
- 오류 메시지/예외 처리(UI alert 포함)

## 6) 도메인 로직 주의사항

- 스캔 대상은 압축 파일 위주이며, 이미지/영상/문서 등은 제외된다.
- 중복 판정/이동은 `scanPath` 기준 상대 경로를 유지하는 것이 핵심이다.
- 파일 이동 시 `EXDEV`(cross-device) 예외를 고려해 `copy + unlink` 폴백을 유지한다.
- 파괴적 작업(삭제/이동)은 기존처럼 사용자 확인 흐름(`confirm`)을 유지한다.
- 설정 파일은 `app.getPath("userData")/settings.json`을 사용한다.

## 7) UI 작업 가이드

- 스타일은 Tailwind + DaisyUI 컴포넌트 체계를 유지한다.
- 현재 테이블/모달/카드 중심 레이아웃을 크게 깨지 않게 확장한다.
- 키보드 UX를 보존한다.
  - `Enter`: 선택 파일 BandiView 열기
  - `Delete`: 목록에서 제거
  - `Shift+Delete`: 실제 파일 삭제

### Open Design MCP 사용 시 구현 조건

- Open Design artifact HTML을 그대로 복사하지 말 것
- 기존 React 컴포넌트와 스타일 시스템을 우선 사용
- 새 UI 라이브러리 추가 금지
- API 로직 변경 금지
- 라우트 변경 금지
- 데이터 fetching 방식 변경 금지
- 375px, 768px, 1440px 반응형 고려
- 접근성 유지
- focus state, aria-label, keyboard navigation 확인

## 8) 테스트/검증 전략

현재 별도 테스트 프레임워크(단위/E2E) 설정이 없다.
따라서 변경 시 아래를 기본 수동 검증 항목으로 사용한다.

- 폴더 선택 -> 스캔 -> 목록 렌더링
- 중복 감지 -> 처리 모달(덮어쓰기/건너뛰기/개별)
- 이동/복사/보관/삭제 동작
- 설정 저장/재로딩
- `pnpm check && pnpm typecheck` 통과

## 9) 버전 관리

버전은 `x.y.z` 형식으로 관리한다.

- `x`: 사용자가 명시적으로 메인/메이저 릴리스를 요청했거나, 새 탭/새 워크플로/데이터 구조 변경처럼 앱 사용 방식이 크게 바뀌는 릴리스 단위 변경
- `y`: 기존 기능의 의미 있는 사용성 개선, 성능 개선, 화면 개선이 포함되지만 앱 사용 방식 자체는 유지되는 릴리스 단위 변경
- `z`: 버그 수정, 보안/안정성 패치, 작은 UI 조정, 내부 성능 개선, 리뷰 반영, 긴급 패치

버전 업데이트는 보수적으로 판단한다. 기본값은 `z` 패치이며, `x`/`y` 증가는 변경이 사용자에게 하나의 릴리스로 전달될 만큼 충분히 크고 명확할 때만 적용한다.

- 메인 업데이트로 판단되면 `x`를 올리고 `y`, `z`는 `0`으로 초기화한다.
- 마이너 업데이트로 판단되면 `y`를 올리고 `z`는 `0`으로 초기화한다.
- 패치 업데이트로 판단되면 `z`만 올린다.
- 같은 기능/요구사항을 구현하는 연속 작업, 리뷰 반영, 후속 버그 수정은 가능하면 하나의 버전 업데이트로 묶고, 이미 해당 작업 묶음에서 버전을 올렸다면 추가 증가는 생략한다.
- 앱 동작, UI, 배포 산출물에 영향이 있어도 변경 규모가 작거나 후속 보완 성격이면 기본적으로 패치(`z`)만 적용한다.
- 성능 개선은 새 동작이나 새 화면이 아니라면 패치(`z`)로 처리한다. 단, 사용자가 명시적으로 릴리스 단위 개선으로 요청했거나 영향 범위가 앱 전반이면 마이너(`y`)를 검토한다.
- 화면 개선은 작은 배치/문구/밀도/상태 표시 조정이면 패치(`z`)로 처리하고, 새 화면 구조나 주요 워크플로 변경일 때만 마이너(`y`) 이상을 검토한다.
- 문서/주석/내부 가이드만 변경하는 등 릴리스 영향이 없다고 판단되는 경우에는 버전 변경을 생략할 수 있으며, 최종 보고에 그 사유를 명시한다.
- 버전을 올릴지 애매하면 올리지 않거나 패치(`z`)로 제한하고, 최종 보고에 판단 사유를 남긴다.

## 10) Git 브랜치 워크플로

- 장기 브랜치는 `master` 하나만 사용한다. `develop` 브랜치는 만들거나 복구하지 않는다.
- 모든 기능 개발, 버그 수정, 리팩터링은 최신 `origin/master`에서 분기한 `codex/<task-slug>` 단기 브랜치에서 수행한다.
- 브랜치 이름은 작업 의도가 드러나는 짧은 kebab-case를 사용한다.
  - 예: `codex/hitomi-api-readiness`, `codex/renderer-lazy-loading`
- 하나의 브랜치에는 하나의 사용자 요청 또는 하나의 밀접한 작업 묶음만 포함한다.
- 새 작업을 시작하기 전에 아래 순서를 따른다.
  - 현재 변경 사항과 브랜치를 확인한다.
  - `git fetch --prune origin`으로 원격 상태를 갱신한다.
  - 열린 PR과 기존 `codex/*` 브랜치가 같은 작업을 진행 중인지 확인한다.
  - 깨끗한 최신 `master`에서 새 작업 브랜치를 만든다.
- 검증이 끝난 변경은 PR에서 squash merge하여 `master`의 히스토리를 작업 단위로 유지한다.
- 병합된 `codex/*` 브랜치는 로컬과 원격에서 제거하고, 다음 작업 전에 원격 추적 브랜치를 prune한다.
- `master` 직접 커밋과 force push는 브랜치 구조 복구 같은 명시적인 저장소 관리 작업이 아니면 금지한다.
- 커밋, push, PR 생성, 병합은 사용자가 해당 작업을 요청하거나 명확히 승인한 범위에서만 수행한다.
- 커밋되지 않은 사용자 변경이 있으면 stash, reset, checkout으로 임의 정리하지 말고 현재 작업과 분리해 보존한다.

## 11) 변경 범위 원칙

- 가능하면 `src/**` 중심으로 최소 수정한다.
- 생성 산출물/의존성 폴더는 직접 수정하지 않는다.
  - `dist/`, `out/`, `build/`, `node_modules/`
- 릴리스 작업이 아닌 경우 `electron-builder.yml` 변경은 지양한다.
