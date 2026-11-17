#!/usr/bin/env python3
# scripts/emf-render.py — PPT 안의 EMF/WMF(OLE 미리보기 포함) 그래프를 원본 레코드에서 직접 렌더한다.
#
# 왜 있는가: 소재 그래프(Origin 등)는 PPT 안에 EMF(또는 EMF 를 품은 WMF)로 들어 있다. 화면 캡처나
#   PowerPoint "다른 이름으로 저장"을 거치지 않고, 원본 레코드를 해석해 PowerPoint 와 같은 모양으로 그린다.
#   지키는 것: 클립(INTERSECTCLIPRECT·EXCLUDECLIPRECT·EXTSELECTCLIPRGN·SELECTCLIPPATH), 월드 변환
#   (SET/MODIFYWORLDTRANSFORM), 매핑 모드(창·뷰포트), 펜 굵기(기하 펜은 논리 단위 → 변환 적용, 끝모양·연결),
#   글자(EXTTEXTOUTW 의 글자별 간격 Dx, 회전 lfEscapement, 정렬 SETTEXTALIGN, 실제 TrueType 글리프 윤곽).
#   해석하지 못한 레코드는 숨기지 않고 stderr 에 "경고:" 로 남긴다.
#
# 출력 범위: 헤더의 rclFrame(0.01 mm) 을 출력 W×H 에 맞춘다 — PowerPoint 가 그림·OLE 틀에 맞추는 방식.
#   PPT 크롭(srcRect)이 있으면 --crop l,r,t,b (비율) 로 같은 잘라내기를 적용한다.
# 배경: 투명 → 흰색으로 합성(--transparent 로 끌 수 있음).
#
# 의존: pymupdf, fonttools, numpy, pillow — 저장소 밖 venv 에 설치해 쓴다(전역 설치 금지).
#   python3 -m venv ~/vanam-data/ppt-1113/.venv && ~/vanam-data/ppt-1113/.venv/bin/pip install pymupdf fonttools numpy pillow
# 사용:
#   .venv/bin/python scripts/emf-render.py in.(emf|wmf) out.png --width 1142 --height 1055 [--svg out.svg] [--json info.json]
#   out 확장자가 .webp 이면 무손실 webp 로 저장한다.
import argparse, io, json, math, os, re, struct, sys

import numpy as np
import pymupdf
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image

WARN = []
def warn(msg):
    if msg not in WARN:
        WARN.append(msg)
        print('경고:', msg, file=sys.stderr)

# ───────────────────────── WMF → EMF ─────────────────────────
def emf_from_wmf(w):
    """WMF 의 META_ESCAPE(MFCOMMENT) 'WMFC' 조각을 이어 붙여 원래 EMF 를 돌려준다. 없으면 None."""
    if w[:4] == b'\xd7\xcd\xc6\x9a':
        w = w[22:]
    o = struct.unpack_from('<H', w, 2)[0] * 2
    parts, total = [], None
    while o + 6 <= len(w):
        sz = struct.unpack_from('<I', w, o)[0] * 2
        fn = struct.unpack_from('<H', w, o + 4)[0]
        if sz < 6:
            break
        if fn == 0x0626:
            esc = struct.unpack_from('<H', w, o + 6)[0]
            if esc == 0x000F and w[o + 10:o + 14] == b'WMFC':
                cur, rem, tot = struct.unpack_from('<III', w, o + 10 + 22)
                parts.append(w[o + 10 + 34:o + 10 + 34 + cur])
                total = tot
        if fn == 0:
            break
        o += sz
    emf = b''.join(parts)
    return emf if parts and len(emf) == total else None

def load_emf(path):
    b = open(path, 'rb').read()
    if b[40:44] == b' EMF':
        return b
    e = emf_from_wmf(b)
    if e is None:
        raise SystemExit(f'{path}: EMF 도 아니고, EMF 를 품은 WMF 도 아니다(순수 WMF 렌더는 지원하지 않음)')
    return e

# ───────────────────────── 행렬 (a b c d e f) : x' = a x + c y + e, y' = b x + d y + f ─────────────────────────
def mul(m, n):
    """m 다음에 n 을 적용하는 행렬 (n ∘ m)."""
    a, b, c, d, e, f = m
    A, B, C, D, E, F = n
    return (a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F)

def apply(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])

ID = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)

