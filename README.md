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
