# 실시간 계약 대시보드 (미소방문이사)

미소방문이사(서비스 ID 586)의 **접수(lead-in)** 와 **계약(contract)** 지표를 집계하는 대시보드입니다.

- **접수(lead-in)** = 주문 생성일(`created_at`) 기준. **`unqualified` 상태는 제외**
- **계약(contract)** = 결제 일시(성공한 결제의 최신 `timestamp`) 기준. **`unqualified` 상태는 제외**
- 모든 날짜는 Asia/Seoul 기준

## 지표

| 지표 | 정의 |
|------|------|
| 오늘 계약 (Today Contract) | 결제 일시가 **오늘**인 건수 |
| 어제 접수 (Yesterday Lead-in) | 생성일이 **어제**인 건수 (`unqualified` 제외) |
| 어제 접수 대비 전환율 | **오늘 계약 ÷ 어제 접수 × 100** (소수점 2자리) |
| 7일 계약 (7d Contract) | 결제 일시가 **최근 7일(오늘 포함)**인 건수 |
| 7일 접수 (7d Lead-in) | 생성일이 **최근 7일**인 건수 |
| 7일 전환율 | **7일 계약 ÷ 7일 접수 × 100** (소수점 2자리) |
| 주간 계약 (Weekly) | 결제 일시가 **이번 주(월~일)**인 건수 |
| 주간 접수 (Weekly Lead-in) | 생성일이 **이번 주(월~일)**인 건수 |
| 주간 전환율 | **주간 계약 ÷ 주간 접수 × 100** (소수점 2자리) |

> 전환율은 "해당 기간 계약수 ÷ 해당 기간 접수수"(flow) 입니다.
> (단, 어제 전환율의 분자는 정의상 *오늘* 계약수를 사용합니다.)

## 동작 방식 (SPA + IndexedDB)

브라우저(SPA)가 미소 API를 직접 호출하고, 계산·저장을 모두 클라이언트에서 처리합니다.
별도 백엔드 DB나 서버 계산이 없습니다.

```
[브라우저 · Firebase Hosting의 index.html (SPA)]
   ├─ 로그인 / 주문 목록 → rfq.getmiso.com           (직접 호출, CORS 허용)
   ├─ 결제 내역         → Render 프록시 → api.getmiso.com  (CORS 우회용 프록시)
   ├─ 지표 계산          → metrics.js · miso-sheets.js (클라이언트)
   └─ 저장              → IndexedDB (브라우저 로컬 캐시, 10분 TTL)
```

- `api.getmiso.com`(결제)만 CORS가 막혀 있어 **Render의 결제 전용 프록시**(`proxy-server.js`)를 경유합니다.
  로그인·주문목록(`rfq.getmiso.com`)은 브라우저가 직접 호출합니다.
- 미소 API에는 날짜 필터가 없어, **최근 N일(기본 45일) 접수 주문**을 최신순으로 스캔합니다.
  (`miso-api.js`의 `LOOKBACK_DAYS`. 접수→결제 지연을 감안한 여유 기간)
- 결제가 존재할 수 있는 상태(`confirming`, `complete`)만 결제 내역을 조회해 부하를 줄입니다.
- 조회한 주문·결제는 **IndexedDB**에 저장(10분 TTL)하여 새로고침/탭 재방문 시 즉시 표시하고 재조회 부하를 줄입니다.
- **저장은 브라우저별 로컬**입니다. Firestore 같은 서버 DB를 쓰지 않으므로 다른 사람/기기와 데이터가 공유되지 않고, 각자 로그인해 각자 조회·캐싱합니다.

## 로컬에서 실행 (배포 없이)

```bash
npm start            # server.js — SPA 화면 + 결제 프록시를 한 포트에서 제공
```

브라우저에서 **http://localhost:4000** 접속.
로그인·주문 목록은 `rfq.getmiso.com`을 직접 호출하고, 결제 내역은 이 **로컬 서버가 프록시**합니다. (Render 불필요)