# ───────────────────────── 폰트 ─────────────────────────
FONT_DIRS = ['/System/Library/Fonts/Supplemental', '/System/Library/Fonts', '/Library/Fonts', os.path.expanduser('~/Library/Fonts')]
FACE_FILES = {
    'arial': ['Arial.ttf', 'Arial Bold.ttf', 'Arial Italic.ttf', 'Arial Bold Italic.ttf'],
    'times new roman': ['Times New Roman.ttf', 'Times New Roman Bold.ttf', 'Times New Roman Italic.ttf', 'Times New Roman Bold Italic.ttf'],
    'arial narrow': ['Arial Narrow.ttf', 'Arial Narrow Bold.ttf', 'Arial Narrow Italic.ttf', 'Arial Narrow Bold Italic.ttf'],
    'courier new': ['Courier New.ttf', 'Courier New Bold.ttf', 'Courier New Italic.ttf', 'Courier New Bold Italic.ttf'],
    'tahoma': ['Tahoma.ttf', 'Tahoma Bold.ttf', 'Tahoma.ttf', 'Tahoma Bold.ttf'],
    'verdana': ['Verdana.ttf', 'Verdana Bold.ttf', 'Verdana Italic.ttf', 'Verdana Bold Italic.ttf'],
}
FALLBACK = 'Arial Unicode.ttf'
# Symbol 글꼴(문자 집합 2) → 유니코드 그리스 문자
SYMBOL = {c: u for c, u in zip('ABGDEZHQIKLMNXOPRSTUFCYWabgdezhqiklmnxoprstufcyw',
                                 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρστυφχψω')}
SYMBOL.update({'°': '°', '±': '±', '´': '×', '¸': '÷', '£': '≤', '³': '≥', '¹': '≠', '»': '≈', '¥': '∞', 'j': 'φ', 'v': 'ϖ', 'J': 'ϑ', 'V': 'ς'})
_fcache = {}

def font_path(name):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return p
    return None

def get_font(face, weight, italic):
    key = (face.lower(), weight >= 600, bool(italic))
    if key in _fcache:
        return _fcache[key]
    files = FACE_FILES.get(key[0])
    if files is None:
        if key[0] not in ('symbol', 'system'):
            warn(f'글꼴 "{face}" 대응 파일 없음 → Arial 로 대체')
        files = FACE_FILES['arial']
    fn = files[(1 if key[1] else 0) + (2 if key[2] else 0)]
    p = font_path(fn) or font_path(files[0])
    f = TTFont(p, fontNumber=0)
    _fcache[key] = f
    return f

_fb = None
def fallback_font():
    global _fb
    if _fb is None:
        _fb = TTFont(font_path(FALLBACK))
    return _fb

# ───────────────────────── 렌더러 ─────────────────────────
STOCK = {0: ('brush', (255, 255, 255)), 1: ('brush', (192, 192, 192)), 2: ('brush', (128, 128, 128)), 3: ('brush', (64, 64, 64)),
         4: ('brush', (0, 0, 0)), 5: ('brush', None), 6: ('pen', dict(color=(255, 255, 255), width=0, style=0, cosmetic=True)),
         7: ('pen', dict(color=(0, 0, 0), width=0, style=0, cosmetic=True)), 8: ('pen', None),
         10: ('font', None), 11: ('font', None), 12: ('font', None), 13: ('font', None), 14: ('font', None), 15: ('palette', None),
         16: ('font', None), 17: ('font', None), 18: ('brush', (255, 255, 255)), 19: ('pen', dict(color=(0, 0, 0), width=0, style=0, cosmetic=True))}
DEFAULT_FONT = dict(height=-12, esc=0, weight=400, italic=0, face='Arial', charset=0)

def rgb(c):
    return '#%02x%02x%02x' % c

def colorref(d, o):
    return (d[o], d[o + 1], d[o + 2])


class Renderer:
    def __init__(self, emf, W, H, crop=(0, 0, 0, 0), hairline=None):
        self.emf, self.W, self.H = emf, W, H
        h = struct.unpack_from('<iiiiiiii', emf, 8)
        self.bounds, frame = h[:4], h[4:]
        dev = struct.unpack_from('<ii', emf, 72)
        mm = struct.unpack_from('<ii', emf, 80)
        hsize = struct.unpack_from('<I', emf, 4)[0]
        if hsize >= 108:
            um = struct.unpack_from('<ii', emf, 100)
            ppx, ppy = dev[0] / (um[0] / 1000.0), dev[1] / (um[1] / 1000.0)
        else:
            ppx, ppy = dev[0] / mm[0], dev[1] / mm[1]
        # rclFrame(0.01mm) → 장치 픽셀
        fx0, fy0 = frame[0] / 100.0 * ppx, frame[1] / 100.0 * ppy
        fx1, fy1 = (frame[2]) / 100.0 * ppx, (frame[3]) / 100.0 * ppy
        cl, cr, ct, cb = crop
        fw, fh = fx1 - fx0, fy1 - fy0
        fx0, fx1 = fx0 + fw * cl, fx1 - fw * cr
        fy0, fy1 = fy0 + fh * ct, fy1 - fh * cb
        self.frame_dev = (fx0, fy0, fx1, fy1)
        self.out = (W / (fx1 - fx0), 0.0, 0.0, H / (fy1 - fy0), -fx0 * W / (fx1 - fx0), -fy0 * H / (fy1 - fy0))
        self.objs = {}
        self.st = dict(world=ID, mapmode=1, worg=(0, 0), wext=(1, 1), vorg=(0, 0), vext=(1, 1),
                       clip=[], pen=STOCK[7][1], brush=(255, 255, 255), font=DEFAULT_FONT,
                       textcolor=(0, 0, 0), bkcolor=(255, 255, 255), bkmode=2, talign=0, polyfill=1, miter=10.0,
                       pos=(0, 0))
        self.stack = []
        self.items = []
        self.clipdefs = []
        # 머리카락 선(코스메틱 펜) 굵기: PowerPoint 100 %(96 dpi)에서 1 px 이 되는 출력 픽셀 수
        frame_mm_w = (frame[2] - frame[0]) / 100.0 * (1 - cl - cr)
        self.hairline = hairline if hairline else W / (frame_mm_w / 25.4 * 96)
        self.path = None   # BEGINPATH..ENDPATH 동안의 하위 경로 목록
        self.last_path = []
        self.info = dict(pens=[], clips=[], texts=[], records={})

    # 논리 → 출력 픽셀
    def page(self):
        s = self.st
        if s['mapmode'] == 1:   # MM_TEXT
            return (1.0, 0.0, 0.0, 1.0, s['vorg'][0] - s['worg'][0], s['vorg'][1] - s['worg'][1])
        sx = s['vext'][0] / s['wext'][0] if s['wext'][0] else 1.0
        sy = s['vext'][1] / s['wext'][1] if s['wext'][1] else 1.0
        if s['mapmode'] == 7:   # MM_ISOTROPIC
            k = min(abs(sx), abs(sy))
            sx, sy = math.copysign(k, sx), math.copysign(k, sy)
        elif s['mapmode'] not in (8,):
            # MM_LOMETRIC 등 고정 매핑: 0.1mm 등 → 장치 픽셀, y 위로
            per_mm = {2: 0.1, 3: 0.01, 4: 0.254, 5: 0.0254, 6: 25.4 / 1440}[s['mapmode']]
            ppx = (self.frame_dev[2] - self.frame_dev[0]) and None
            warn(f'매핑 모드 {s["mapmode"]} — 근사 처리')
            sx, sy = per_mm * 3.78, -per_mm * 3.78
        return (sx, 0.0, 0.0, sy, s['vorg'][0] - s['worg'][0] * sx, s['vorg'][1] - s['worg'][1] * sy)

    def L2O(self):
        return mul(mul(self.st['world'], self.page()), self.out)

    def L2D(self):
        return mul(self.st['world'], self.page())

    # ── 출력 도우미 ──
    # 그릴 것은 모두 self.items 에 모은다: dict(clip=[클립 id…], m=논리→출력 행렬, d=경로(논리 좌표),
    #   fill=(r,g,b)|None, rule='nonzero'|'evenodd', stroke=dict|None) 또는 image 항목.
    def emit(self, d, m, fill=None, rule='nonzero', stroke=None):
        if d and (fill is not None or stroke is not None):
            self.items.append(dict(clip=list(self.st['clip']), m=m, d=d, fill=fill, rule=rule, stroke=stroke))

    def add_clip(self, d_out, rule='nonzero'):
        cid = len(self.clipdefs)
        self.clipdefs.append((d_out, rule))
        self.st['clip'] = self.st['clip'] + [cid]
        return cid

    def rect_out_d(self, l, t, r, b, m):
        pts = [apply(m, x, y) for x, y in ((l, t), (r, t), (r, b), (l, b))]
        return 'M' + ' L'.join(f'{x:.4f} {y:.4f}' for x, y in pts) + ' Z'

    def stroke_attrs(self):
        p = self.st['pen']
        if p is None or p.get('style', 0) & 0xF == 5:
            return None
        m = self.L2O()
        det = math.sqrt(abs(m[0] * m[3] - m[1] * m[2])) or 1.0   # 논리 1 → 출력 픽셀
        st = p.get('style', 0)
        geometric = (not p.get('cosmetic')) and p['width'] > 1
        if geometric:
            w_log = float(p['width'])
            if w_log * det < 1.0:   # 기하 펜은 변환된 굵기 그대로(화면 배율에 따라 달라지는 최소 굵기는 적용하지 않음), 최소 1 출력 px
                w_log = 1.0 / det
        else:
            # 코스메틱 펜(굵기 0·1): PowerPoint 100 % 화면(96 dpi)에서 1 픽셀 → 출력 픽셀로 환산
            w_log = self.hairline / det
        cap = {0: 'round', 0x100: 'square', 0x200: 'butt'}.get(st & 0xF00, 'round')
        join = {0: 'round', 0x1000: 'bevel', 0x2000: 'miter'}.get(st & 0xF000, 'round')
        if not p.get('ext'):
            cap, join = 'round', 'round'
        dash = {1: (3, 1), 2: (1, 1), 3: (3, 1, 1, 1), 4: (3, 1, 1, 1, 1, 1)}.get(st & 0xF)
        if dash:
            unit = w_log if geometric else 3 * w_log
            dash = tuple(x * unit for x in dash)
            warn('점선 펜 — 간격은 근사(굵기 배수)')
        if (st & 0xF) == 7:
            warn('PS_USERSTYLE 점선 — 실선으로 그림')
        self.info['pens'].append(dict(color=p['color'], width_log=w_log, width_out=w_log * det))
        return dict(color=p['color'], w=w_log, cap=cap, join=join, miter=self.st['miter'], dash=dash)

    def fill_attrs(self):
        b = self.st['brush']
        return b, ('evenodd' if self.st['polyfill'] == 1 else 'nonzero')

    def draw(self, d, fill=False, stroke=True):
        sa = self.stroke_attrs() if stroke else None
        fc, rule = self.fill_attrs() if fill else (None, 'nonzero')
        self.emit(d, self.L2O(), fc, rule, sa)

    # ── 글자 ──
    def text(self, ref, s, dx, opts, rcl):
        f = self.st['font']
        face = f['face']
        if face.lower() == 'symbol' or f['charset'] == 2:
            s = ''.join(SYMBOL.get(chr(ord(ch) - 0xF000) if 0xF000 <= ord(ch) <= 0xF0FF else ch, ch) for ch in s)
        tt = get_font(face, f['weight'], f['italic'])
        upm = tt['head'].unitsPerEm
        os2 = tt['OS/2']
        asc, desc = os2.usWinAscent, os2.usWinDescent
        if f['height'] < 0:
            em = -f['height']
        elif f['height'] > 0:
            em = f['height'] * upm / (asc + desc)
        else:
            em = 12
        sc = em / upm
        a = f['esc'] / 10.0 * math.pi / 180.0
        # 논리 좌표(y 아래) 기준 진행 방향 u, 글자 위쪽 방향 up
        ydown = self.L2D()[3] > 0
        u = (math.cos(a), -math.sin(a) if ydown else math.sin(a))
        up = (u[1], -u[0]) if ydown else (-u[1], u[0])
        cmap = tt.getBestCmap()
        gs = tt.getGlyphSet()
        fb = None
        glyphs = []
        for ch in s:
            src, gname = tt, cmap.get(ord(ch))
            if gname is None:
                fb = fb or fallback_font()
                gname = fb.getBestCmap().get(ord(ch))
                src = fb
                if gname is None:
                    warn(f'글리프 없음: U+{ord(ch):04X} ({face})')
                    src, gname = tt, '.notdef'
                else:
                    warn(f'U+{ord(ch):04X} 가 {face} 에 없어 {FALLBACK} 로 그림')
            adv = src['hmtx'][gname][0] * (em / src['head'].unitsPerEm)
            glyphs.append((src, gname, adv))
        adv_list = dx if dx else [g[2] for g in glyphs]
        total = sum(adv_list)
        ta = self.st['talign']
        hx = ta & 6
        vy = ta & 24
        ox, oy = ref
        if hx == 2:      # TA_RIGHT
            ox, oy = ox - u[0] * total, oy - u[1] * total
        elif hx == 6:    # TA_CENTER
            ox, oy = ox - u[0] * total / 2, oy - u[1] * total / 2
        if vy == 0:      # TA_TOP: 기준점이 글자 칸 위 → 기준선은 ascent 만큼 아래
            ox, oy = ox - up[0] * asc * sc, oy - up[1] * asc * sc
        elif vy == 8:    # TA_BOTTOM
            ox, oy = ox + up[0] * desc * sc, oy + up[1] * desc * sc
        M = self.L2O()
        # 배경(ETO_OPAQUE 또는 OPAQUE 모드)
        if opts & 0x2 and rcl[2] > rcl[0]:
            self.emit(f'M{rcl[0]} {rcl[1]} H{rcl[2]} V{rcl[3]} H{rcl[0]} Z', M, self.st['bkcolor'])
        elif self.st['bkmode'] == 2 and s.strip():
            bl = [(ox + up[0] * asc * sc, oy + up[1] * asc * sc), (ox - up[0] * desc * sc, oy - up[1] * desc * sc)]
            q = [bl[0], (bl[0][0] + u[0] * total, bl[0][1] + u[1] * total), (bl[1][0] + u[0] * total, bl[1][1] + u[1] * total), bl[1]]
            self.emit('M' + ' L'.join(f'{x:.3f} {y:.3f}' for x, y in q) + ' Z', M, self.st['bkcolor'])
        x, y = ox, oy
        for (src, gname, adv), step in zip(glyphs, adv_list):
            s2 = em / src['head'].unitsPerEm
            pen = SVGPathPen(src.getGlyphSet())
            src.getGlyphSet()[gname].draw(TransformPen(pen, (u[0] * s2, u[1] * s2, up[0] * s2, up[1] * s2, x, y)))
            d = pen.getCommands()
            if d:
                self.emit(d, M, self.st['textcolor'])
            x, y = x + u[0] * step, y + u[1] * step
        if f['italic'] and 'Italic' not in tt['name'].getDebugName(4):
            warn('기울임 글꼴 파일 없음')
        self.info['texts'].append(dict(text=s, ref=apply(M, *ref), esc=f['esc'], size_out=em * math.sqrt(abs(M[0] * M[3]))))

    # ── 레코드 해석 ──
    def poly_d(self, pts, close=False):
        if not pts:
            return ''
        return 'M' + ' L'.join(f'{x} {y}' for x, y in pts) + (' Z' if close else '')

    def run(self):
        b = self.emf
        o = 0
        while o + 8 <= len(b):
            t, sz = struct.unpack_from('<II', b, o)
            if sz < 8:
                break
            d = b[o + 8:o + sz]
            self.info['records'][t] = self.info['records'].get(t, 0) + 1
            self.rec(t, d)
            o += sz
            if t == 14:
                break

    def pts16(self, d, off, n):
        return [struct.unpack_from('<hh', d, off + 4 * i) for i in range(n)]

    def pts32(self, d, off, n):
        return [struct.unpack_from('<ii', d, off + 8 * i) for i in range(n)]

    def shape(self, d, closed, fill):
        if self.path is not None:
            self.path.append(d)
            return
        self.draw(d, fill=fill, stroke=True)

    def rec(self, t, d):
        s = self.st
        if t in (1, 14, 70, 98, 115, 16, 21, 20, 13, 117, 118, 119, 120, 49, 48, 50, 102, 103, 104, 108, 110, 111, 112):
            # HEADER EOF GDICOMMENT SETICMMODE SETLAYOUT SETMAPPERFLAGS SETSTRETCHBLTMODE SETROP2 SETBRUSHORGEX
            # COLORCORRECT… SELECTPALETTE CREATEPALETTE SETPALETTEENTRIES 등: 모양에 영향 없음
            if t == 20 and struct.unpack_from('<I', d, 0)[0] not in (13,):
                warn(f'SETROP2 {struct.unpack_from("<I", d, 0)[0]} (R2_COPYPEN 아님) — 무시')
            return
        if t == 33:       # SAVEDC
            self.stack.append(dict(s)); return
        if t == 34:       # RESTOREDC
            i = struct.unpack_from('<i', d, 0)[0]
            if i < 0:
                for _ in range(-i - 1):
                    self.stack.pop()
                self.st = self.stack.pop()
            else:
                warn('RESTOREDC 양수 인덱스'); self.st = self.stack[i - 1]; del self.stack[i - 1:]
            return
        if t == 35:       # SETWORLDTRANSFORM
            s['world'] = struct.unpack_from('<6f', d, 0); return
        if t == 36:       # MODIFYWORLDTRANSFORM
            x = struct.unpack_from('<6f', d, 0); mode = struct.unpack_from('<I', d, 24)[0]
            if mode == 1: s['world'] = ID
            elif mode == 2: s['world'] = mul(x, s['world'])
            elif mode == 3: s['world'] = mul(s['world'], x)
            elif mode == 4: s['world'] = x
            return
        if t == 17: s['mapmode'] = struct.unpack_from('<I', d, 0)[0]; return
        if t == 9: s['wext'] = struct.unpack_from('<ii', d, 0); return
        if t == 10: s['worg'] = struct.unpack_from('<ii', d, 0); return
        if t == 11: s['vext'] = struct.unpack_from('<ii', d, 0); return
        if t == 12: s['vorg'] = struct.unpack_from('<ii', d, 0); return
        if t in (31, 32):  # SCALEVIEWPORTEXTEX / SCALEWINDOWEXTEX
            xn, xd, yn, yd = struct.unpack_from('<iiii', d, 0); k = 'vext' if t == 31 else 'wext'
            s[k] = (s[k][0] * xn / xd, s[k][1] * yn / yd); return
        if t == 26:
            warn('OFFSETCLIPRGN — 무시'); return
        if t == 18: s['bkmode'] = struct.unpack_from('<I', d, 0)[0]; return
        if t == 19: s['polyfill'] = struct.unpack_from('<I', d, 0)[0]; return
        if t == 22: s['talign'] = struct.unpack_from('<I', d, 0)[0]; return
        if t == 24: s['textcolor'] = colorref(d, 0); return
        if t == 25: s['bkcolor'] = colorref(d, 0); return
        if t == 58: s['miter'] = float(struct.unpack_from('<I', d, 0)[0]); return
        if t == 27: s['pos'] = struct.unpack_from('<ii', d, 0)
        if t == 27:
            if self.path is not None: self.path.append(f'M{s["pos"][0]} {s["pos"][1]}')
            return
        # 개체
        if t == 38:       # CREATEPEN (LOGPEN)
            ih, style, w, _, c = struct.unpack_from('<IIiiI', d, 0)
            self.objs[ih] = ('pen', None if (style & 0xF) == 5 else dict(color=colorref(d, 16), width=w, style=style, cosmetic=False, ext=False)); return
        if t == 95:       # EXTCREATEPEN (LOGPEN_EX)
            ih = struct.unpack_from('<I', d, 0)[0]
            style, w, bstyle = struct.unpack_from('<III', d, 20)
            col = colorref(d, 32)
            if bstyle not in (0, 1):
                warn(f'EXTCREATEPEN 브러시 스타일 {bstyle} — 단색으로 그림')
            pen = None if (style & 0xF) == 5 or bstyle == 1 else dict(color=col, width=w, style=style, cosmetic=(style & 0xF0000) == 0, ext=True)
            self.objs[ih] = ('pen', pen); return
        if t == 39:       # CREATEBRUSHINDIRECT
            ih, style = struct.unpack_from('<II', d, 0)
            if style == 1: self.objs[ih] = ('brush', None)
            else:
                if style != 0: warn(f'브러시 스타일 {style}(해치 등) — 단색으로 그림')
                self.objs[ih] = ('brush', colorref(d, 8))
            return
        if t in (93, 94):  # CREATEMONOBRUSH / CREATEDIBPATTERNBRUSHPT
            warn('패턴 브러시 — 회색 단색으로 그림'); self.objs[struct.unpack_from('<I', d, 0)[0]] = ('brush', (128, 128, 128)); return
        if t == 82:       # EXTCREATEFONTINDIRECTW
            ih = struct.unpack_from('<I', d, 0)[0]
            hgt, wid, esc, ori, wt = struct.unpack_from('<iiiii', d, 4)
            it, ul, so, cs = struct.unpack_from('<BBBB', d, 24)
            face = d[32:96].decode('utf-16le', 'ignore').split('\0')[0]
            if esc != ori: warn(f'글꼴 escapement {esc} ≠ orientation {ori}')
            if wid: warn(f'글꼴 너비 지정 {wid} — 무시(글자 간격은 Dx 로 맞춤)')
            if ul or so: warn('밑줄/취소선 글꼴 — 선은 그리지 않음')
            self.objs[ih] = ('font', dict(height=hgt, esc=esc, weight=wt, italic=it, face=face, charset=cs)); return
        if t == 37:       # SELECTOBJECT
            ih = struct.unpack_from('<I', d, 0)[0]
            if ih & 0x80000000:
                kind, v = STOCK.get(ih & 0x7FFFFFFF, (None, None))
                if kind == 'font': v = DEFAULT_FONT
            else:
                if ih not in self.objs:
                    warn(f'없는 개체 선택 {ih}'); return
                kind, v = self.objs[ih]
            if kind in ('pen', 'brush', 'font'): s[kind] = v
            return
        if t == 40:       # DELETEOBJECT
            self.objs.pop(struct.unpack_from('<I', d, 0)[0], None); return
        # 클립
        if t == 30 or t == 29:   # INTERSECTCLIPRECT / EXCLUDECLIPRECT (논리 좌표)
            l, tp, r, bt = struct.unpack_from('<iiii', d, 0)
            m = mul(self.L2D(), self.out)
            if t == 30:
                self.add_clip(self.rect_out_d(l, tp, r, bt, m))
                self.info['clips'].append(dict(logical=(l, tp, r, bt), out=[apply(m, l, tp), apply(m, r, bt)]))
            else:
                big = f'M-1e5 -1e5 H1e5 V1e5 H-1e5 Z '
                self.add_clip(big + self.rect_out_d(l, tp, r, bt, m), 'evenodd')
            return
        if t == 28:       # SETMETARGN: 현재 클립이 메타 영역이 된다(모양 변화 없음)
            return
        if t == 75:       # EXTSELECTCLIPRGN (장치 좌표)
            cb, mode = struct.unpack_from('<II', d, 0)
            if cb == 0:
                if mode == 5: s['clip'] = []
                else: warn(f'EXTSELECTCLIPRGN 빈 영역 mode {mode}')
                return
            nrect = struct.unpack_from('<I', d, 8 + 8)[0]
            rects = [struct.unpack_from('<iiii', d, 8 + 32 + 16 * i) for i in range(nrect)]
            dd = ' '.join(self.rect_out_d(*r, self.out) for r in rects)
            if mode == 5: s['clip'] = []; self.add_clip(dd)
            elif mode == 1: self.add_clip(dd)
            else: warn(f'EXTSELECTCLIPRGN mode {mode} 미지원 — 무시')
            return
        if t == 67:       # SELECTCLIPPATH
            mode = struct.unpack_from('<I', d, 0)[0]
            if self.last_path:
                m = mul(self.L2D(), self.out)
                dd = self._transform_d(self.last_path, m)
                if mode == 5: s['clip'] = []
                if mode in (1, 5): self.add_clip(dd)
                else: warn(f'SELECTCLIPPATH mode {mode} 미지원')
            return
        # 경로
        if t == 59: self.path = []; return                       # BEGINPATH
        if t == 60: self.last_path = self.path or []; self.path = None; return   # ENDPATH
        if t == 61:
            if self.path is not None: self.path.append('Z')
            return
        if t == 66: self.path = None; self.last_path = []; return   # ABORTPATH
        if t in (62, 63, 64):   # FILLPATH STROKEANDFILLPATH STROKEPATH
            dd = ' '.join(getattr(self, 'last_path', []) or [])
            if dd: self.draw(dd, fill=t in (62, 63), stroke=t in (63, 64))
            self.last_path = []
            return
        if t in (65, 68):   # FLATTENPATH WIDENPATH
            if t == 68: warn('WIDENPATH 미지원')
            return
        # 모양
        if t in (87, 86, 85, 4, 3, 2):   # POLYLINE16 POLYGON16 POLYBEZIER16 / 32비트판
            n = struct.unpack_from('<I', d, 16)[0]
            pts = self.pts16(d, 20, n) if t >= 85 else self.pts32(d, 20, n)
            if t in (85, 2):
                dd = f'M{pts[0][0]} {pts[0][1]}' + ''.join(f' C{pts[i][0]} {pts[i][1]} {pts[i+1][0]} {pts[i+1][1]} {pts[i+2][0]} {pts[i+2][1]}' for i in range(1, n - 2, 3))
                self.shape(dd, False, False)
            else:
                closed = t in (86, 3)
                self.shape(self.poly_d(pts, closed), closed, closed)
            return
        if t in (89, 88, 6, 5):   # POLYLINETO16 POLYBEZIERTO16 / 32
            n = struct.unpack_from('<I', d, 16)[0]
            pts = self.pts16(d, 20, n) if t >= 88 else self.pts32(d, 20, n)
            if t in (89, 6):
                dd = ' L'.join(f'{x} {y}' for x, y in pts); dd = 'L' + dd
            else:
                dd = ''.join(f' C{pts[i][0]} {pts[i][1]} {pts[i+1][0]} {pts[i+1][1]} {pts[i+2][0]} {pts[i+2][1]}' for i in range(0, n - 2, 3))
            if self.path is not None:
                self.path.append(dd)
            else:
                self.draw(f'M{s["pos"][0]} {s["pos"][1]} ' + dd)
            s['pos'] = pts[-1]
            return
        if t in (90, 91, 7, 8):   # POLYPOLYLINE16 POLYPOLYGON16 / 32
            npoly, total = struct.unpack_from('<II', d, 16)
            counts = struct.unpack_from(f'<{npoly}I', d, 24)
            off = 24 + 4 * npoly
            pts = self.pts16(d, off, total) if t >= 90 else self.pts32(d, off, total)
            closed = t in (91, 8)
            dd, k = [], 0
            for c in counts:
                dd.append(self.poly_d(pts[k:k + c], closed)); k += c
            self.shape(' '.join(dd), closed, closed)
            return
        if t == 54:       # LINETO
            x, y = struct.unpack_from('<ii', d, 0)
            if self.path is not None: self.path.append(f'L{x} {y}')
            else: self.draw(f'M{s["pos"][0]} {s["pos"][1]} L{x} {y}')
            s['pos'] = (x, y); return
        if t == 43:       # RECTANGLE (GDI: 오른쪽·아래 끝 제외)
            l, tp, r, bt = struct.unpack_from('<iiii', d, 0)
            self.shape(f'M{l} {tp} H{r - 1} V{bt - 1} H{l} Z', True, True); return
        if t == 42:       # ELLIPSE
            l, tp, r, bt = struct.unpack_from('<iiii', d, 0)
            cx, cy, rx, ry = (l + r) / 2, (tp + bt) / 2, (r - l) / 2, (bt - tp) / 2
            self.shape(ellipse_d(cx, cy, rx, ry), True, True); return
        if t == 44:       # ROUNDRECT
            l, tp, r, bt, cw, ch = struct.unpack_from('<iiiiii', d, 0)
            rx, ry, k = cw / 2, ch / 2, 0.5523
            self.shape(f'M{l + rx} {tp} L{r - rx} {tp} C{r - rx + k * rx} {tp} {r} {tp + ry - k * ry} {r} {tp + ry} L{r} {bt - ry} '
                       f'C{r} {bt - ry + k * ry} {r - rx + k * rx} {bt} {r - rx} {bt} L{l + rx} {bt} C{l + rx - k * rx} {bt} {l} {bt - ry + k * ry} {l} {bt - ry} '
                       f'L{l} {tp + ry} C{l} {tp + ry - k * ry} {l + rx - k * rx} {tp} {l + rx} {tp} Z', True, True); return
        if t in (84, 83):   # EXTTEXTOUTW / A
            gm, exs, eys = struct.unpack_from('<Iff', d, 16)
            x, y, n, off, opt = struct.unpack_from('<iiIII', d, 28)
            rcl = struct.unpack_from('<iiii', d, 48)
            offdx = struct.unpack_from('<I', d, 64)[0]
            if t == 84: txt = d[off - 8:off - 8 + 2 * n].decode('utf-16le', 'replace')
            else: txt = d[off - 8:off - 8 + n].decode('cp1252', 'replace')
            dx = []
            if offdx and n:
                step = 2 if opt & 0x2000 else 1
                raw = struct.unpack_from(f'<{n * step}i', d, offdx - 8)
                dx = list(raw[::step])
            if opt & 0x10:
                warn('ETO_GLYPH_INDEX 글자 — 글리프 번호 그대로 해석 불가')
            if s['talign'] & 1:
                warn('TA_UPDATECP — 현재 위치 기준 글자 근사')
                x, y = s['pos']
            if gm == 1 and (exs or eys) and abs(exs - eys) > 1e-6:
                pass
            self.text((x, y), txt, dx, opt, rcl)
            return
        if t in (97, 96):
            warn('POLYTEXTOUT 미지원'); return
        if t in (76, 77, 81, 80):   # BITBLT STRETCHBLT STRETCHDIBITS SETDIBITSTODEVICE
            self.blit(t, d); return
        if t in (71, 72, 73, 74):
            warn(f'영역 채우기 레코드 {t} 미지원'); return
        warn(f'레코드 {t} 미지원 — 무시')

    def _transform_d(self, parts, m):
        # 경로 문자열의 좌표를 출력 좌표로 (M/L/C/Z 만)
        out = []
        for p in parts:
            toks = p.replace('M', ' M ').replace('L', ' L ').replace('C', ' C ').replace('Z', ' Z ').split()
            nums = []
            for tk in toks:
                if tk in 'MLCZ':
                    if nums: out.append(' '.join(nums)); nums = []
                    out.append(tk)
                else:
                    nums.append(tk)
            if nums: out.append(' '.join(nums))
        res, buf = [], []
        for tk in out:
            if tk in 'MLCZ': res.append(tk); continue
            v = [float(x) for x in tk.split()]
            for i in range(0, len(v), 2):
                X, Y = apply(m, v[i], v[i + 1]); res.append(f'{X:.4f} {Y:.4f}')
        return ' '.join(res)

    def blit(self, t, d):
        if t == 76:   # BITBLT
            xd, yd, cx, cy, rop = struct.unpack_from('<iiiiI', d, 16)
            offbmi, cbbmi, offbits, cbbits = struct.unpack_from('<IIII', d, 76)
            if cbbmi == 0:
                if rop == 0x00AA0029: return            # D (아무것도 안 함)
                col = {0x00F00021: self.st['brush'], 0x00FF0062: (255, 255, 255), 0x00000042: (0, 0, 0)}.get(rop, 'x')
                if col == 'x': warn(f'BITBLT 래스터 연산 {rop:#x} 미지원'); return
                if col is None: return
                self.emit(f'M{xd} {yd} H{xd + cx} V{yd + cy} H{xd} Z', self.L2O(), col); return
            xs = ys = 0; cxs, cys = cx, cy
        elif t == 77:  # STRETCHBLT
            xd, yd, cx, cy, rop = struct.unpack_from('<iiiiI', d, 16)
            xs, ys = struct.unpack_from('<ii', d, 36)
            offbmi, cbbmi, offbits, cbbits = struct.unpack_from('<IIII', d, 76)
            cxs, cys = struct.unpack_from('<ii', d, 92)
            if cbbmi == 0: warn('STRETCHBLT 비트맵 없음'); return
        elif t == 81:  # STRETCHDIBITS
            xd, yd, xs, ys, cxs, cys, offbmi, cbbmi, offbits, cbbits, usage, rop, cx, cy = struct.unpack_from('<iiiiiiIIIIIIii', d, 16)
        else:
            warn('SETDIBITSTODEVICE 미지원'); return
        img = dib_to_png(d[offbmi - 8:offbmi - 8 + cbbmi], d[offbits - 8:offbits - 8 + cbbits], xs, ys, cxs, cys)
        if img is None:
            warn(f'비트맵 형식 미지원(레코드 {t})'); return
        self.items.append(dict(clip=list(self.st['clip']), m=self.L2O(), image=img, rect=(xd, yd, cx, cy)))

    def svg(self):
        """디버그·브라우저 확인용 SVG (브라우저는 clip-path 를 지킨다)."""
        defs = ''.join(f'<clipPath id="c{i}" clipPathUnits="userSpaceOnUse"><path d="{d}" clip-rule="{r}"/></clipPath>' for i, (d, r) in enumerate(self.clipdefs))
        body = []
        for it in self.items:
            m = it['m']
            g = f'<g transform="matrix({m[0]:.9g} {m[1]:.9g} {m[2]:.9g} {m[3]:.9g} {m[4]:.9g} {m[5]:.9g})">'
            if 'image' in it:
                import base64
                x, y, w, h = it['rect']
                uri = 'data:image/png;base64,' + base64.b64encode(it['image']).decode()
                inner = f'<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="none" href="{uri}"/>'
            else:
                a = f'fill="{rgb(it["fill"])}" fill-rule="{it["rule"]}"' if it['fill'] is not None else 'fill="none"'
                st = it['stroke']
                if st:
                    a += (f' stroke="{rgb(st["color"])}" stroke-width="{st["w"]:.6g}" stroke-linecap="{st["cap"]}" '
                          f'stroke-linejoin="{st["join"]}" stroke-miterlimit="{st["miter"]:.4g}"')
                    if st['dash']: a += ' stroke-dasharray="' + ' '.join(f'{x:.4g}' for x in st['dash']) + '"'
                inner = f'<path d="{it["d"]}" {a}/>'
            body.append(''.join(f'<g clip-path="url(#c{c})">' for c in it['clip']) + g + inner + '</g>' + '</g>' * len(it['clip']))
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.W}" height="{self.H}" viewBox="0 0 {self.W} {self.H}">'
                f'<defs>{defs}</defs>{"".join(body)}</svg>')

    def pdf(self, mode='normal'):
        """같은 항목을 PDF 한 쪽으로 — 클립(W n)·변환(cm)·선 모양을 PDF 연산자로 그대로 옮긴다.
        mode='clipped-noclip': 진단용 — 클립이 걸린 항목(곡선 등)만, 클립 없이 그린다(프레임 밖 잘림 검사)."""
        doc = pymupdf.open()
        page = doc.new_page(width=self.W, height=self.H)
        ops = [f'1 0 0 -1 0 {self.H} cm']   # PDF(y 위) → 출력(y 아래)
        imgs = []
        for it in self.items:
            if mode == 'clipped-noclip' and not it['clip']:
                continue
            ops.append('q')
            for c in (it['clip'] if mode == 'normal' else []):
                d, r = self.clipdefs[c]
                ops.append(svgd_to_pdf(d) + (' W* n' if r == 'evenodd' else ' W n'))
            m = it['m']
            ops.append(f'{m[0]:.9f} {m[1]:.9f} {m[2]:.9f} {m[3]:.9f} {m[4]:.9f} {m[5]:.9f} cm')
            if 'image' in it:
                x, y, w, h = it['rect']
                name = f'Im{len(imgs)}'
                imgs.append((name, it['image']))
                ops.append(f'{w} 0 0 {-h} {x} {y + h} cm /{name} Do')   # 이미지 단위정사각형 → (x,y,w,h), 위아래 맞춤
            else:
                f, st = it['fill'], it['stroke']
                if f is not None: ops.append('%.4f %.4f %.4f rg' % tuple(v / 255 for v in f))
                if st:
                    ops.append('%.4f %.4f %.4f RG' % tuple(v / 255 for v in st['color']))
                    cap = dict(butt=0, round=1, square=2)[st['cap']]
                    join = dict(miter=0, round=1, bevel=2)[st['join']]
                    ops.append(f'{st["w"]:.6f} w {cap} J {join} j {st["miter"]:.3f} M')
                    if st['dash']: ops.append('[' + ' '.join(f'{x:.4f}' for x in st['dash']) + '] 0 d')
                ev = it['rule'] == 'evenodd'
                op = ('B*' if ev else 'B') if (f is not None and st) else (('f*' if ev else 'f') if f is not None else 'S')
                ops.append(svgd_to_pdf(it['d']) + ' ' + op)
            ops.append('Q')
        # 이미지 XObject 등록(있을 때만)
        if imgs:
            page.insert_image(pymupdf.Rect(0, 0, 1, 1), stream=imgs[0][1])   # 자원 사전 준비용
            warn('비트맵 레코드 포함 — 이미지 배치를 눈으로 확인할 것')
            xref_names = []
            for name, data in imgs:
                x = page.insert_image(pymupdf.Rect(0, 0, 0.001, 0.001), stream=data)
                xref_names.append((name, x))
            for name, x in xref_names:
                doc.xref_set_key(page.xref, f'Resources/XObject/{name}', f'{x} 0 R')
        cx = page.get_contents()
        stream = '\n'.join(ops).encode()
        if cx:
            doc.update_stream(cx[0], stream)
            for extra in cx[1:]: doc.update_stream(extra, b'')
        else:
            x = doc.get_new_xref(); doc.update_object(x, '<<>>'); doc.update_stream(x, stream)
            doc.xref_set_key(page.xref, 'Contents', f'{x} 0 R')
        return doc


