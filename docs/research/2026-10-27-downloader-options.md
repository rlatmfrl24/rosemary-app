# 자체 다운로더 도입 기술 검토

검토일: 2026-10-27 · 대상: Rosemary 8.4.9 / Windows · 기준 커밋: `aa0adbc2b42056fdb3abe081c098564018559c1e`

이 문서는 구현 승인안이 아니라 **기술 조사와 도입 판단 자료**다. 저장소 관찰, 외부 원문에서 확인한 사실, 그에 따른 제안을 구분한다. 실제 미디어 다운로드·성능 비교·장애 주입은 수행하지 않았다.

## 1. 결론과 우선순위

**자체 구현은 가능하지만, 현재 API를 즉시 대체하는 것은 권하지 않는다.** 우선 기존 연동에서 원본 식별과 완료 확인을 보강하고, 이후 지원 대상을 한정한 자체 엔진을 평가하는 순서가 적절하다. 파일 전송 자체보다 사이트별 원본 해석, 재시작 복구, 중복 방지, 완성된 압축 파일의 안전한 공개가 더 큰 구현 범위라는 판단이다. 이는 기존 API의 신뢰성이 실측으로 더 높다는 결론이 아니라, 먼저 바꿔야 할 책임과 마이그레이션 범위를 줄이려는 권고다. 아래 비교는 측정값이 아닌 설계 평가다.

먼저 해결해야 할 두 가지가 있다.

1. **`sent`는 다운로드 완료가 아니다.** 현재 Rosemary는 `/download`의 HTTP 성공 응답을 받으면 `sent`로 기록한다. upstream API 역시 `downButton(...)` 호출 뒤 성공을 반환하며 작업 ID나 완료 증명을 돌려주지 않는다. 사용자가 확인할 수 있는 의미는 “다운로더에 전송됨”까지다. [저장소 전송 경로][r-send], [upstream 요청 처리][u-download]
2. **어느 사이트의 어떤 작품을 전달하는지 검증해야 한다.** 현재 크롤러는 E-Hentai API를 사용하며 원본 링크의 `/g/(숫자)/`에서 코드를 추출한다. 항목에는 링크를 보관하지만 전송 단계에서는 `galleryId` 문자열만 넘긴다. API 확장은 그 문자열을 그대로 외부 엔진에 전달한다. E-Hentai ID와 다른 공급자의 숫자 ID가 같은 작품을 뜻한다거나, 숫자 입력이 원래 공급자를 선택한다는 근거는 이번 조사에서 확보하지 못했다. “API가 수락했다”만으로 원본 일치를 인정하면 안 된다. [메타데이터 API][r-crawler-api], [링크 파싱][r-crawler-link], [dispatch 호출][r-dispatch], [upstream 요청 처리][u-download]

권고 순서는 **원본 식별 검증 → 기존 API의 전송·완료 상태 분리 → 제한된 자체 엔진 PoC → 실측 비교 후 전환 결정**이다. 외부 API를 유지하는 동안에도 완료 확인과 재시도 정책은 개선할 수 있다. 다만 모호한 전송 결과를 다른 엔진으로 자동 재전송하는 방식은 중복 작업을 만들 수 있으므로 채택하지 않는다.

## 2. 현재 구현이 보장하는 범위

### 저장소에서 확인한 사실

| 항목 | 실제 동작 | 보장하지 않는 부분 |
| --- | --- | --- |
| API 준비 | `127.0.0.1:16009`를 사용하고 준비 상태를 확인한다. 설치 스크립트는 upstream의 지정된 loopback 바인딩을 찾아 포트를 변경한다. [구성][r-api-script], [준비·요청][r-api-request] | 같은 포트에서 응답한 프로세스가 기대한 엔진·스크립트 버전인지에 대한 강한 신원 확인 |
| 입력 전송 | 한 호출 안에서 입력을 정리·중복 제거한 뒤 `/valid_url` → `/download`를 직렬 호출한다. 일반 API 요청 제한시간은 5초다. [전송][r-send], [요청][r-api-request] | 전체 작품의 유효성, 실제 다운로드 시작, 완료·압축 성공 |
| 전송 기록 | DB에 `pending / sent / invalid / failed / excluded`, 시도 횟수와 `sent_at`을 보존한다. 기본키는 `(run_id, gallery_id)`다. [스키마][r-db], [결과 반영][r-dispatch-result] | 외부 다운로드 수락의 실행 간 멱등성, 외부 엔진 작업과의 원자적 기록, 바이트·페이지별 재개 |
| 제외 태그 | 메타데이터에서 제외 선호 태그가 일치하면 전송 대상에서 제외한다. [dispatch][r-dispatch] | 메타데이터가 없거나 실제 미디어가 다른 경우까지 포함한 콘텐츠 판정 |
| 메타데이터 | 제목·태그·파일 수·파일 크기·토큰 등 작품 메타데이터를 보관한다. [메타데이터 스키마][r-metadata] | 이미지별 URL·순서·검증값을 갖춘 다운로드 명세서 |
| 기존 통신 모듈 | 크롤러의 텍스트 요청은 세션·프록시를 처리하지만 응답을 `Buffer` 배열에 모아 문자열로 만든다. [텍스트 요청][r-text] | 대용량 바이너리 전송용 스트리밍·부분 파일·아카이브 생성 |

