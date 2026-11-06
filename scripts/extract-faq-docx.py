#!/usr/bin/env python3
"""대표님 확정 FAQ 원본(docx) → src/data/faq.json 추출 (재추출용 일회성 스크립트).

원본: VanaM_GEO_FAQ_Master_EN_KO_20261106.docx
  sha256 65ee4cbd45f72d12106d8e52f03398e8d3069fd9d07a06c18b09d9a7a4f2b7c2
  38개 항목 — E01~E06, F01~F10, Q01~Q10, M01~M08, T01~T04. 항목마다 영문·국문 질문과 답 한 쌍.

추출 규칙 (python-docx, 문단을 위에서부터 차례로 읽는다):
  · 스타일 "FAQ Meta" 이면서 ^[EFQMT]\\d\\d\\s*\\| 로 시작 → 새 항목 시작, id 는 앞 3글자
  · 스타일 "Heading 2" 이면서 "EN" 으로 시작 → en_q = text[2:].strip()
  · 스타일 "Heading 3" 이면서 "KO" 로 시작 → ko_q = text[2:].strip()
  · 스타일 "FAQ English" → en_a = text.strip()
  · 스타일 "FAQ Korean"  → ko_a = text.strip()
  결과 [{"id","en_q","en_a","ko_q","ko_a"}] (순서·키 순서 그대로)를
  json.dumps(ensure_ascii=False, separators=(",",":")) 한 UTF-8 의 sha256 은
  4a6f3d308acd0e780044862a218eb43b8b4372f800924efbd4e788cd08a6a5ce 여야 한다.
  원본 sha256 · 추출 sha256 · 항목 수 · id 순서 중 하나라도 다르면 아무것도 쓰지 않고 실패한다.

게시하는 것은 질문과 답뿐이다. 항목 머리줄(상태·태그), "기존 질문 원문", "내부 출처표시", 검수메모, 표지·원칙·부록은 추출하지 않는다.
문구는 확정본이다 — 추출한 글자를 한 글자도 고치지 않는다(오탈자로 보여도, 사이트 표기와 달라도).

사용 (저장소 밖 가상환경에서 — 저장소에 python-docx 를 설치하지 않는다):
  python3 -m venv /tmp/faq-venv && /tmp/faq-venv/bin/pip install python-docx
  /tmp/faq-venv/bin/python scripts/extract-faq-docx.py <원본.docx>            # 검사만
  /tmp/faq-venv/bin/python scripts/extract-faq-docx.py <원본.docx> --write    # src/data/faq.json 기록

src/data/faq.json 의 항목 필드: id · en{q,a} · ko{q,a} (원본 그대로) · page(답이 있는 페이지) · group(분류) · anchor("faq-" + id 소문자)
배치(page)는 아래 PAGE 표가, 관련 질문 링크(답 없이 질문만 링크로 보여주는 소재 페이지)는 RELATED 표가 정한다.
분류 이름과 화면 순서는 src/lib/faq.ts.
"""
import hashlib
import json
import os
import re
import sys

SOURCE_SHA256 = '65ee4cbd45f72d12106d8e52f03398e8d3069fd9d07a06c18b09d9a7a4f2b7c2'
EXTRACT_SHA256 = '4a6f3d308acd0e780044862a218eb43b8b4372f800924efbd4e788cd08a6a5ce'
ID_ORDER = ([f'E{i:02d}' for i in range(1, 7)] + [f'F{i:02d}' for i in range(1, 11)] + [f'Q{i:02d}' for i in range(1, 11)]
            + [f'M{i:02d}' for i in range(1, 9)] + [f'T{i:02d}' for i in range(1, 5)])

# 답이 있는 페이지 — 각 질문의 답은 사이트에서 이 한 곳에만 있다. (언어 접두사 없는 경로)
PAGE = {}
for _i in ID_ORDER:
    if _i[0] in 'EF':
        PAGE[_i] = '/contact/'
    elif _i[0] == 'Q':
        PAGE[_i] = '/technology/'