TOK = re.compile(r'[MLHVCQZmlhvcqz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')

def svgd_to_pdf(d):
    """M L H V C Q Z (절대 좌표)만 쓰는 경로 문자열을 PDF 경로 연산자로."""
    out, cmd, nums = [], None, []
    cx = cy = sx = sy = 0.0
    def flush():
        nonlocal cx, cy, sx, sy
        n = nums
        if cmd == 'M':
            for i in range(0, len(n), 2):
                cx, cy = n[i], n[i + 1]
                if i == 0: sx, sy = cx, cy; out.append(f'{cx:.4f} {cy:.4f} m')
                else: out.append(f'{cx:.4f} {cy:.4f} l')
        elif cmd == 'L':
            for i in range(0, len(n), 2):
                cx, cy = n[i], n[i + 1]; out.append(f'{cx:.4f} {cy:.4f} l')
        elif cmd == 'H':
            for v in n: cx = v; out.append(f'{cx:.4f} {cy:.4f} l')
        elif cmd == 'V':
            for v in n: cy = v; out.append(f'{cx:.4f} {cy:.4f} l')
        elif cmd == 'C':
            for i in range(0, len(n), 6):
                out.append('%.4f %.4f %.4f %.4f %.4f %.4f c' % tuple(n[i:i + 6])); cx, cy = n[i + 4], n[i + 5]
        elif cmd == 'Q':
            for i in range(0, len(n), 4):
                qx, qy, x, y = n[i:i + 4]
                c1 = (cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy)); c2 = (x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y))
                out.append('%.4f %.4f %.4f %.4f %.4f %.4f c' % (*c1, *c2, x, y)); cx, cy = x, y
        elif cmd == 'Z':
            out.append('h'); cx, cy = sx, sy
        elif cmd is not None:
            raise ValueError(f'경로 명령 {cmd} 미지원')
    for t in TOK.findall(d):
        if t.isalpha():
            flush(); cmd, nums = t, []
            if t in 'Zz': flush(); cmd = None
        else:
            nums.append(float(t))
    flush()
    return ' '.join(out)