**해석:** DB에 전송 이력이 있다는 것은 유용한 기반이다. 그러나 외부 엔진의 작업 추가와 로컬 DB 갱신 사이에는 별도 트랜잭션이 없고, 현재 경로는 완료 파일을 읽어 확인하지 않는다. 일부 항목 전송 후 일괄 결과 반영 전에 앱이 종료되거나 응답이 유실되면 로컬 기록과 외부 작업이 어긋날 수 있다. 초기화에는 다른 백필·복구 작업의 중단 상태 처리가 있지만 dispatch 전용 대조·복구는 확인하지 못했다. 실패 재시도는 `failed`만 선택하며, `pending` 전송은 크롤링 종료 경로에 연결되어 있다. 따라서 “재시작하면 자동 중복 전송된다” 또는 “자동 복구된다” 어느 쪽도 단정하지 않는다. 이는 코드 구조에서 도출한 위험이며, 실제 발생률을 측정한 결과는 아니다. [dispatch][r-dispatch], [결과 반영][r-dispatch-result], [실패 재시도][r-retry], [크롤링 종료 전송][r-crawl-finish], [DB 초기화·중단 복구][r-db-recovery]

현재 앱에 중복 방지가 전혀 없는 것은 아니다. 새 크롤링 결과 저장 시 이미 존재하는 `crawl_items.code`를 확인해 건너뛰므로, 신규 발견 단계의 중복은 줄인다. 이것과 외부 엔진에 이미 수락된 요청을 응답 유실·재시도 때 한 번만 처리하는 보장은 서로 다른 범위다. [기존 항목 확인][r-discovery-dedup]

또한 위의 직렬 API 호출은 **외부 큐 등록 지연**의 근거다. 외부 엔진 자체의 이미지 전송 동시성·속도나 파일 전송 병목을 설명하는 근거로 확대하지 않는다. [전송 루프][r-send]

### API 문서와 소스가 말하는 범위

공식 Wiki는 `/ping`, `/valid_url`, `/download`, `/cookie` 등을 설명한다. `/download`의 성공 예시는 요청 수락이며 완료 API가 아니다. 한편 고정 커밋의 `api.py`에는 Wiki에 없는 **`GET /list`가 실제로 존재한다.** 따라서 상태 조회가 “불가능하다”고 단정할 수는 없다. 다만 이 경로는 외부 앱의 UI 항목을 `serialize(..., compat=True)`로 내보내고 그룹 처리 TODO도 남아 있어, 문서화된 안정적 작업 계약으로 보기 어렵다. Rosemary는 현재 이 목록을 완료 대조에 사용하지 않는다. [공식 Wiki][u-docs], [소스의 목록 처리][u-list], [Rosemary 전송 경로][r-send]

확인한 공개 API 소스는 `11714e4166d803ea8186c333bb155b62cf4fd9b0`이며 내부 버전은 `0.1.0`이다. Rosemary가 설치하는 URL은 별도의 `0.1.0/api.hds` 릴리스 자산이다. **현재 main의 `api.py`와 그 릴리스 자산이 바이트 단위로 같다고 간주하지 않았다.** 릴리스는 2021-11-04에 게시되었고 조회한 자산 메타데이터의 digest는 비어 있었다. 오래된 게시일만으로 고장이나 유지보수 중단을 단정할 수는 없지만, 버전·호환성 확인 없이 설치 성공을 신뢰할 근거도 아니다. [버전 소스][u-version], [설치 URL][r-api-install], [릴리스][u-release]

로컬 설치본의 읽기 전용 확인에서는 `/ping`이 HTTP 200과 `{"status":"ok"}`를 반환했고, 설치된 `api.hds`의 SHA-256은 `BA79A1E5CB383BD5081011CD1DB85BCC24BCFDB1A3F35D0D04F036A1A0A8FA97`였다. 이는 **당시 설치본의 식별값과 생존 응답 관찰**이며, 신뢰된 배포 서명·기대 해시와의 대조나 정상 다운로드·원본 일치·완료의 증명은 아니다. 조사 중 `/download`, `/cookie` 등 상태 변경 요청이나 실제 파일 다운로드는 실행하지 않았다.

## 3. 세 가지 선택지 비교

아래 평가는 앞 절의 실제 계약과 각 엔진의 공식 기능에 근거한 정성적 판단이다. “안정성 높음/낮음”이라는 점수나 성공률로 환산하지 않는다.

