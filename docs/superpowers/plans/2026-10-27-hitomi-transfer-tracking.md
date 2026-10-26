# Hitomi 전송 식별·상태·중복 방지 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 원본 URL을 보존하고 접수와 완료 미확인을 구분하며, 응답 유실·재시작·동시 재시도로 같은 요청을 다시 전송하지 않는다.

**Architecture:** 기존 API와 Electron main/preload/renderer 구조를 유지한다. 공급자와 작품 ID를 검증한 전체 URL을 전달하고, crawler.sqlite에 원본 URL별 전송 의도와 결과를 HTTP 변경 요청 전에 기록한다. 접수 응답은 완료 증거가 아니므로 현재 API에서는 다운로드 완료를 명시적으로 미확인으로 표시한다.

**Tech Stack:** 기존 TypeScript, node:sqlite, fetch, React/DaisyUI, Node test, Playwright Electron.

**Spec:** 사용자의 2026-10-27 구현 요청과 docs/research/2026-10-27-downloader-options.md의 기존 API 보강안.

## Global Constraints

- computer-use 없이 검증한다. 새 의존성·자체 다운로드 엔진·범용 IPC를 추가하지 않는다.
- 접수 여부가 불명확한 작업의 자동 재전송을 금지한다. 외부 엔진의 exactly-once나 파일 완료를 주장하지 않는다.
- 기존 데이터와 제외 태그, 전용 preload, IPC 발신자·입력 검증을 보존한다.
- 기존 숫자 전송 이력은 원본·접수 여부를 추정하지 않고 보류한다.
- 후속 사용자 요청에 따라 최종 검토 후 커밋·푸시·PR 생성을 진행한다. 병합·설치는 포함하지 않는다. 제품 변경은 패치 버전으로 묶는다.

## Review Focus

- 응답은 유실됐지만 엔진에 접수된 경우 재시도가 POST를 반복하지 않아야 한다.
- 전송 직전/직후 앱 종료와 동시 호출에서도 영속 기록이 중복 제출을 막아야 한다.
- 기존 숫자 전송 기록, DB 초기화·항목 삭제 뒤에도 불확실한 요청을 새 요청처럼 보내지 않아야 한다.
- 같은 숫자의 다른 공급자·원본 토큰을 혼동하거나 수정된 링크로 이전 요청을 재해석하지 않아야 한다.
- HTTP 200의 잘못된 본문, 접수 응답, 제외 태그를 완료로 오인하지 않아야 한다.

## Task 1: 원본 식별과 영속 전송 경계

**Files:** src/shared/hitomi-download.ts, src/main/hitomi-api.ts, src/main/crawler-download-dispatch.ts, src/main/crawler-database.ts, tests/hitomi-download-dispatch.test.mjs, tests/crawler-download-dispatch.test.mjs, tests/crawler-database.test.mjs.

**Interfaces:** 검증된 DownloadSource(provider, galleryId, sourceUrl); sendSourcesToHitomiApi(sources, settings, database); 기존 sendCodesToHitomiApi는 명시적 Hitomi 원본으로 변환하며 같은 영속 경계를 통과한다.

- [x] 원본 URL·동시 요청·접수 후 응답 유실·안전한 사전 실패 재시도·재시작·레거시 마이그레이션 회귀 테스트를 작성하고 실패를 확인한다.
- [x] 요청 원장을 추가하고 변경 요청 전에 제출 중 상태를 선점한다. 접수 응답을 검증하며 전송 시도 후의 오류는 결과 불명으로 기록한다.
- [x] 기존 발견 중복 방지와 별개로 원본별 전송 기록을 보존하고 크롤링 DB 내용 초기화에서도 유지한다.
- [x] 해당 Node 테스트가 통과하는지 확인한다.

## Task 2: 실제 크롤링·IPC·화면 연결

**Files:** src/main/crawler.ts, src/main/ipc.ts, src/shared/crawler.ts, src/shared/settings.ts, src/renderer/src/components/CrawlerPanel.tsx, src/renderer/src/components/CrawlerDbPanel.tsx, src/preload/index.ts, src/preload/index.d.ts, tests/ipc-security.test.mjs.

**Interfaces:** 기존 IPC와 호출 형태 유지. snapshot에 결과 불명 건수와 완료 확인 상태를 제공하고, 각 크롤링 항목에 전달 원본과 전송 상태를 제공한다.