def ellipse_d(cx, cy, rx, ry):
    k = 0.5523
    return (f'M{cx + rx} {cy} C{cx + rx} {cy + k * ry} {cx + k * rx} {cy + ry} {cx} {cy + ry} '
            f'C{cx - k * rx} {cy + ry} {cx - rx} {cy + k * ry} {cx - rx} {cy} '
            f'C{cx - rx} {cy - k * ry} {cx - k * rx} {cy - ry} {cx} {cy - ry} '
            f'C{cx + k * rx} {cy - ry} {cx + rx} {cy - k * ry} {cx + rx} {cy} Z')


def dib_to_png(bmi, bits, xs, ys, cxs, cys):
    size, w, h, planes, bpp, comp = struct.unpack_from('<IiiHHI', bmi, 0)
    if comp not in (0, 3):
        return None
    flip = h > 0
    h = abs(h)
    stride = ((w * bpp + 31) // 32) * 4
    if bpp == 24:
        a = np.frombuffer(bits, np.uint8)[:stride * h].reshape(h, stride)[:, :w * 3].reshape(h, w, 3)[:, :, ::-1]
    elif bpp == 32:
        a = np.frombuffer(bits, np.uint8)[:stride * h].reshape(h, stride)[:, :w * 4].reshape(h, w, 4)[:, :, 2::-1]
    elif bpp in (1, 4, 8):
        ncol = struct.unpack_from('<I', bmi, 32)[0] or (1 << bpp)
        pal = np.frombuffer(bmi[size:size + 4 * ncol], np.uint8).reshape(-1, 4)[:, 2::-1]
        raw = np.frombuffer(bits, np.uint8)[:stride * h].reshape(h, stride)
        if bpp == 8: idx = raw[:, :w]
        elif bpp == 4: idx = np.stack([raw >> 4, raw & 15], -1).reshape(h, -1)[:, :w]
        else: idx = np.unpackbits(raw, axis=1)[:, :w]
        a = pal[idx]
    else:
        return None
    if flip:
        a = a[::-1]
    a = a[ys:ys + abs(cys), xs:xs + abs(cxs)]
    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(a)).save(buf, 'PNG')
    return buf.getvalue()