| 기준 | A. 기존 Hitomi Downloader API 보강 | B. 지원 대상을 한정한 자체 엔진 | C. 다른 외부 엔진 통합 |
| --- | --- | --- | --- |
| 사용자 실행 흐름 | 설치·실행·포트·외부 창에 의존하는 흐름을 유지 | Rosemary 안에서 큐·진행·오류·완료를 통합할 수 있음 | UI는 통합 가능하나 실행 파일 배포·프로세스 관리 필요 |
| 추출기 유지보수 | 외부 엔진에 위임. Rosemary는 원본 전달과 호환성 관리 | 대상 사이트의 페이지·API·세션·미디어 주소 변화까지 직접 담당 | 추출 엔진이 실제 지원하는 대상에 한해 위임 가능 |
| 완료 관찰 | 현재 계약은 약함. `/list` 매핑·버전·최종 파일 대조 보강 필요 | 상태·명세서·파일 검증을 처음부터 소유 가능 | 엔진 작업 ID·종료 코드·출력과 실제 파일을 대조해야 함 |
| 재시작·중복 방지 | 외부 큐와 로컬 DB를 대조하는 계약 필요 | 영속 큐·작업 소유권·복구를 직접 구현 | 외부 작업 ID와 Rosemary 논리 작업 ID를 연결해야 함 |
| 장애 격리 | 외부 프로세스 장애와 앱 장애를 구분해야 함 | 메인 프로세스에 큰 작업을 몰면 UI/IPC에 영향 가능. 별도 작업 프로세스 검토 | 외부 프로세스 감시·버전별 호환성 필요 |
| 초기 변경 범위 | 상대적으로 작지만 원본·완료 계약 수정은 필요 | 가장 큼. 전송 외에 큐·패키징·복구·운영 포함 | 엔진·배포 환경에 따라 달라지며 사전 검증 필요 |
| 성능 판단 | 현재 파일 전송 속도를 조사하지 않음 | 인앱 구현만으로 더 빠르다고 할 근거 없음 | 엔진 기능만으로 이 환경의 우위를 판단할 수 없음 |
| 현재 권고 | 먼저 보강 | 조건을 좁힌 PoC만 제안 | 후보 적합성부터 확인 |

**A의 최소 보강안 — 제안:** 공급자와 원본 URL/토큰을 보존하고, 외부 엔진이 인식한 공급자·대상과 대조한다. `sent`를 “전송됨”으로 명시하고 `completed`와 분리한다. API/엔진 버전 확인, 설치 자산의 기대 해시 검증, 외부 작업 ID 또는 안정적 대조 키, 최종 산출물 확인을 추가한다. `/list`를 쓴다면 호환성 테스트와 스키마 검증이 필요하다. API 확장을 수정해야 하는 항목과 Rosemary 단독으로 가능한 표시·기록 개선을 분리해야 한다. [현재 요청][r-api-request], [목록][u-list], [작업 추가][u-download]

**C의 구체적 한계 — upstream 확인:** aria2는 HTTP(S) 파일 전송, 재개, JSON-RPC 작업 ID, 세션 저장 등을 제공한다. 하지만 공식 문서는 URL을 입력받는 전송 도구의 계약이며 이 프로젝트 대상 사이트의 작품·이미지 추출기를 제공한다는 근거가 아니다. 명세서와 세션을 Rosemary가 해결한 뒤 전송 계층만 위임하는 후보로 볼 수 있다. RPC 인증 토큰, 세션 저장 주기와 복구 정책도 명시적으로 설정해야 한다. [aria2 공식 매뉴얼][a-manual]

gallery-dl은 일반적인 이미지 갤러리 엔진 후보지만, 확인한 `175d21fd8f7e52963911c02916d0634461cddb24`의 공식 지원 목록 전체에는 `E-Hentai`, `ExHentai`, `Hitomi`가 없었다. 작성자의 공식 Discussion #9304도 해당 추출 파일에 대한 삭제 요구를 설명한다. **과거 지원 이력이나 비공식 플러그인을 근거로 현재 Rosemary의 즉시 교체재라고 추천하지 않는다.** 이는 현재 공개 목록에 대한 관찰이며 모든 별도 배포본의 기능을 단정한 것은 아니다. [고정 지원 목록][g-sites], [작성자 공지][g-discussion]

## 4. 자체 엔진에서 분리해야 할 책임

### 4.1 원본 식별과 사이트별 추출

**제안 구조:** `사용자 요청 → 원본 식별 → 이미지 명세서 → 파일 전송 → 압축 → 검증 → 최종 공개 → 완료 기록`을 하나의 작업으로 관리한다. 각 단계의 성공이 다음 단계의 전제여야 하며, HTTP 200이나 ZIP 생성만으로 전체 완료를 표시하지 않는다.

현재 보유한 메타데이터를 바이너리 다운로드 명세서로 재해석하지 않는다. 명세서에는 공급자, 원본 작품 ID/URL, 작품 버전, 이미지 순서, 예상 개수, 미디어 URL 및 요청 조건 참조, 알려진 크기·검증값, URL 유효성 관련 정보를 별도로 담는 설계가 필요하다. 인증 쿠키·비밀 헤더·서명 URL 등 민감정보는 일반 명세서나 로그에 복제하지 않고 세션 또는 보호된 자격증명 참조로 분리한다. 현재 메타데이터 테이블에는 이미지별 목록이 없다는 관찰에 따른 제안이다. [현재 스키마][r-metadata]

