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

## 동작 방식

- 로컬 Node 서버가 미소 백오피스 API를 중계(proxy)합니다. (브라우저 CORS 문제 회피)
  - 주문 목록: `https://rfq.getmiso.com/backoffice/requests`
  - 결제 내역: `https://api.getmiso.com/v3/backoffice/payment-transactions`
- 미소 API에는 날짜 필터가 없어, **최근 N일(기본 45일) 접수 주문**을 최신순으로 스캔합니다.
  (`LOOKBACK_DAYS` 환경변수로 조정. 접수→결제 지연을 감안한 여유 기간)
- 결제가 존재할 수 있는 상태(`confirming`, `complete`)만 결제 내역을 조회해 부하를 줄입니다.
- 결제 일시는 주문별로 메모리 캐싱하여 새로고침 부하를 최소화합니다.

## 로컬 PC를 API 서버로 (Render 없이)

**본인 PC만** 쓸 때 가장 간단한 방법입니다.

### 방법 1 — 전부 로컬 (권장)

```bash
npm start
```

브라우저에서 **http://localhost:4000** 접속. API·화면 모두 이 PC에서 동작합니다.

### 방법 2 — Firebase Hosting 화면 + 이 PC API

1. 터미널에서 `npm start` 유지 (포트 4000)
2. https://mvc-contract-cdb96.web.app 접속
3. **설정** → **API 서버**에 `http://localhost:4000` 입력 (또는 「이 PC」 버튼) → **적용**

> HTTPS Hosting 페이지에서 HTTP localhost 호출은 브라우저/OS에 따라 차단될 수 있습니다.  
> 막히면 **방법 1**을 쓰거나, `cloudflared tunnel --url http://localhost:4000` 으로 HTTPS 터널 URL을 API 서버에 넣으세요.

### 제약

| 항목 | 내용 |
|------|------|
| PC 켜짐 | `npm start` 실행 중이어야 데이터 조회 가능 |
| 다른 사람 | 같은 Wi‑Fi/터널 없으면 이 PC API에 접근 불가 |
| Firestore | 한 PC가 조회·publish하면 다른 브라우저는 **구독만** 가능 |

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
| 화면 (Firebase Hosting) | https://mvc-contract-cdb96.web.app ✅ |
| API (Render) | https://miso-contract-api.onrender.com — **최초 1회 배포 필요** |

### API 서버 최초 배포 (관리자 1회, 약 5분)

1. 이 프로젝트를 **GitHub**에 push
2. [Render](https://dashboard.render.com) → **New +** → **Blueprint** (또는 Web Service)
3. GitHub 저장소 연결 → `render.yaml` 자동 적용
4. 서비스 이름 **`miso-contract-api`** 유지 (Hosting과 URL이 맞춰져 있음)
5. 배포 완료 후 https://miso-contract-api.onrender.com/api/health → `{"ok":true,...}` 확인

이후 팀원은 **https://mvc-contract-cdb96.web.app** 만 공유하면 됩니다.

> Render 무료 플랜: 15분 미사용 시 sleep → 첫 접속 30초~1분 걸릴 수 있습니다.

## Firebase 설정

프로젝트: **`mvc-contract`**

대시보드 갱신 시 지표가 **Firestore** `dashboard/{serviceId}` 문서에 저장되고,
다른 브라우저/탭에서 실시간으로 반영됩니다.

### 사전 준비

1. [Firebase Console](https://console.firebase.google.com/) → `mvc-contract` → **Firestore Database** 생성 (테스트 모드 또는 프로덕션)
2. CLI 로그인: `firebase login`

### Rules 배포

```bash
firebase deploy --only firestore:rules
```

개발용 `firestore.rules`는 `dashboard/{serviceId}` 읽기/쓰기를 허용합니다. 운영 환경에서는 인증 규칙으로 제한하세요.

### 웹 앱 설정

`firebase-sync.js`에 Console에서 받은 config가 반영되어 있습니다.
Miso API 인증 정보는 Firebase에 저장하지 않습니다.

### Hosting 배포 (프론트)

사이트: **`mvc-contract-cdb96`** · public 폴더: `public/`

```bash
npm run deploy:hosting
```

배포 URL: `https://mvc-contract-cdb96.web.app`

Hosting은 **정적 파일(HTML/JS)** 만 제공합니다. Miso API 프록시(`/api/*`)는 **별도 API 서버**가 필요합니다.

### API 서버 배포 (Render)

Firebase Spark(무료)에서도 동작합니다. 프론트는 Firebase Hosting, API는 Render에 분리 배포합니다.

```
[브라우저] → Firebase Hosting (index.html)
                ↓ fetch
            Render API (server.js) → Miso 백오피스 API
```

#### 1. GitHub에 코드 push

저장소 루트에 `render.yaml`이 포함되어 있어야 합니다.

#### 2. Render에서 Web Service 생성

1. [Render](https://render.com) → **New +** → **Web Service**
2. GitHub 저장소 연결
3. 설정 (Blueprint 미사용 시):
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`
4. **Environment Variables:**
   - `API_ONLY` = `1`
   - (선택) `MISO_USER`, `MISO_PASS` — 대시보드 입력 없이 API만 쓸 때
5. 배포 후 URL 확인 (예: `https://miso-contract-api.onrender.com`)

> Render 무료 플랜은 15분 미사용 시 sleep → 첫 요청이 30초~1분 걸릴 수 있습니다.

#### 3. Firebase Hosting (이미 연결됨)

Hosting 빌드 시 API URL이 자동 주입됩니다 (`https://miso-contract-api.onrender.com`).

서비스 이름을 바꿨다면:

```bash
DASHBOARD_API_BASE=https://YOUR-SERVICE.onrender.com npm run deploy:hosting
```

### Firestore 동기화

대시보드 갱신 시 지표가 Firestore `dashboard/{serviceId}`에 저장되어 다른 탭/브라우저와 공유됩니다. Miso 인증 정보는 Firebase에 저장하지 않습니다.

## 참고

- 전환율은 cohort 기준(해당 기간 접수 건이 결제로 이어진 비율)입니다.
- `LOOKBACK_DAYS`(기본 45) 보다 오래 전에 접수된 건이 최근 결제되면 일부 누락될 수 있습니다.
  접수→결제 지연이 길다면 값을 늘리세요. (`LOOKBACK_DAYS=60 node server.js`)
