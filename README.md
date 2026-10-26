# rosemary-app

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [Biome](https://marketplace.visualstudio.com/items?itemName=biomejs.biome)

## Project Setup

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```

### 검증

```bash
pnpm test
pnpm test:coverage
pnpm check
pnpm typecheck
pnpm build
```

테스트는 기존 Node 테스트 방식으로 실행합니다. 커버리지 명령은 로드된 모듈의
실행 비율과 로드되지 않은 전체 소스 목록을 함께 출력합니다. 미측정 소스는
통과한 것으로 해석하지 않습니다. Electron의 실제 화면 흐름은 별도 검증이 필요합니다.

다운로더 API의 `접수 확인`은 파일 다운로드 완료를 뜻하지 않습니다. 현재 API에는
문서화된 완료 증거가 없어 `다운로드 완료 미확인`으로 표시합니다. 응답 유실·종료로
접수 여부가 불명확한 요청과 이전 버전의 숫자 전송 이력은 재전송을 보류합니다.
중복 방지 기록은 수집 데이터 초기화 후에도 유지됩니다.

전송 흐름의 Electron 검증은 빌드 후 `node tests/hitomi-transfer.electron.mjs`로 실행합니다.
`ROSEMARY_PLAYWRIGHT_MODULE`에 사용할 Playwright의 `index.mjs` 절대 경로를,
`HITOMI_DOWNLOADER_PATH`에 이미 실행 중인 다운로더 경로를 지정합니다.
이 검증은 임시 프로필과 통제된 HTTP 응답을 사용하며 실제 미디어를 내려받지 않습니다.