- [x] 크롤러가 숫자 대신 검증된 원본 링크를 전달하고, 항목별 영속 결과를 상태 조회에서 읽도록 연결한다.
- [x] 실패 재시도는 확실히 제출되지 않은 실패만 선택한다. 결과 불명은 명시적 안내와 함께 보류한다.
- [x] 전송 접수/접수 불명/다운로드 완료 미확인과 원본 공급자·링크를 화면에 표시한다.
- [x] 공통 IPC 검증과 설정·DB 소비자 타입을 확인한다.

## Task 3: 검증과 기록

- [x] pnpm check, pnpm typecheck와 관련 Node 테스트를 실행한다.
- [x] Playwright Electron으로 실제 preload·상태 조회·실패 재시도·화면 표시와 영속 DB readback을 확인한다.
- [x] 설치 API의 읽기 전용 응답과 제품 연결을 확인하되, 미검증 다운로드 완료를 주장하지 않는다.
- [x] 최종 diff를 검토하고 실행한 검증과 실제 다운로드·완료 판정 한계를 보고한다.

## 실행 결과 (2026-10-27)

- 제품 버전 8.4.10. 원본은 공급자·작품 ID·토큰으로 식별하고 전체 URL을 전달한다. E-Hentai와 ExHentai의 동일 원본은 같은 전송 키로 취급한다.
- 전송 기록은 변경 요청 전에 SQLite에 선점하며 각 응답 직후 갱신한다. 동시 호출·응답 유실·재시작에서 불확실한 제출을 다시 보내지 않는다. 이는 외부 엔진의 exactly-once 보장이 아니다.
- 이전 버전의 숫자 전송 이력은 기대한 E-Hentai 원본과 숫자로 해석될 수 있는 Hitomi 원본 양쪽을 보수적으로 보류한다. 실제 미접수였더라도 확인 불가능한 요청은 자동 재전송하지 않는다.
- 전송 전 실패만 재시도하며, 제외 태그가 원본별 전송 기록보다 해당 크롤링 항목에서 우선한다. 클립보드에는 원본 URL을 보존하고 미지원 링크 하나가 독립적인 새 수집을 막지 않도록 했다.
- 기존 IPC 채널·입력 형태·발신자 검증을 유지했다. preload는 공유 타입을 이미 사용하므로 별도 범용 API나 새 채널을 추가하지 않았다.
- pnpm test: 136개 중 135개 PASS, FAIL 0, 기존 Linux 전용 대소문자 구분 검사 1개는 Windows에서 SKIP.
- pnpm check: PASS, 기존 optional-chain 경고 4개. pnpm build의 node/web typecheck와 실제 번들 생성 PASS. git diff --check PASS.
- Playwright Electron: 실제 8.4.10 창과 main/preload/renderer, 임시 프로필 SQLite, 클립보드, 재시도·재시작·DB 초기화·재수집을 사용했다. 원본 3개의 제출은 총 3회이고, 응답 유실 항목의 반복 제출은 0회였다. POST 수신 시 DB의 submitting 상태도 직접 읽었다.
- 설치된 API는 실제 읽기 전용 ping으로 확인했다. 오류·응답 유실 검증에는 통제된 HTTP 응답을 사용했다. 실제 미디어 다운로드와 외부 엔진의 파일 완성은 검증하지 않았다.
- 현재 API의 접수 응답은 완료 증거가 아니므로 UI·DTO 모두 다운로드 완료를 unverified로 유지한다. 실제 완료 판정은 기존 API가 제공하지 않는 별도 계약이 필요하며, 완료로 추정하는 코드는 추가하지 않았다.
- 별도 코드 리뷰에서 발견한 제외 태그 우선순위와 클립보드/새 수집 차단 회귀를 수정하고 검증했다. 남은 중대한 리뷰 지적은 없다.
- 구현 검증 단계에서는 computer-use, 커밋, 푸시, PR 생성, 설치를 수행하지 않았다. 이전 연구 문서는 보존했다.
- 게시 전 최종 검토: 요구사항과 저장소 규칙을 독립적으로 검토했고 중대한 지적은 없다. 관련 테스트 26개, 정적 검사와 타입 검사를 다시 통과했다. 구현이 동일하여 앞서 통과한 전체 테스트와 Electron 검증 결과를 재사용한다. 게시 후 커밋 식별자와 검증 판정은 PR에 기록한다.