PAGE.update({'T01': '/product/', 'T02': '/technology/', 'T03': '/product/', 'T04': '/technology/'})
PAGE.update({'M01': '/materials/', 'M02': '/materials/', 'M06': '/materials/', 'M07': '/materials/', 'M08': '/materials/'})
PAGE.update({'M03': '/materials/m01/', 'M04': '/materials/m01/', 'M05': '/materials/m11/'})

# 관련 질문 링크 — 이 소재 페이지 끝에 질문 문구만 링크로 나열한다(답은 PAGE 의 한 곳에만 있다). 나열 순서 그대로.
RELATED = {
    '/materials/m44/': ['Q01', 'Q02', 'Q03', 'Q04'],  # NbTiN
    '/materials/m04/': ['Q07', 'Q05', 'Q06'],         # Ta₂O₅
    '/materials/m52/': ['Q08'],                       # SrTiO₃
    '/materials/m51/': ['Q08'],                       # BaTiO₃
}

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'data', 'faq.json')


def extract(path):
    from docx import Document  # python-docx
    items, cur = [], None
    for p in Document(path).paragraphs:
        style, text = p.style.name, p.text
        if style == 'FAQ Meta' and re.match(r'^[EFQMT]\d\d\s*\|', text):
            cur = {'id': text[:3]}
            items.append(cur)
        elif cur is None:
            continue
        elif style == 'Heading 2' and text.startswith('EN'):
            cur['en_q'] = text[2:].strip()
        elif style == 'Heading 3' and text.startswith('KO'):
            cur['ko_q'] = text[2:].strip()
        elif style == 'FAQ English':
            cur['en_a'] = text.strip()
        elif style == 'FAQ Korean':
            cur['ko_a'] = text.strip()
    # 키 순서를 규칙대로 고정
    return [{k: it.get(k) for k in ('id', 'en_q', 'en_a', 'ko_q', 'ko_a')} for it in items]


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    src, write = argv[1], '--write' in argv[2:]
    errors = []
    with open(src, 'rb') as f:
        src_sha = hashlib.sha256(f.read()).hexdigest()
    if src_sha != SOURCE_SHA256:
        errors.append(f'원본 sha256 다름: {src_sha}')
    items = extract(src)
    ids = [it['id'] for it in items]
    if len(items) != 38:
        errors.append(f'항목 수 {len(items)} (38 이어야 함)')
    if ids != ID_ORDER:
        errors.append(f'id 순서 다름: {ids}')
    for it in items:
        for k in ('en_q', 'en_a', 'ko_q', 'ko_a'):
            if not it.get(k):
                errors.append(f'{it["id"]}.{k} 비어 있음')
    ext_sha = hashlib.sha256(json.dumps(items, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
    if ext_sha != EXTRACT_SHA256:
        errors.append(f'추출 sha256 다름: {ext_sha}')
    print(f'원본 sha256  {src_sha}')
    print(f'추출 sha256  {ext_sha}')
    print(f'항목 {len(items)}개: {" ".join(ids)}')
    if errors:
        print('FAIL — 아무것도 쓰지 않았다:')
        for e in errors:
            print('  - ' + e)
        return 1
    if write:
        data = {
            'source': {'file': os.path.basename(src), 'sha256': src_sha, 'extractSha256': ext_sha},
            'items': [{
                'id': it['id'],
                'en': {'q': it['en_q'], 'a': it['en_a']},
                'ko': {'q': it['ko_q'], 'a': it['ko_a']},
                'page': PAGE[it['id']],
                'group': it['id'][0],
                'anchor': 'faq-' + it['id'].lower(),
            } for it in items],
            'related': RELATED,
        }
        with open(OUT, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'기록: {os.path.normpath(OUT)}')
    else:
        print('OK (검사만 — 기록하려면 --write)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
