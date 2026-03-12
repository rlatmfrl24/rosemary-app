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

## 8) 테스트/검증 전략

현재 별도 테스트 프레임워크(단위/E2E) 설정이 없다.
따라서 변경 시 아래를 기본 수동 검증 항목으로 사용한다.

- 폴더 선택 -> 스캔 -> 목록 렌더링
- 중복 감지 -> 처리 모달(덮어쓰기/건너뛰기/개별)
- 이동/복사/보관/삭제 동작
- 설정 저장/재로딩
- `pnpm check && pnpm typecheck` 통과

## 9) 변경 범위 원칙

- 가능하면 `src/**` 중심으로 최소 수정한다.
- 생성 산출물/의존성 폴더는 직접 수정하지 않는다.
  - `dist/`, `out/`, `build/`, `node_modules/`
- 릴리스 작업이 아닌 경우 `electron-builder.yml` 변경은 지양한다.