> 배포본(https://mvc-contract-cdb96.web.app)은 결제 프록시로 **Render**를 사용하므로, 로컬 서버가 꺼져 있어도 정상 동작합니다.
> `npm start`(`server.js`)는 로컬 개발 편의용 올인원 서버이고, Render에는 결제 프록시 전용 `proxy-server.js`가 배포됩니다.

### 제약

| 항목 | 내용 |
|------|------|
| 데이터 저장 | 브라우저별 **IndexedDB** 로컬 캐시 — 기기/브라우저 간 공유되지 않음 |
| 결제 프록시 | 배포본은 **Render**, 로컬은 `npm start`가 담당 (결제 API CORS 우회용) |
| 공유 | 팀원은 각자 **https://mvc-contract-cdb96.web.app** 에서 본인 계정으로 로그인 |

## 실행

```bash
node server.js
# 또는
npm start
```

기본 포트는 `4000` 입니다. (`PORT=5000 node server.js` 로 변경 가능)

브라우저에서 `http://localhost:4000` 접속.

## 로그인

`rfq-admin.miso.kr` 백오피스 **아이디/비밀번호**로 로그인합니다.
대시보드 상단에 아이디/비밀번호를 입력하면 서버가 자동으로 로그인(`POST /backoffice/login`)하여
토큰(`access_token`)을 발급받아 사용합니다. 토큰은 **서버 메모리에만** 보관되며, 만료(401) 시 자동 재로그인합니다.

- 입력한 계정 정보는 입력한 브라우저(localStorage)에만 저장되고, 로컬 서버를 거쳐 미소 로그인 API로만 전송됩니다.
- 계정을 환경변수로 고정해 입력 없이 쓰려면:
  ```bash
  MISO_USER=아이디 MISO_PASS=비밀번호 node server.js
  ```
- (선택) 토큰을 직접 쓰려면 요청 헤더 `x-miso-token` 으로 전달할 수도 있습니다.

## 화면

- **KPI 카드**: 오늘 계약(어제 같은 시간 대비 증감 포함), 어제 접수, 어제 전환율, 7일 전환율 — 고정 지표
- **시간대별 계약 비교**: 0~23시 계약 건수 비교 (시간대별 막대 / 누적 라인 토글)
  - **기준일 / 비교일** 날짜 선택으로 임의의 두 날짜를 비교할 수 있습니다. (`오늘·어제` 버튼으로 초기화)
- **기간 전환율 도넛**: 아래에서 선택한 기간의 계약 / 접수 전환율
- **기간별 계약·접수 막대 차트**: 일자별
  - **시작일 ~ 종료일** 직접 선택 또는 `최근 7일 / 이번 주 / 이번 달 / 최근 30일` 프리셋
  - 선택 기간의 계약·접수·전환율 요약과 도넛이 함께 갱신됩니다.
- **오늘 계약된 주문 표**: 주문 ID 클릭 시 백오피스 상세로 이동
- **데이터 시트 (클릭 drill-down)**: KPI·차트·표 카드를 클릭하면 하단 패널에 원본 데이터 표시
  - 정렬(컬럼 헤더), 검색, CSV 내보내기
  - 전환율·기간 차트는 **분자/분모 탭** 또는 **일자/시간 요약·상세 탭**
  - 시간대별·기간별 차트 **막대 클릭** → 해당 시간/일자 상세 주문 목록
- 우측 상단 **설정**: 계정·서비스 ID·자동 새로고침(1분/5분/수동) 변경, 강제 재조회
- 시각화는 Chart.js(CDN)를 사용합니다.

> 기간을 과거로 넓게 잡으면 그만큼 스캔 범위가 늘어나 갱신이 느려질 수 있습니다.
> (스캔 시작일은 선택 기간 + 접수→결제 지연 버퍼 `PAYMENT_LAG_DAYS`(기본 21일)를 포함하도록 자동 확장됩니다.)

## 팀 공유 URL

**대시보드:** https://mvc-contract-cdb96.web.app

아이디/비밀번호 입력 후 바로 사용합니다. 별도 설치·로컬 서버 불필요.

| 구성 | URL / 상태 |
|------|------------|
| 화면 (Firebase Hosting · **정적 호스팅 전용**) | https://mvc-contract-cdb96.web.app ✅ |
| 결제 프록시 (Render) | https://miso-contract-api.onrender.com — **최초 1회 배포 필요** |

> Firebase는 **정적 파일 호스팅 용도로만** 사용합니다. Firestore(DB)·Functions는 쓰지 않습니다.
> 데이터 저장은 각 브라우저의 **IndexedDB**, 결제 API의 CORS 우회는 **Render 프록시**가 담당합니다.

### 결제 프록시 최초 배포 (관리자 1회, 약 5분)

1. 이 프로젝트를 **GitHub**에 push
2. [Render](https://dashboard.render.com) → **New +** → **Blueprint** (또는 Web Service)
3. GitHub 저장소 연결 → `render.yaml` 자동 적용 (`startCommand: node proxy-server.js`)
4. 서비스 이름 **`miso-contract-api`** 유지 (프론트의 프록시 URL과 맞춰져 있음 — `miso-api.js`)
5. 배포 완료 후 https://miso-contract-api.onrender.com/api/health → `{"ok":true,"role":"payment-proxy",...}` 확인

이후 팀원은 **https://mvc-contract-cdb96.web.app** 만 공유하면 됩니다.

> Render 무료 플랜: 15분 미사용 시 sleep → 첫 결제 조회가 30초~1분 걸릴 수 있습니다.
> 프록시 URL을 바꾸려면 `miso-api.js`의 `PAYMENT_PROXY` 상수를 수정하세요.

## Firebase 설정 (Hosting 전용)

사이트: **`mvc-contract-cdb96`** · public 폴더: `public/`

Firebase는 **정적 파일(HTML/JS)을 호스팅하는 용도로만** 씁니다.
Firestore·Functions·서버 계산은 사용하지 않습니다.

### Hosting 배포 (프론트)

```bash
firebase login          # 최초 1회
npm run deploy:hosting   # build:hosting → public/ 생성 후 hosting 배포
```

배포 URL: `https://mvc-contract-cdb96.web.app`

- `build:hosting`이 SPA 정적 파일을 `public/`로 복사한 뒤 Firebase Hosting에 올립니다.
- Miso API 인증 정보는 어디에도 저장하지 않습니다. (로그인 입력값은 입력한 브라우저 `localStorage`에만 보관)
- 결제 API CORS 우회는 별도의 **Render 프록시**가 담당합니다. (위 "결제 프록시 최초 배포" 참고)

## 참고

- 전환율은 cohort 기준(해당 기간 접수 건이 결제로 이어진 비율)입니다.
- `LOOKBACK_DAYS`(기본 45) 보다 오래 전에 접수된 건이 최근 결제되면 일부 누락될 수 있습니다.
  접수→결제 지연이 길다면 값을 늘리세요. (`LOOKBACK_DAYS=60 node server.js`)