def render(emf, W, H, crop=(0, 0, 0, 0), transparent=False, hairline=None, mode='normal'):
    r = Renderer(emf, W, H, crop, hairline)
    r.run()
    doc = r.pdf(mode)
    pix = doc[0].get_pixmap(alpha=True)   # 쪽 크기 = W×H pt, 1pt = 1px
    im = Image.frombytes('RGBA', (pix.width, pix.height), pix.samples)
    if im.size != (W, H):
        raise SystemExit(f'래스터 크기 {pix.width}×{pix.height} ≠ {W}×{H}')
    if not transparent:
        bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im).convert('RGB')
    return im, r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out')
    ap.add_argument('--width', type=int, required=True); ap.add_argument('--height', type=int)
    ap.add_argument('--crop', default='0,0,0,0', help='PPT srcRect 비율 l,r,t,b')
    ap.add_argument('--hairline', type=float, help='코스메틱 펜 출력 굵기(px). 기본: PowerPoint 100 %% 화면 1px 환산')
    ap.add_argument('--svg'); ap.add_argument('--json'); ap.add_argument('--transparent', action='store_true')
    a = ap.parse_args()
    emf = load_emf(a.src)
    crop = tuple(float(x) for x in a.crop.split(','))
    if a.height is None:
        r0 = Renderer(emf, 1000, 1000, crop)
        fx0, fy0, fx1, fy1 = r0.frame_dev
        a.height = round(a.width * (fy1 - fy0) / (fx1 - fx0))
    im, r = render(emf, a.width, a.height, crop, a.transparent, a.hairline)
    if a.out.lower().endswith('.webp'):
        im.save(a.out, 'WEBP', lossless=True, quality=100, method=6)
    else:
        im.save(a.out)
    if a.svg:
        open(a.svg, 'w').write(r.svg())
    if a.json:
        json.dump(dict(size=[a.width, a.height], frame_dev=r.frame_dev, hairline_px=r.hairline, pens=r.info['pens'][:50], clips=r.info['clips'],
                       texts=r.info['texts'], records=r.info['records'], warnings=WARN), open(a.json, 'w'), ensure_ascii=False, indent=1)
    print(f'{a.out}: {a.width}×{a.height}, 경고 {len(WARN)}건')


if __name__ == '__main__':
    main()
