# `pages` 브랜치

[slopus/happy](https://github.com/slopus/happy) 포크의 작업 브랜치다. upstream `main` 위에 우리 커밋을
얹고, 웹 앱과 CLI·agent, self-host 서버를 모두 이 브랜치에서 빌드한다.

| 산출물 | 패키지 | 배포 |
|---|---|---|
| 웹 앱 | `packages/happy-app` | 이 저장소의 Actions 가 Expo web 으로 export 해서 <https://nfa-dev.github.io/happy/> 에 올린다 |
| CLI·agent | `packages/happy-cli`, `packages/happy-agent` | `<upstream 버전>-navercorp` 로 Nexus npm 저장소에 게시한다 |
| 서버 | `packages/happy-server` | self-host relay 이미지가 이 브랜치의 커밋을 받아 빌드한다 |

CLI 와 agent 의 변경은 2026-10 까지 별도 포크의 버전 브랜치에 있었고, 2026-10-23 기능별 커밋으로 옮겨
와 이 브랜치 하나로 합쳤다. 공개 저장소이므로 사내 호스트명이나 내부 프로젝트명은 소스와 커밋에
남기지 않는다. 게시 대상 Nexus 주소도 환경변수로만 받는다.

## 웹 키보드 수정을 얹은 이유

웹(데스크톱 브라우저)에서만 채팅 히스토리를 사실상 볼 수 없었다. 네이티브 앱은 셋 다 멀쩡하다.
휠 방향과 FlashList 측정은 2026-09 에 upstream 이 둘 다 직접 고쳐서 여기서는 빠졌고, 남은 것은
키보드 스크롤이다.

| 증상 | 원인 | upstream |
|---|---|---|
| 휠 방향이 반대 — 위로 굴리면 최신 쪽으로 간다 | `inverted` 가 콘텐츠 래퍼와 셀에만 `scaleY(-1)` 을 걸고 스크롤 노드에는 안 걸어서, 브라우저 기본 휠이 뒤집힌 축으로 `scrollTop` 을 움직인다 | **머지됨** — upstream 이 `sources/utils/invertedChatWheel.ts` 로 직접 구현([#1767](https://github.com/slopus/happy/pull/1767) 을 따르되 deltaMode·`composedPath` 자식 양보·Shift+휠까지 더했다) |
| 위로 올리면 일정 지점부터 빈 화면 | FlashList 가 `firstItemOffset` 을 `getBoundingClientRect()` 로 재는데 이 값은 transform 을 반영한다. 뒤집힌 컨테이너 안에서 스크롤할수록 값이 커져(정지 8 → 735, 1200 스크롤 뒤 3135) 내부 오프셋이 음수로 떨어지고 가상화 창이 멎는다 | **해결됨** — flash-list 는 아직 미머지([#2380](https://github.com/Shopify/flash-list/issues/2380))지만 upstream 이 `scripts/postinstall.cjs` 에서 `node_modules` 를 고친다 |
| PgUp/PgDn·방향키·스페이스도 반대 | 휠과 같은 원인. 브라우저가 변환되지 않은 스크롤 노드를 움직인다 | [slopus/happy#1416](https://github.com/slopus/happy/issues/1416), 드래프트 PR [#1518](https://github.com/slopus/happy/pull/1518) 미머지 — 휠을 고치면서도 키보드는 그대로 두었다 |

## 구성

rebase 를 쉽게 두려고 기능 하나에 커밋 하나만 둔다. upstream 이 같은 수정을 받아들이면 그 커밋은
rebase 때 빠진다.

### 웹 앱

1. `fix(app): correct inverted chat keyboard scroll direction on web` — 드래프트 PR #1518 의 포팅.
   키 매핑과 테스트는 그 PR 그대로, 배선만 지금 리스트에 맞췄다(#1518 은 FlatList 시절 ChatList 를
   전제로 쓰여서 ref 이름과 effect 의존성이 다르다). 뒤이은 두 커밋이 Shift+Space·Home/End 를
   마저 채우고, 읽고 있는 화면만 키를 가져가게 했다.
2. `feat(app): offer Opus 5.5 and make it the Claude default` — 모델 피커에 Opus 5.5 두 행을
   더하고 기본 모델을 거기로 옮긴다. upstream 은 Fable 5.1 까지만 올려두었다.
3. upstream 휠 수정의 effect 의존성에 `props.active` 하나를 더한 것. upstream 은
   `handoffListRevision` 과 `props.sessionId` 만 본다.
4. 웹의 "Connect your computer" 화면에 로그아웃을 두고, 폰 브라우저에서 앱 하단이 잘리던 것을
   `100dvh` 로 고친 두 커밋. 둘 다 upstream 에 같은 버그가 있다.
5. 이 디렉토리와 `.github/workflows/pages.yml`.

### CLI·agent

| 커밋 | 내용 |
|---|---|
| `chore(cli): stamp the fork version and publish to Nexus` | 버전을 `<upstream>-navercorp` 로 찍고 `scripts/publish-nexus.mjs` 로 게시한다 |
| `feat(cli): --auto-resume daemon flag …` | 데몬이 스스로 재기동될 때(pod 등) 영속 세션을 자동으로 되살린다 |
| `fix(cli): route turn-end through the outgoing queue …` | turn-end 가 그 턴의 마지막 메시지를 앞지르던 버그. upstream 에 낼 몫이다 |
| `feat(cli): switch between several Claude logins automatically` | `happy accounts`, 사용량에 따른 계정 전환, Fable 주간 한도 |
| `feat(cli): show the build revision in --version and doctor` | `dist/build-info.json` 의 커밋으로 같은 버전의 빌드를 구분한다 |
| ``feat(cli): `happy auth server` …`` | 서버·웹앱 URL 을 `settings.json` 에 저장한다 |
| `feat(cli): carry /loop wakeups and session cron jobs …` | query 를 다시 띄울 때 사라지던 /loop·세션 cron 을 되살린다 |
| `feat(agent): secret-key restore, a library entry and spawn options` | `auth restore`, `happy-agent/lib`, spawn 옵션 전달 |

### 서버

`feat(server): relay blob transfers through the server in S3 mode` 하나다. upstream 은 S3 를 쓰면
첨부와 아바타를 presigned POST·GET 으로 버킷에 직접 주고받게 한다. NCP Object Storage 는 POST policy
업로드에 405 를 돌려주고 내부 endpoint 는 http 라서, https 웹 앱에서는 이미지 첨부가 전부 실패했다.
이 커밋은 S3 모드에서도 바이트를 서버가 받아 저장하고 내려준다. `S3_DIRECT_TRANSFERS=true` 를 주면
upstream 동작으로 돌아간다.

FlashList 수정은 `node_modules` 를 고치는 것이라 소스 커밋이 안 된다. 한동안 이 디렉토리에
`patches/0002-...` 로 두고 워크플로가 `pnpm install` 뒤에 얹었는데, upstream 이 같은 버그를
`scripts/postinstall.cjs` → `patches/fix-flash-list-web-inversion.cjs` 로 직접 고치면서 치웠다.
그쪽은 `pnpm install` 이 알아서 돌리고 자체 테스트도 있다(`patches/fix-flash-list-web-inversion.test.cjs`).
구현이 다르다 — 우리 것은 PR #2468 의 `offsetTop` 체인이고 upstream 은 뒤집힌 축을 반대 모서리에서
재는 방식인데, 둘을 겹치면 우리 early return 이 upstream 교정을 죽은 코드로 만든다.

그래서 워크플로는 붙이는 대신 **확인만** 한다. 설치 뒤 `measureLayout.web.js` 에 upstream 의 마커
(`DOMMatrixReadOnly`)가 있는지 보고 없으면 빌드를 죽인다. 서브그래프 필터 설치(`--filter
"{packages/happy-app}..."`)에서도 루트 postinstall 은 돌지만, 조용히 빠진 채 배포되면 위로 올릴 때
빈 화면이 되기 때문이다.

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
  CLI·서버만 바뀐 push 도 웹을 다시 배포하지만 결과물은 같다.
- **업스트림 따라가기**: `git fetch upstream && git rebase upstream/main` → push (force). 패치가 안
  붙으면 빌드가 죽으니 조용히 어긋날 일은 없다.
- **CLI·agent 게시**: 각 패키지에서 `NEXUS_BASE_URL=<Nexus 주소> pnpm run publish:nexus`. 배포 계정은
  `NEXUS_NPM_AUTH` 나 `~/.npmrc` 의 `_auth` 줄로 준다. 같은 버전 번호로 다시 게시하므로 설치본이 어느
  빌드인지는 `dist/build-info.json` 의 커밋으로 본다. 이 브랜치는 upstream 의 릴리스 태그가 아니라
  `main` 을 따라가니, rebase 뒤 게시하기 전에 `git log cli-<마지막 릴리스>..upstream/main --
  packages/happy-cli` 로 아직 릴리스되지 않은 upstream CLI 변경이 딸려 오는지 확인한다.
- **서버**: relay 이미지는 이 브랜치의 커밋을 SHA 로 고정해서 받는다. 브랜치 이름으로 받으면 미러가
  rebase 전 커밋을 내줄 수 있다.
- **무엇이 떠 있는지**: <https://nfa-dev.github.io/happy/build-info.json> 에 커밋 SHA, 빌드 시각,
  적용된 로컬 패치 목록이 있다.
- **제거 조건**: #1518 이 머지되면 rebase 할 때 커밋이 자연히 사라진다(#1767 은 2026-09 에 그렇게
  빠졌다). Opus 5.5 는 upstream 이 피커에 넣는 날 사라진다. flash-list 확인 스텝은 upstream 이
  자기 패치를 지울 때 — 즉 flash-list 가 고쳐 릴리스할 때 — 같이 지운다. turn-end 수정도 upstream 이
  받으면 빠진다.

## upstream PR 에서 더 나간 부분

#1518 을 그대로 따른 상태로는 두 가지가 남아서 뒤에 따로 손봤다. upstream 이 머지하면 이 부분만
충돌하므로 커밋을 분리해뒀다.

- **Shift+Space** 로 한 화면 위. #1518 은 수정키가 눌린 이벤트를 통째로 넘겨서 이것도 반대로
  남아 있었다. 이제 Shift 는 Space 에서만 의미를 갖고, 나머지 키에서는 선택 제스처로 보고 넘긴다.
- **Home/End**. 목록이 뒤집혀 있어 DOM 기준 끝이 가장 오래된 메시지다. End 는 최신(offset 0),
  Home 은 가장 오래된 쪽으로 보낸다. `scrollTop` 이 대입할 때 클램프되는 성질을 쓰되 값은 반드시
  유한해야 한다 — CSSOM 이 비유한값을 0 으로 정규화해서 `Infinity` 를 쓰면 Home 이 정반대로 간다.

Ctrl+휠 줌 제외는 upstream 의 `handleInvertedChatWheel` 이 `event.ctrlKey` 로 처리해서 우리 커밋이
필요 없어졌다. 히스토리 페이징을 막던 `userTookOverRef` 플래그도 upstream 이 없앴다 — 이제 가장
오래된 렌더 메시지가 뷰포트에 가까워지면 채워지므로, 키보드 독자라고 따로 신호를 보낼 것이 없다.

## 빌드 파이프라인이 막아주는 것

워크플로는 배포 전에 세 가지를 확인한다. 패치는 `--fuzz=0` + 적용 후 마커 재확인, 번들되는 소스
전체 `tsc --noEmit`, 그리고 키 매핑 유닛 테스트. Metro 는 타입을 확인하지 않고 지우기만 하고
upstream 의 typecheck 워크플로는 main 대상 PR 에서만 돌기 때문에, rebase 로 무언가 어긋나면
여기서 걸린다. typecheck 범위를 소스로 좁힌 이유는 이 워크플로가 happy-app 서브그래프만
설치해서 spec 파일이 참조하는 다른 워크스페이스의 `@types/*` 가 없기 때문이다.