사이트별 어댑터를 평가할 때는 아래를 **검증 과제**로 둔다. 이번 조사에서 대상 사이트가 모두 이러한 문제를 일으킨다고 관찰한 것은 아니다.

- 목록 페이지와 실제 원본 파일 주소의 관계, 페이지 순서·누락·중복, 변경된 작품의 식별
- CDN 호스트·주소 형식 변경, 만료된 주소의 재발급, 리디렉션 뒤 최종 목적지
- 쿠키·로그인·프록시·Referer 등 요청 조건과 인증 만료
- 접근 제한·요청량 제한·삭제·권한 부족을 서로 다른 오류로 분류하는 방법

통신 경로도 별도 검증해야 한다. 현재 텍스트 요청은 Electron 세션의 프록시 설정을 확인하고, 직접 연결 경로에서는 지정된 E-Hentai 대상과 API 호스트만 허용한 TLS 프록시를 사용한다. 이를 새로운 이미지/CDN 호스트까지 자동 적용할 수 있다고 가정하지 않는다. Electron의 `net.fetch`는 Chromium 네트워크 스택을 쓰며 Node의 `fetch`와 다르고, 기본 세션 외 요청에는 해당 `Session`의 API를 사용하도록 문서화되어 있다. **제안:** 선택한 전송 계층별로 쿠키·인증·시스템 프록시·리디렉션·CDN 연결을 실제 앱 런타임에서 검증하고, 세션이나 프록시가 자동 공유된다고 간주하지 않는다. 재시작 후 필요한 세션 보존 방식도 따로 정한다. 현재 `rosemary-crawler-transport`에는 `persist:` 접두사가 없어 메모리 세션이다. [현재 통신 선택][r-text], [TLS 프록시][r-tls], [Electron net][e-net], [세션 보존 계약][e-session]

**판단:** 외부 엔진이 담당하던 이러한 책임을 자체 엔진이 인수한다. 사이트의 임의 원격 JavaScript를 앱 권한으로 실행하거나 접근 제한을 우회하는 방식은 이 평가안에 포함하지 않는다. Electron은 신뢰하지 않는 원격 코드와 Node 권한을 결합하지 말 것을 명시한다. [Electron 보안 지침][e-security]

### 4.2 영속 큐, 재시작과 결과 불명

**제안:** 크롤링 실행 ID와 별도로 `(공급자, 원본 ID, 원본 버전, 산출물 프로필)`에 대응하는 논리 작업 키를 만든다. 시도 ID, 실행 중 작업 소유권, 단계별 체크포인트, 재시도 예정 시각, 마지막 확정 상태, 부분 파일 위치를 저장한다. 동일 작업의 동시 실행을 막고 재시작 시 DB·외부 큐·부분 파일·최종 파일을 대조한다. 현재 `(run_id, gallery_id)`만으로는 실행 간 중복이나 전송 후 기록 전 종료를 해결하지 못한다는 구조적 판단이다. [현재 DB][r-db], [현재 반영 순서][r-dispatch]

권고 상태는 `대기 / 원본 확인 / 다운로드 / 압축 / 검증 / 완료 / 재시도 대기 / 일시 중지 / 실패 / 취소 / 결과 불명`이다. 전송 중 제한시간이 지나도 외부 요청이 실행되지 않았다는 뜻은 아니다. HTTP 표준도 비멱등 요청의 자동 재시도에는 실행 여부나 멱등성에 대한 근거가 필요하다고 규정한다. 현재 POST에는 호출자가 제공하는 멱등 키와 반환 작업 ID가 없으므로, 대조 불가능한 경우 `결과 불명`을 보존하고 무조건 재전송하지 않는 계약이 필요하다. 외부 엔진 내부에서 별도로 중복을 막는지는 미검증이다. [HTTP 재시도 의미][h-retry], [API 처리][u-download]

### 4.3 전송, 부분 파일과 재개

Node 24의 `pipeline()`은 스트림의 backpressure와 관련 오류 처리를 지원한다. Electron `DownloadItem`도 진행·종료·재개 API를 제공하지만, 공식 문서상 재개 조건을 충족하지 않으면 처음부터 다시 받을 수 있다. 둘 모두 “갤러리의 모든 페이지를 올바르게 받았다”는 도메인 검증을 대신하지 않는다. [Node 24 스트림][n-stream], [Electron DownloadItem][e-download]

**제안:** 바이너리는 전체 `Buffer.concat` 대신 디스크로 스트리밍하고, 별도 staging 디렉터리의 `.part`에 쓴다. 작품 동시 수·호스트별 연결 수·응답 최대 크기·버퍼·디스크 사용량을 제한한다. 전송 취소와 압축 취소를 전파하고, 부분 파일을 일반 스캔·이동 대상으로 노출하지 않는다. 현재 텍스트 수집 모듈을 그대로 대용량 경로에 확장하지 않는다. 스트리밍을 써도 라이브러리 내부 버퍼나 무제한 병렬 작업의 메모리 사용까지 자동 제한되는 것은 아니므로 별도 한도를 검증해야 한다. [현재 텍스트 수집][r-text], [Node 스트림 버퍼·backpressure][n-stream]

