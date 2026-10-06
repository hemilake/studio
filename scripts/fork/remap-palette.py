"""Fork (Hemilake Studio): remap Tailwind palette classes to Hemilake roles.

Run after an upstream merge brings new palette classes:
    python3 scripts/fork/remap-palette.py $(rg -l "-(blue|green|red|amber)-[0-9]{2,3}\b" src -g '*.tsx' -g '*.ts' -g '!fileIcons.ts' -g '!**/tests/**')
Each quoted segment of a line is handled on its own, so ternary branches never mix.
Review the diff: dots and spinners become copper, solid accents become ink buttons.


accent (blue, sky, indigo, violet, purple, cyan) -> ink actions, copper state, muted surfaces
ok (green, emerald, teal, lime)                  -> hemi-ok
warn (amber, yellow, orange)                     -> hemi-copper
danger (red, rose)                               -> destructive
cool grays (slate, zinc, neutral)                -> gray (stone via tailwind.config.js)
"""
import re, sys, pathlib

FAM = {}
for f in 'blue sky indigo violet purple cyan'.split(): FAM[f] = 'accent'
for f in 'green emerald teal lime'.split(): FAM[f] = 'ok'
for f in 'amber yellow orange'.split(): FAM[f] = 'warn'
for f in 'red rose'.split(): FAM[f] = 'danger'
for f in 'slate zinc neutral'.split(): FAM[f] = 'gray'

TOKEN = re.compile(r'^(?P<pre>(?:[a-z0-9-]+:|\[[^\]]*\]:)*)(?P<neg>!?)(?P<prop>bg|text|border|border-[lrtbxy]|ring|ring-offset|from|via|to|fill|stroke|outline|divide|placeholder|accent|caret|decoration|shadow|prose-a:text|prose-headings:text|prose-code:text|prose-strong:text)-(?P<fam>' + '|'.join(FAM) + r')-(?P<shade>\d{2,3})(?P<op>/\d+)?$')

SOLID = {
    'accent': 'primary', 'ok': 'hemi-ok', 'warn': 'hemi-copper', 'danger': 'destructive',
}
TINT = {
    'accent': 'muted', 'ok': 'hemi-ok-tint', 'warn': 'hemi-copper-tint', 'danger': 'destructive/10',
}
TEXT = {
    'accent': 'hemi-copper-text', 'ok': 'hemi-ok', 'warn': 'hemi-copper-text', 'danger': 'destructive',
}
LINE = {  # borders, rings, outlines, dividers
    'accent': 'border', 'ok': 'hemi-ok/40', 'warn': 'hemi-copper/40', 'danger': 'destructive/40',
}

def op_val(op):
    return int(op[1:]) if op else 100

