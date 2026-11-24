# ndhmd-agent

ndhmd 웹 작업대에서 **PDF 컴파일**을 하게 해 주는 로컬 에이전트입니다. 웹 페이지가 보낸 `.tex`와 그림을 임시 폴더에서 `latexmk`로 컴파일하고, PDF와 `.synctex.gz`를 돌려줍니다. 그 밖의 일은 하지 않습니다.

필요한 것: Node.js 18 이상, TeX Live 또는 MiKTeX(`latexmk`와 쓸 엔진이 PATH에 있어야 함). 설치할 패키지는 없습니다.

## 시작

```
node ndhmd-agent.mjs --app ../dist/index.html
```

시작하면 이렇게 나옵니다.

```
  주소      http://127.0.0.1:47321/
  연결 코드 xxxxxxxxxxxxxxxxxxxxxxxx
  바로 열기 http://127.0.0.1:47321/#token=xxxxxxxx...
```

- **`--app` 방식(권장)**: "바로 열기" 주소를 브라우저에서 열면 주소와 연결 코드가 자동으로 채워집니다. 페이지와 에이전트의 출처가 같아서 따로 허용할 것이 없습니다.
- **다른 곳에서 연 페이지(예: GitHub Pages)**: 에이전트를 `--origin https://그-주소`로 시작하고, 페이지의 설정 ▸ 로컬 에이전트에 주소와 연결 코드를 직접 넣습니다. 허용하지 않은 출처의 페이지는 거절됩니다.

연결 코드는 처음 한 번 만들어 `~/.ndhmd-agent/token`에 저장하므로 다시 시작해도 같습니다.

## 옵션

| 옵션 | 설명 |
|---|---|
| `--port N` | 포트(기본 47321). 주소는 항상 127.0.0.1 |
| `--app 파일` | 이 `index.html`을 에이전트가 내줌 |
| `--origin URL` | 허용할 페이지 출처(여러 번 가능) |
| `--work 폴더` | 임시 작업 폴더. 한글이 없는 경로 권장 |
| `--timeout 초` | 컴파일 제한 시간(기본 300) |
| `--shell-escape off\|restricted\|on` | 기본 `restricted`(TeX Live 기본값). shell escape가 필요할 때 `on`으로 켭니다 |
| `--keep N` | 남겨 둘 최근 작업 수(기본 3) |
| `--max-mb N` | 요청 크기 상한(기본 100) |
| `--token 값` | 연결 코드를 직접 지정 |

## 안전장치

- 127.0.0.1에서만 듣고, `Host`가 우리 주소가 아니면 거절합니다(DNS 재결합 방지).
- `Origin`이 있는 요청은 허용 목록에 있어야 합니다.
- 연결 코드(Bearer 토큰)가 없으면 `/hello`의 기본 정보 외에는 아무것도 하지 않습니다.
- 실행하는 명령은 `latexmk` 하나뿐이고, 인자는 에이전트가 엔진(xelatex·lualatex·pdflatex)에서 직접 만듭니다. 요청이 보낸 인자는 받지 않습니다.
- 파일 경로는 상대 경로만, `..`·절대 경로·역슬래시·제어문자는 거절합니다. 확장자는 `.tex .png .jpg .jpeg .gif .bmp .svg .pdf .eps .webp`와 보조 파일 `.sty .cls .lbx .bst .bib .def .cfg .clo .fd`만 허용합니다(리소스의 .sty 등은 원고가 이름을 언급한 것만 작업 폴더 최상위로 보냅니다).
- 한 번에 컴파일 하나만 합니다(진행 중이면 409). 연결이 끊기거나 시간이 지나면 자식 프로세스를 통째로 끝냅니다.
- shell-escape는 에이전트를 시작할 때만 정합니다. 웹 페이지는 켤 수 없습니다.

## 인터페이스

- `GET /hello` — 코드 없이는 `{needsToken:true}`만. 코드가 있으면 latexmk 버전, 엔진 유무, shell-escape 모드.
- `POST /compile` — 본문 `{version:1, engine, texFile, files:[{path,b64}], ...}`. 응답은 줄마다 JSON인 스트림입니다: `start`, `log`(컴파일러 출력 조각), `done`(성공 여부, 오류 목록, PDF 크기 등).
- `GET /job/<id>/pdf | synctex | log` — 결과 파일. 최근 `--keep`개만 남습니다.

`latexmk`는 `-pdfxe`/`-pdflua`/`-pdf`, `-interaction=nonstopmode`, `-synctex=1`, `-file-line-error`로 실행합니다. 사용자의 `.latexmkrc`는 그대로 읽습니다.