HTTP 재개에는 동일 표현을 가리키는 검증자와 범위 응답 처리가 필요하다. `Range/If-Range`를 보냈더라도 서버는 전체 `200`을 줄 수 있고, 부분 응답은 `206/Content-Range`, 범위 실패는 `416`으로 구분해야 한다. 따라서 **제안 정책**은 `206`의 범위·검증자를 확인한 경우만 이어붙이고, `200`은 새 파일로 재시작하며, `416`은 길이·동일성 재검증 후 처리하는 것이다. CDN 주소를 새로 얻었어도 동일 파일임을 확인할 수 없다면 기존 바이트를 무조건 이어붙이지 않는다. 바이트 재개가 불가능하면 검증을 마친 이미지 단위의 재개를 대안으로 평가한다. [HTTP 조건부 범위·내용 범위][h-range]

### 4.4 압축과 안전한 최종 공개

ZIP 형식은 파일별 CRC32, 중앙 디렉터리와 ZIP64 확장 구조를 정의한다. 확장자만으로 무결성을 판단하지 않는 것이 형식 명세의 취지에도 맞는다. [PKWARE ZIP 명세][z-spec]

**제안 완료 조건:** 예상 이미지 수·순서·실제 파일 형식·다운로드 길이를 확인하고, 신뢰할 수 있는 원본 해시가 있으면 비교한다. ZIP 작성 후 다시 열어 엔트리·CRC·누락을 검증한다. CRC 검증만으로 원본 진위나 “모든 페이지가 포함됨”을 증명하지는 않으므로 원본 명세서 대조를 별도 조건으로 둔다. 예상 개수를 모르면 그 불확실성을 기록하고 임의로 완전성을 확정하지 않는다.

**제안 자원 정책:** 이미지·완성 ZIP·임시 ZIP이 동시에 존재할 수 있는 디스크 여유를 계산하고, 실제 쓰기 실패도 처리한다. 원본 이미지를 모두 메모리에 올리거나 압축률을 고정 가정하지 않는다. ZIP64, 큰 파일·많은 엔트리, 긴 경로·한글·중복 파일명, 읽기 전용 폴더, 디스크 부족, 백신/다른 앱의 파일 점유를 Windows 검증 항목으로 둔다. 압축 라이브러리와 BandiView·Rosemary 스캐너의 호환성은 아직 검증하지 않았다.

**제안 공개 계약:** 검증을 마친 staging 파일만 최종 위치에 공개한다. 대상 볼륨 안에서 원자적 이름 변경을 제공하는 방법을 검증하고, 최종 파일명 충돌은 덮어쓰지 않는 공개 방식 또는 기존 사용자 확인이 승인한 범위에 따라 처리한다. 단순 `rename`만으로 동시 충돌에 대한 덮어쓰기 방지를 보장한다고 가정하지 않으며, 존재 확인 뒤 공개 전 다른 작업이 같은 이름을 만드는 경합도 검증한다. 파일시스템의 공개와 DB 완료 기록 사이에도 종료가 가능하므로 시작 시 복구·대조가 필요하다. 전원 장애까지의 내구성은 별도 검증 대상이다. 기존 `file-transfer.ts`의 배타 복사와 `EXDEV` 임시 복사 패턴은 참고할 수 있지만 새 다운로드의 안전한 공개를 자동 보장하지 않는다. Node 문서도 `copyFile`의 원자성을 보장하지 않으며 기본 복사는 덮어쓴다. 다른 볼륨에는 최종 이름으로 직접 복사하지 않고 대상 볼륨의 임시 파일을 거쳐 검증·공개하는 설계를 평가한다. [기존 파일 전송][r-file], [Node 24 파일 API][n-fs]

## 5. 보안과 운영 유지보수

현재 Rosemary의 IPC는 등록된 `WebContents`, 메인 프레임과 앱 진입 URL을 확인한다. 이 경계를 유지하고, 렌더러에는 `작업 시작/중지/재시도/상태 조회` 같은 전용 API만 노출하는 것이 적절하다. Electron 역시 발신자 검증과 신뢰하지 않는 콘텐츠에 일반 IPC를 노출하지 말 것을 권고한다. [현재 IPC 경계][r-ipc], [Electron 지침][e-security]

**자체 엔진 제안:** renderer가 임의 URL·임의 저장 경로·임의 요청 헤더나 shell 명령을 실행시키는 범용 다운로드 IPC를 만들지 않는다. main에서 입력·저장 경로·호스트·리디렉션·프로토콜·응답 크기를 검증하고, 쿠키·토큰을 renderer 이벤트나 로그에 싣지 않는다. 공급자 어댑터가 허용한 HTTPS 대상만 요청하며 loopback·사설망·파일 URL 등으로의 리디렉션을 별도 차단한다. 이 문서는 기존 코드에 SSRF가 재현되었다고 주장하는 것이 아니라 신규 기능의 권한 확대에 필요한 경계를 제안한다.

