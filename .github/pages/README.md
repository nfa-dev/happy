# `pages` 브랜치 — 웹 빌드를 GitHub Pages 로

[slopus/happy](https://github.com/slopus/happy) 의 `packages/happy-app` 을 Expo web 으로 export 해서
<https://nfa-dev.github.io/happy/> 에 올린다. upstream 이 아직 머지하지 않은 **웹 스크롤 수정 두 건**을
얹은 빌드를 쓰려는 것이 목적이고, 그 외에는 upstream 그대로다.

## 왜

웹(데스크톱 브라우저)에서만 채팅 히스토리를 사실상 볼 수 없었다. 네이티브 앱은 셋 다 멀쩡하다.

| 증상 | 원인 | upstream |
|---|---|---|
| 휠 방향이 반대 — 위로 굴리면 최신 쪽으로 간다 | `inverted` 가 콘텐츠 래퍼와 셀에만 `scaleY(-1)` 을 걸고 스크롤 노드에는 안 걸어서, 브라우저 기본 휠이 뒤집힌 축으로 `scrollTop` 을 움직인다 | [slopus/happy#1768](https://github.com/slopus/happy/issues/1768), 수정 PR [#1767](https://github.com/slopus/happy/pull/1767) 미머지 |
| 위로 올리면 일정 지점부터 빈 화면 | FlashList 가 `firstItemOffset` 을 `getBoundingClientRect()` 로 재는데 이 값은 transform 을 반영한다. 뒤집힌 컨테이너 안에서 스크롤할수록 값이 커져(정지 8 → 735, 1200 스크롤 뒤 3135) 내부 오프셋이 음수로 떨어지고 가상화 창이 멎는다 | [Shopify/flash-list#2380](https://github.com/Shopify/flash-list/issues/2380), 수정 PR [#2468](https://github.com/Shopify/flash-list/pull/2468) 미머지 |
| PgUp/PgDn·방향키·스페이스도 반대 | 휠과 같은 원인. 브라우저가 변환되지 않은 스크롤 노드를 움직인다 | [slopus/happy#1416](https://github.com/slopus/happy/issues/1416), 드래프트 PR [#1518](https://github.com/slopus/happy/pull/1518) 미머지 |

## 구성

이 브랜치는 upstream `main` 위에 커밋 몇 개뿐이다. rebase 를 쉽게 두려고 일부러 작게 유지한다.

1. `fix(app): correct inverted chat scroll wheel direction on web` — PR #1767 을 `git am` 으로 얹은
   것(원저자 Federico Liva 표기 유지).
2. `fix(app): correct inverted chat keyboard scroll direction on web` — 드래프트 PR #1518 의 포팅.
   키 매핑과 테스트는 그 PR 그대로, 배선만 지금 리스트에 맞췄다(#1518 은 FlatList 시절 ChatList 를
   전제로 쓰여서 ref 이름과 effect 의존성이 다르다). 키 입력에서도 `userTookOverRef` 를 세우는 것
   하나를 더했다 — 지금 리스트는 히스토리 페이징을 그 플래그로 막아둬서, 안 세우면 키보드만 쓰는
   사람은 첫 페이지 끝에서 대화가 끊긴다.
3. 이 디렉토리와 `.github/workflows/pages.yml`.

FlashList 수정은 `node_modules` 를 고치는 것이라 소스 커밋이 안 된다. 그래서
`patches/0002-flash-list-web-inverted-measurement.patch` 로 두고 워크플로가 `pnpm install`
**뒤에** 얹는다. PR #2468 의 `getLayoutOffsets`(transform 을 타지 않는 `offsetTop` 체인으로 측정)를
flash-list 2.3.1 의 컴파일된 dist 로 포팅한 것 — upstream PR 은 TS 소스를 고치는데 배포 패키지에는
JS 만 실려 있다. pnpm isolated 레이아웃이라 실경로는 심링크를 `readlink -f` 로 푼다.

패치 적용은 세 갈래다. 대상 파일이 없으면 즉시 죽고, 마커(`getLayoutOffsets`)가 이미 있으면
"이미 반영됨"을 찍고 건너뛰며, 그 외에는 `--fuzz=0` 으로 붙인 뒤 마커를 다시 확인한다. 조용히 안 붙은
채 배포되는 것이 제일 위험해서 실패는 전부 빌드 중단으로 보낸다.

## GitHub Pages 쪽 함정

- **`404.html`** — Pages 에는 SPA rewrite 가 없다. `index.html` 을 복사해두지 않으면
  `/happy/session/<id>` 같은 딥링크가 죽는다. 상태코드는 404 로 남지만 같은 번들이 부팅해
  라우터가 URL 을 읽는다.
- **`experiments.baseUrl`** — 프로젝트 페이지는 `/happy` 아래서 서빙되므로 자산 경로에 그 prefix 가
  베이크돼야 한다. 워크플로가 `app.config.js` 에 주입한다(소스에 커밋하지 않는 이유: 브랜치 diff 를
  작게 유지해 rebase 를 쉽게 하려고).
- **`.nojekyll`** — Actions 아티팩트로 배포하면 Jekyll 이 돌지 않아 지금 구성에선 없어도 된다.
  나중에 브랜치 배포로 바꿀 때 `_expo/` 가 통째로 사라지는 것을 막으려고 같이 넣어둔다.

## 서버 URL

앱의 우선순위는 `MMKV 사용자 override > __HAPPY_CONFIG__ > EXPO_PUBLIC_HAPPY_SERVER_URL(베이크) >
기본값 api.cluster-fluster.com` 이다. 이 빌드는 **아무것도 베이크하지 않는다** — 공개 페이지에
사내 호스트명을 남기지 않으려는 것이고, 각자 앱 안 `/server` 화면에서 자기 서버를 넣으면 된다
(MMKV 에 저장되어 로그아웃해도 유지). 베이크가 필요하면 workflow_dispatch 의 `server_url` 입력을 쓴다.

## 운영

- **재배포**: Actions → "Deploy web to Pages" → Run workflow. `pages` 브랜치에 push 해도 돈다.
- **업스트림 따라가기**: `git fetch upstream && git rebase upstream/main` → push (force). 패치가 안
  붙으면 빌드가 죽으니 조용히 어긋날 일은 없다.
- **무엇이 떠 있는지**: <https://nfa-dev.github.io/happy/build-info.json> 에 커밋 SHA, 빌드 시각,
  적용된 로컬 패치 목록이 있다.
- **제거 조건**: #1767·#1518 이 머지되면 rebase 할 때 커밋이 자연히 사라진다. flash-list 가 고쳐
  릴리스하고 upstream 이 그 버전으로 올리면 패치 단계가 "이미 반영됨"을 찍는다 — 그때 `patches/`
  에서 지운다.

## upstream PR 에서 더 나간 부분

처음에는 두 PR 을 그대로 따랐는데, 그 상태로는 세 가지가 남아서 뒤에 따로 손봤다. upstream 이
머지하면 이 부분만 충돌하므로 커밋을 분리해뒀다.

- **Shift+Space** 로 한 화면 위. #1518 은 수정키가 눌린 이벤트를 통째로 넘겨서 이것도 반대로
  남아 있었다. 이제 Shift 는 Space 에서만 의미를 갖고, 나머지 키에서는 선택 제스처로 보고 넘긴다.
- **Home/End**. 목록이 뒤집혀 있어 DOM 기준 끝이 가장 오래된 메시지다. End 는 최신(offset 0),
  Home 은 가장 오래된 쪽으로 보낸다. `scrollTop` 이 대입할 때 클램프되는 성질을 쓰되 값은 반드시
  유한해야 한다 — CSSOM 이 비유한값을 0 으로 정규화해서 `Infinity` 를 쓰면 Home 이 정반대로 간다.
- **Ctrl+휠·트랙패드 핀치 확대/축소**. #1767 의 세로 휠 분기가 `ctrlKey` 를 배제하지 않아 채팅
  위에서 브라우저 확대/축소가 막혔다. 줌 제스처는 브라우저에 그대로 둔다.

## 빌드 파이프라인이 막아주는 것

워크플로는 배포 전에 세 가지를 확인한다. 패치는 `--fuzz=0` + 적용 후 마커 재확인, 번들되는 소스
전체 `tsc --noEmit`, 그리고 키 매핑 유닛 테스트. Metro 는 타입을 확인하지 않고 지우기만 하고
upstream 의 typecheck 워크플로는 main 대상 PR 에서만 돌기 때문에, rebase 로 무언가 어긋나면
여기서 걸린다. typecheck 범위를 소스로 좁힌 이유는 이 워크플로가 happy-app 서브그래프만
설치해서 spec 파일이 참조하는 다른 워크스페이스의 `@types/*` 가 없기 때문이다.