def map_token(tok, ctx):
    m = TOKEN.match(tok)
    if not m:
        return tok
    pre, neg, prop, fam, shade, op = m['pre'], m['neg'], m['prop'], m['fam'], int(m['shade']), m['op'] or ''
    role = FAM[fam]
    if role == 'gray':
        return f'{pre}{neg}{prop}-gray-{shade}{op}'
    hover = any(p in pre for p in ('hover:', 'active:', 'focus:', 'group-hover:'))
    is_dark_variant = 'dark:' in pre
    light = shade <= 200 or (is_dark_variant and shade >= 800)
    weak = op_val(op) <= 30
    if prop in ('text', 'placeholder', 'caret', 'decoration') or prop.startswith('prose-'):
        if role == 'accent' and (shade >= 800 or (shade <= 200 and is_dark_variant) or shade <= 100):
            val = 'foreground'
        else:
            val = TEXT[role]
        keep_op = op if op and op_val(op) >= 50 else ''
        return f'{pre}{neg}{prop}-{val}{keep_op}'
    if prop in ('bg', 'from', 'via', 'to', 'fill', 'stroke', 'accent', 'shadow'):
        if prop in ('fill', 'stroke'):
            val = {'accent': 'hemi-copper', 'ok': 'hemi-ok', 'warn': 'hemi-copper', 'danger': 'destructive'}[role]
            return f'{pre}{neg}{prop}-{val}'
        if prop == 'accent':
            return f'{pre}{neg}accent-{SOLID[role]}'
        if prop == 'shadow':
            return f'{pre}{neg}shadow-transparent'
        if light or weak:
            return f'{pre}{neg}{prop}-{TINT[role]}'
        val = SOLID[role]
        # dots and spinners in the accent family are state, not actions
        if role == 'accent' and ctx.get('dot'):
            val = 'hemi-copper'
        if hover:
            val = val + '/90' if '/' not in val else val
        return f'{pre}{neg}{prop}-{val}'
    # border, ring, outline, divide
    if role == 'accent':
        strong = (300 <= shade <= 500) if is_dark_variant else (400 <= shade <= 700)
        if strong and not weak:
            val = 'ring' if prop in ('ring', 'outline') else 'hemi-copper'
        else:
            val = 'border' if prop != 'ring-offset' else 'background'
        if prop == 'ring' and val == 'border':
            val = 'border'
    else:
        val = LINE[role]
        if prop == 'ring-offset':
            val = 'background'
    return f'{pre}{neg}{prop}-{val}'

TOKRE = re.compile(r'(?<![\w:/\[\]-])(?:[a-z0-9-]+:|\[[^\]\s]*\]:)*!?[a-z-]+(?::text)?-(?:' + '|'.join(FAM) + r')-\d{2,3}(?:/\d+)?(?![\w/-])')
FAMRE = re.compile(r'-(?:' + '|'.join(FAM) + r')-\d{2,3}\b')

def process_string(body):
    if not FAMRE.search(body):
        return body
    toks = body.split()
    ctx = {'dot': ('rounded-full' in toks and any(re.match(r'^(h|w|size)-(1|1\.5|2|2\.5|3)$', t) for t in toks))
           or any('animate-spin' in t or 'animate-pulse' in t for t in toks)}
    mapped = {}
    for t in toks:
        if TOKRE.fullmatch(t):
            mapped[t] = map_token(t, ctx)
    new_toks = [mapped.get(t, t) for t in toks]
    plain = {t for t in new_toks if ':' not in t}
    solid_primary = any(mapped.get(t) == 'bg-primary' for t in toks)
    drop = set()
    seen = set()
    for orig, t in zip(toks, new_toks):
        base = re.sub(r'^(?:(?:dark|hover|focus|active|group-hover|focus-visible|md|sm|lg):)+', '', t)
        if orig in mapped and base != t and base in plain:
            drop.add(orig)
        elif orig in mapped and t in seen:
            drop.add(orig)
        seen.add(t)
    if solid_primary:
        if 'text-white' in toks: mapped['text-white'] = 'text-primary-foreground'
        if 'dark:text-white' in toks: drop.add('dark:text-white')
    def rep(m):
        t = m.group(0)
        if t in drop:
            return '\x00'
        return mapped.get(t, t)
    out = re.sub(r'(?<![^\s"\'`{}])[^\s"\'`{}]+(?![^\s"\'`{}])', rep, body)
    out = re.sub(r' \x00|\x00 ?', '', out)
    return out


def process_file_lines(path):
    src = path.read_text()
    lines = src.split('\n')
    changed = False
    for i, line in enumerate(lines):
        if not FAMRE.search(line):
            continue
        segs = re.split(r'(["\'`])', line)
        new = ''.join(process_string(s) if s not in ('"', "'", '`') else s for s in segs)
        if new != line:
            lines[i] = new; changed = True
    if changed:
        path.write_text('\n'.join(lines))
    return changed


if __name__ == '__main__':
    files = [pathlib.Path(f) for f in sys.argv[1:]]
    print('changed', sum(1 for f in files if process_file_lines(f)))