공개 main의 고정 `api.py`는 loopback 바인딩을 쓰지만 확인한 요청 처리에는 인증 토큰 검사나 호출자 식별이 없고 wildcard CORS 헤더를 보낸다. **설치된 `0.1.0` 자산에는 그 CORS 헤더가 없으므로 둘을 혼동하지 않는다.** 설치본의 요청 라우팅에서도 인증 검사는 확인하지 못했다. loopback은 네트워크 노출을 줄이는 설정이지 호출자 인증은 아니다. 악용 경로의 실제 재현은 수행하지 않았다. **제안:** API 확장을 관리한다면 인증·입력/본문 제한·명시적 허용 범위와 버전 응답을 검토하고, 포트 변경만을 보안 대책으로 간주하지 않는다. [main의 요청 처리][u-routing], [main의 헤더·바인딩][u-boundary]

운영 책임도 선택 기준에 포함한다. **제안:** 어댑터·엔진 버전을 작업 기록에 남기고, 오류를 네트워크/원본 해석/인증/전송/압축/디스크/결과 불명으로 분리한다. 비밀정보를 제외한 재현 가능한 진단을 남기고, 사이트 변경에 따른 지원 중단 표시·업데이트·롤백을 제공한다. 엔진 전환은 신규 작업이나 확정적으로 취소된 작업 경계에서 수행하며, 결과 불명 작업을 다른 엔진에 자동 제출하지 않는다.

API 확장 저장소의 `LICENSE`는 GPLv3 문서다. 이를 복사·수정·함께 배포할 경우 해당 코드와 실제 배포 구성에 적용되는 의무를 별도 검토해야 한다. API 확장의 라이선스를 외부 다운로더 전체나 모든 플러그인의 라이선스로 일반화하지 않는다. 다른 엔진도 채택 버전·의존성·실행 파일 출처·배포 방식별 확인이 필요하다. 이번 조사는 법적 적합성 판정이 아니다. [API 확장 LICENSE][u-license]

## 6. 장애별 판단과 필요한 처리

아래의 “가능성”은 빈도를 측정한 등급이 아니다. 관찰된 구조 또는 검증해야 할 조건을 적었으며, 실제 발생률은 미측정이다.

| 트리거·조건 | 현재 근거/가능성 | 사용자 영향 | 요구되는 처리·검증 |
| --- | --- | --- | --- |
| 숫자 ID가 원래 공급자를 보존하지 못함 | 현재 숫자만 전달함. 외부 엔진 해석 미검증 [r-dispatch][r-dispatch], [u-download][u-download] | 다른 작품 요청 가능성. 영향 큼 | 원본 공급자·URL·엔진 인식 대상 대조를 첫 번째 도입 조건으로 설정 |
| 외부 큐 추가 후 응답 유실·5초 초과 | 현재 계약에 작업 ID/멱등 키 없음 [r-api-request][r-api-request], [u-download][u-download] | 실패로 보이지만 실행 중일 수 있음. 재전송 시 중복 위험 | 결과 불명으로 구분하고 외부 큐 대조 후 재시도 |
| 일부 전송 후 앱 종료, DB 반영 전 종료 | 외부 호출 뒤 결과 일괄 반영 [r-dispatch][r-dispatch] | 로컬 이력과 실제 큐 불일치 | 항목별 의도/결과 기록·재시작 대조·장애 주입 |
| 외부 엔진 종료·업데이트 | 버전·UI 직렬화에 의존하는 상태 조회 [u-list][u-list] | 진행/완료 관측 단절 | 엔진 버전 계약과 상태 어댑터, 작업 재발견 |
| CDN 주소 만료·로그인 만료·429·접근 거부 | 대상별 실측 없음. 조사 필요 | 진행 정지 또는 잘못된 반복 요청 | 주소 갱신·인증 필요·속도 제한·영구 실패를 구분하고 제한된 재시도 |
| HTTP 200이지만 HTML/잘린 파일 | 바이너리 검증 미실시. PoC 검증 과제 | 읽을 수 없는 파일이 완료로 노출될 위험 | 파일 형식·길이·디코딩/아카이브 검증 후 완료 |
| 디스크 부족·파일 점유·출력 충돌 | Windows 실측 없음. 파일 API 실패·비원자 복사 고려 [n-fs][n-fs] | 부분 파일, 기존 파일 손상 위험 | staging, 쓰기 오류 처리, 덮어쓰기 확인, 마지막 공개 경로 검증 |
| 일부 페이지 누락 또는 압축 중 종료 | 현재 API는 산출물 확인 없음 [r-send][r-send] | 불완전 ZIP이 스캔·보관될 위험 | 명세서·ZIP 대조, 완성 전 일반 스캔 격리 |
| 재개 시 원본이 변경됨 | HTTP 범위 재개는 조건 검증 필요 [h-range][h-range] | 서로 다른 버전의 바이트 결합 위험 | 검증자·범위 확인, 불확실하면 해당 파일부터 새로 받기 |

