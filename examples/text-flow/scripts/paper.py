"""
Turns the arXiv HTML of "Attention Is All You Need" (1706.03762v7, LaTeXML
output) into the block list the example lays out. Text only: figures, tables
and captions are dropped, inline math is flattened to spans with real sub- and
superscripts, footnotes become small blocks after the paragraph that cites them.

    python3 paper.py paper.html > ../src/paper.ts

Needs beautifulsoup4 and lxml.
"""

import json
import re
import sys

from bs4 import BeautifulSoup, NavigableString, Tag

INVISIBLE = {"⁡", "⁢", "⁣", "​"}
SPACED = {"=", "+", "−", "≤", "≥", "∈", "→", "≈", "±", "≠"}

SUP = dict(zip("0123456789+-=()niT", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵀ"))
SUB = dict(zip("0123456789+-=()aehijklmnoprstuvx", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"))


def clean(text):
    for ch in INVISIBLE:
        text = text.replace(ch, "")
    return re.sub(r"\s+", " ", text)


class Spans:
    def __init__(self):
        self.items = []

    def add(self, face, text):
        if text == "":
            return
        if self.items and self.items[-1][0] == face:
            self.items[-1][1] += text
        else:
            self.items.append([face, text])

    def extend(self, other):
        for face, text in other.items:
            self.add(face, text)

    def strip(self):
        if self.items:
            self.items[0][1] = self.items[0][1].lstrip()
            self.items[-1][1] = self.items[-1][1].rstrip()
        self.items = [s for s in self.items if s[1] != ""]
        return self

    def text(self):
        return "".join(t for _, t in self.items)


# ------------------------------------------------------------------ math


def flat(node):
    """A sub/superscript body as one string; nested scripts fall back to ^ and _."""
    if isinstance(node, NavigableString):
        return clean(str(node))
    name = node.name
    kids = [k for k in node.children if isinstance(k, Tag)]
    if name in ("mi", "mn", "mo", "mtext"):
        return clean(node.get_text())
    if name == "msup":
        return flat(kids[0]) + "^" + flat(kids[1])
    if name == "msub":
        return flat(kids[0]) + "_" + flat(kids[1])
    if name == "msubsup":
        return flat(kids[0]) + "_" + flat(kids[1]) + "^" + flat(kids[2])
    if name == "mfrac":
        return flat(kids[0]) + "/" + flat(kids[1])
    if name == "msqrt":
        return "√" + flat(kids[0])
    if name == "annotation":
        return ""
    return "".join(flat(k) for k in kids)


def script(out, body, face, table):
    text = flat(body)
    if all(ch in table for ch in text):
        # Every glyph has a Unicode form: keep it inline, no second face.
        out.add("m" if body.name == "mi" and len(text) == 1 else "r", "".join(table[c] for c in text))
    else:
        out.add(face, text)


def math(out, node):
    if isinstance(node, NavigableString):
        return
    name = node.name
    kids = [k for k in node.children if isinstance(k, Tag)]
    if name == "annotation":
        return
    if name == "mi":
        text = clean(node.get_text())
        out.add("m" if len(text) == 1 else "r", text)
    elif name == "mn":
        out.add("r", clean(node.get_text()))
    elif name == "mtext":
        text = clean(node.get_text())
        out.add("r", text + " " if text.isalpha() else text)
    elif name == "mo":
        text = clean(node.get_text())
        if text in SPACED:
            out.add("r", " " + text + " ")
        elif text == ",":
            out.add("r", ", ")
        else:
            out.add("r", text)
    elif name == "mspace":
        out.add("r", " ")
    elif name == "msup":
        math(out, kids[0])
        script(out, kids[1], "sup", SUP)
    elif name == "msub":
        math(out, kids[0])
        script(out, kids[1], "sub", SUB)
    elif name == "msubsup":
        math(out, kids[0])
        script(out, kids[1], "sub", SUB)
        script(out, kids[2], "sup", SUP)
    elif name == "mfrac":
        num, den = Spans(), Spans()
        math(num, kids[0])
        math(den, kids[1])
        wrap = lambda s: s.items if len(s.text()) <= 2 else [["r", "("]] + s.items + [["r", ")"]]
        for face, text in wrap(num):
            out.add(face, text)
        out.add("r", "/")
        for face, text in wrap(den):
            out.add(face, text)
    elif name == "msqrt":
        inner = Spans()
        math(inner, kids[0])
        out.add("r", "√")
        if len(inner.text()) > 2:
            out.add("r", "(")
            out.extend(inner)
            out.add("r", ")")
        else:
            out.extend(inner)
    elif name in ("mover", "munder", "munderover"):
        math(out, kids[0])
    elif name == "mtable":
        for i, row in enumerate(kids):
            if i:
                out.add("r", ";  ")
            math(out, row)
    else:
        for k in kids:
            math(out, k)


# ---------------------------------------------------------------- inline


def inline(out, node, face, notes):
    if isinstance(node, NavigableString):
        out.add(face, clean(str(node)))
        return
    classes = node.get("class", [])
    if node.name == "math":
        math(out, node)
        return
    if "ltx_note" in classes:
        content = node.select_one(".ltx_note_content")
        if content is not None:
            body = Spans()
            for k in content.children:
                if isinstance(k, Tag) and ("ltx_note_mark" in k.get("class", []) or "ltx_note_type" in k.get("class", []) or "ltx_tag" in k.get("class", [])):
                    continue
                inline(body, k, "r", notes)
            notes.append(body.strip())
        return
    if "ltx_font_italic" in classes:
        face = "i"
    elif "ltx_font_bold" in classes:
        face = "b"
    elif "ltx_font_typewriter" in classes:
        face = "c"
    for k in node.children:
        inline(out, k, face, notes)


def paragraph(p, notes, lead=None):
    out = Spans()
    if lead is not None:
        out.add("b", lead + " ")
    for k in p.children:
        inline(out, k, "r", notes)
    return out.strip()


# ---------------------------------------------------------------- blocks


def block(kind, spans):
    return {"kind": kind, "spans": [[f, t] for f, t in spans.items]}


def emit_notes(blocks, notes):
    for n in notes:
        blocks.append(block("note", n))
    notes.clear()


def walk(node, blocks, lead=None):
    """Depth-first over a section body. Returns the pending run-in heading."""
    for child in node.children:
        if not isinstance(child, Tag):
            continue
        classes = child.get("class", [])
        if "ltx_figure" in classes or "ltx_table" in classes:
            continue
        if child.name in ("h2", "h3", "h4") and "ltx_title" in classes:
            depth = {"h2": "h1", "h3": "h2", "h4": "h3"}[child.name]
            blocks.append(block(depth, heading(child)))
            continue
        if child.name == "h5" and "ltx_title" in classes:
            lead = clean(child.get_text()).strip()
            continue
        if child.name == "p" and "ltx_p" in classes:
            notes = []
            blocks.append(block("p", paragraph(child, notes, lead)))
            lead = None
            emit_notes(blocks, notes)
            continue
        if "ltx_eqn_table" in classes:
            notes = []
            for row in child.select("tr.ltx_eqn_row"):
                out = Spans()
                for m in row.select("math"):
                    math(out, m)
                tag = row.select_one(".ltx_tag_equation")
                if tag is not None:
                    out.add("r", "   " + clean(tag.get_text()).strip())
                blocks.append(block("eq", out.strip()))
            continue
        if child.name == "li" and "ltx_item" in classes:
            notes = []
            out = Spans()
            out.add("r", "• ")
            for p in child.select("p.ltx_p"):
                out.extend(paragraph(p, notes))
            blocks.append(block("li", out.strip()))
            emit_notes(blocks, notes)
            continue
        lead = walk(child, blocks, lead)
    return lead


def heading(h):
    out = Spans()
    out.add("r", clean(h.get_text()).strip())
    return out


def main(path):
    soup = BeautifulSoup(open(path, encoding="utf-8").read(), "lxml")
    doc = soup.select_one("article.ltx_document")
    blocks = []

    blocks.append(block("title", heading(doc.select_one("h1.ltx_title_document"))))

    notes = []
    for creator in doc.select(".ltx_authors .ltx_creator"):
        name = creator.select_one(".ltx_personname")
        out = Spans()
        for k in name.children:
            if isinstance(k, Tag) and "ltx_note" in k.get("class", []):
                inline(Spans(), k, "r", notes)
                continue
            out.add("b", clean(k.get_text() if isinstance(k, Tag) else str(k)).strip())
        for note in creator.select(":scope > .ltx_note"):
            inline(Spans(), note, "r", notes)
        affiliation = creator.select_one(".ltx_role_affiliation")
        email = creator.select_one(".ltx_role_email")
        if affiliation is not None:
            text = clean(affiliation.get_text()).replace("Affiliation:", "").strip()
            out.add("r", "  ·  " + text)
        if email is not None:
            text = clean(email.get_text()).replace("Email:", "").strip()
            out.add("r", "  ·  ")
            out.add("c", text)
        blocks.append(block("author", out.strip()))
    emit_notes(blocks, notes)

    abstract = doc.select_one(".ltx_abstract")
    blocks.append(block("abstract-title", heading(abstract.select_one(".ltx_title_abstract"))))
    for p in abstract.select("p.ltx_p"):
        notes = []
        blocks.append(block("abstract", paragraph(p, notes)))
        emit_notes(blocks, notes)

    for section in doc.select(":scope > section.ltx_section"):
        walk(section, blocks)

    bib = doc.select_one(".ltx_bibliography")
    if bib is not None:
        blocks.append(block("h1", heading(bib.select_one(".ltx_title_bibliography"))))
        for item in bib.select("li.ltx_bibitem"):
            out = Spans()
            tag = item.select_one(".ltx_tag_bibitem")
            out.add("r", clean(tag.get_text()).strip() + " ")
            for i, bb in enumerate(item.select(".ltx_bibblock")):
                if i:
                    out.add("r", " ")
                part = Spans()
                inline(part, bb, "r", [])
                out.extend(part.strip())
            blocks.append(block("ref", out.strip()))

    for b in blocks:
        b["spans"] = [[f, t] for f, t in b["spans"] if t != ""]
    blocks = [b for b in blocks if b["spans"]]

    faces = sorted({f for b in blocks for f, _ in b["spans"]})
    kinds = []
    for b in blocks:
        if b["kind"] not in kinds:
            kinds.append(b["kind"])

    print("/**")
    print(" * \"Attention Is All You Need\" (Vaswani et al., 2017, arXiv:1706.03762v7) as the")
    print(" * block list the example lays out. Generated by scripts/paper.py from the arXiv")
    print(" * HTML: text only, figures and tables dropped, math flattened to spans.")
    print(" */")
    print()
    print("export type Face = " + " | ".join(json.dumps(f) for f in faces) + ";")
    print()
    print("export type Kind =")
    for i, k in enumerate(kinds):
        print("  | " + json.dumps(k) + (";" if i == len(kinds) - 1 else ""))
    print()
    print("/** One styled run of text. Faces select a font within the block's size. */")
    print("export type Span = [face: Face, text: string];")
    print()
    print("export interface Block {")
    print("  kind: Kind;")
    print("  spans: Span[];")
    print("}")
    print()
    print("export const PAPER: Block[] = [")
    for b in blocks:
        spans = ", ".join("[" + json.dumps(f) + ", " + json.dumps(t, ensure_ascii=False) + "]" for f, t in b["spans"])
        print("  { kind: " + json.dumps(b["kind"]) + ", spans: [" + spans + "] },")
    print("];")


if __name__ == "__main__":
    main(sys.argv[1])