## 7. 구현 전 합의와 최소 평가 PoC

**아직 구현하지 않는다.** 우선 아래 계약을 확정해야 기술 비교가 같은 결과를 비교하게 된다.

- 지원 공급자와 허용된 접근 방식, 숫자 코드/URL의 의미, 작품 버전·이동·삭제 처리
- 원본/리사이즈 이미지 선택, 페이지 완전성 기준, 파일명·메타데이터·ZIP 호환성
- 완료 저장 위치와 기존 스캔·중복 확인·이동/보관 흐름의 연결
- 일시 중지·취소·재시도·부분 파일 보관·디스크 상한과 확인이 필요한 덮어쓰기 정책

**제안 PoC 범위:** 사용 권한이 있는 하나의 공급자·한 종류의 갤러리·ZIP 산출물로 제한한다. 비교 후보 A와 B가 동일 작품·이미지 품질·저장 장치·프록시 조건에서 같은 최종 산출물을 만들도록 한다. 외부 엔진 C는 공식 지원·배포 가능성을 먼저 확인한 후보만 포함한다. 사이트 접근 제한을 우회하거나 임의 원격 스크립트를 실행하는 방법은 포함하지 않는다.

| 통과 조건 | 검증할 실제 결과 | 사용 가능한 검증 방법 |
| --- | --- | --- |
| 원본 동일성 | 사용자 선택 작품과 엔진이 해석한 공급자·작품·페이지가 일치 | 읽기 전용 원본/엔진 응답 대조 후, 후속 PoC의 정상 다운로드에서 파일 확인 |
| 주 실행 흐름 | Rosemary의 실제 시작 버튼 → 큐 → 진행 → 검증 완료 → 스캔·보관 가능 | Playwright Electron 등 자동화와 실제 main/preload/renderer 경로 사용. computer-use는 사용하지 않음 |
| 완료의 진실성 | 화면·DB의 완료가 실제 읽을 수 있는 최종 ZIP과 대응 | 최종 경로 readback, 전체 엔트리 검사·예상 페이지 대조 |
| 재시작 복구 | 정상 종료·강제 종료 뒤 중복 작업/완료 오판 없이 복구 | 앱·작업 프로세스 종료 시점을 달리하는 자동 검증, DB·파일·외부 큐 대조 |
| 중복·결과 불명 | 동시 요청·응답 유실에서 확정되지 않은 작업을 중복 제출하지 않음 | 통제된 테스트 서버로 계약 검증 후 실제 엔진 대조 |
| 전송·압축 실패 | 연결 끊김·범위 미지원·내용 변경·잘린 응답·디스크 부족에서 완성 파일로 공개하지 않음 | 로컬 서버/파일시스템 장애 시험과 실제 산출물 검증 |
| Windows 파일 호환성 | 한글·긴 경로·중복 이름·파일 점유·큰 ZIP을 기존 앱 흐름에서 처리 | 독립 임시 폴더에서 실행하고 BandiView/스캔·보관 결과 확인 |
| 성능·자원 | 대기/추출/전송/압축/검증 시간을 분리하고 UI 응답·최대 메모리·디스크 사용을 측정 | 같은 조건의 반복 측정. 성공한 작업만의 속도 대신 실패·재시도도 함께 기록 |

테스트 서버·고정 데이터는 장애 재현을 보조하지만 실제 공급자와 정상 사용자 진입 흐름의 확인을 대체하지 않는다. 통과 임계값은 사용자가 받아들일 수 있는 응답성·메모리·디스크 예산과 현재 엔진의 측정 기준을 얻은 뒤 정한다. 이번 조사에서 성공률·속도 개선율·정확한 개발 기간은 산출하지 않았다.

## 8. 남은 확인과 조사 한계

- **기존 계약 테스트:** `crawler-download-dispatch`, `hitomi-api-script`, `crawler-request-policy`, `downloader-startup`의 기존 Node 테스트 17개가 호스트 Node 25.2.1과 Electron 44.5.1 내장 Node 24.21.0에서 각각 통과했다. 확인 범위는 전송 기록·포트 변환·재시도 정책·실행 wrapper다. 실제 미디어 전송·원본 동일성·외부 큐 완료·장애 복구나 아직 없는 자체 엔진의 품질을 검증한 결과가 아니다. 이번 조사에서는 제품 코드나 테스트를 추가하지 않았다.
- **저장소 기본 검증:** `pnpm check`, `pnpm typecheck`가 종료 코드 0으로 통과했다. `check`의 기존 optional-chain 경고 4개는 이번 문서 작업에서 변경하지 않았다. 정적 검사 통과를 실제 다운로드 검증으로 해석하지 않는다.
- **원본 매핑:** 숫자 코드의 외부 엔진 해석과 E-Hentai 원본 대응은 미확인이다. 먼저 읽기 전용 대조 및 엔진 계약 확인이 필요하다.
- **외부 본체 소스:** `KurtBestor/Hitomi-Downloader`의 GitHub URL은 조사 도구에서 HTTP 451로 열리지 않았다. 따라서 현재 본체의 추출·중복 방지·재개·ZIP 검증 내부 동작을 확인했다고 주장하지 않는다. 별도 경로로 제한을 우회하지 않았다. [확인 대상][u-engine]
- **공개 소스와 설치 자산:** main의 고정 `api.py`, `0.1.0` 릴리스, 로컬 포트 패치 설치본은 각각 구분했다. 이번 조사는 릴리스 자산을 새로 내려받아 소스와 동등성을 증명하지 않았다.
- **실제 전송:** 실제 미디어·ZIP 생성·복구·부하 비교를 수행하지 않았다. 로컬 `/ping` 응답과 소스 검토는 전송 성공의 대체 증거가 아니다.
- **대안 지원:** gallery-dl의 현재 공개 지원 목록은 확인했으나 비공식 플러그인·과거 버전·별도 배포본은 평가하지 않았다. aria2는 전송 후보일 뿐 대상 사이트 추출 가능성은 확인하지 않았다.
- **버전 범위:** Node API는 앱에 포함된 Node 24.21.0 문서를 기준으로 읽었다. Electron의 온라인 문서는 변경될 수 있으므로 구현 시 설치된 Electron 44.5.1에 대한 API·타입·실행 확인이 필요하다.
- **릴리스 영향:** 연구 문서만 추가했으므로 앱 버전과 제품 코드는 변경하지 않는다. 성능·안정성 우위는 PoC에서 관찰한 뒤 판단한다.

## 출처

저장소 링크는 조사 기준 커밋에 고정했다. 외부 소스도 가능한 경우 고정 커밋을 사용했다. Wiki·공식 온라인 문서·릴리스 메타데이터는 2026-10-27 조회 기준이다.

[r-send]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/hitomi-api.ts#L436-L540
[r-api-request]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/hitomi-api.ts#L18-L148
[r-api-install]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/hitomi-api.ts#L22-L23
[r-api-script]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/hitomi-api-script.ts
[r-crawler-api]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler.ts#L85
[r-crawler-link]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler.ts#L2623-L2653
[r-dispatch]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler.ts#L2667-L2718
[r-retry]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler.ts#L487-L499
[r-crawl-finish]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler.ts#L1311-L1318
[r-db-recovery]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler-database.ts#L535-L552
[r-discovery-dedup]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler.ts#L1540-L1563
[r-db]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler-database.ts#L134-L147
[r-dispatch-result]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler-download-dispatch.ts#L1-L104
[r-metadata]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler-database.ts#L100-L132
[r-text]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler-text-request.ts#L1-L159
[r-tls]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/crawler-tls-proxy.ts
[r-file]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/file-transfer.ts
[r-ipc]: https://github.com/rlatmfrl24/rosemary-app/blob/aa0adbc2b42056fdb3abe081c098564018559c1e/src/main/ipc-security.ts#L1-L45
[u-docs]: https://github.com/Hitomi-Downloader-extension/api/wiki/Docs
[u-version]: https://github.com/Hitomi-Downloader-extension/api/blob/11714e4166d803ea8186c333bb155b62cf4fd9b0/api.py#L1-L15
[u-download]: https://github.com/Hitomi-Downloader-extension/api/blob/11714e4166d803ea8186c333bb155b62cf4fd9b0/api.py#L149-L177
[u-list]: https://github.com/Hitomi-Downloader-extension/api/blob/11714e4166d803ea8186c333bb155b62cf4fd9b0/api.py#L117-L132
[u-routing]: https://github.com/Hitomi-Downloader-extension/api/blob/11714e4166d803ea8186c333bb155b62cf4fd9b0/api.py#L82-L103
[u-boundary]: https://github.com/Hitomi-Downloader-extension/api/blob/11714e4166d803ea8186c333bb155b62cf4fd9b0/api.py#L277-L304
[u-release]: https://github.com/Hitomi-Downloader-extension/api/releases/tag/0.1.0
[u-license]: https://github.com/Hitomi-Downloader-extension/api/blob/11714e4166d803ea8186c333bb155b62cf4fd9b0/LICENSE
[u-engine]: https://github.com/KurtBestor/Hitomi-Downloader
[n-stream]: https://nodejs.org/download/release/v24.21.0/docs/api/stream.html
[n-fs]: https://nodejs.org/download/release/v24.21.0/docs/api/fs.html
[e-download]: https://www.electronjs.org/docs/latest/api/download-item/
[e-security]: https://www.electronjs.org/docs/latest/tutorial/security
[e-net]: https://www.electronjs.org/docs/latest/api/net
[e-session]: https://www.electronjs.org/docs/latest/api/session
[h-retry]: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2
[h-range]: https://www.rfc-editor.org/rfc/rfc9110.html#section-14
[a-manual]: https://aria2.github.io/manual/en/html/aria2c.html
[g-sites]: https://github.com/mikf/gallery-dl/blob/175d21fd8f7e52963911c02916d0634461cddb24/docs/supportedsites.md
[g-discussion]: https://github.com/mikf/gallery-dl/discussions/9304
[z-spec]: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
