#!/usr/bin/env python3
# Generate small deterministic test PDFs (no dependencies): a.pdf (3 pages), b.pdf (2 pages).
import os, sys
here = os.path.dirname(os.path.abspath(__file__))

def pdf(path, title, pages):
    objs = []
    def add(s): objs.append(s); return len(objs)
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id = len(objs) + 1 + 2 * len(pages) + 1  # placeholder computed below
    kids = []
    page_objs = []
    for i, text in enumerate(pages):
        body = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET\n".encode() + b"0.2 0.4 0.8 rg 72 600 200 80 re f\n"
        c = add(b"<< /Length %d >>\nstream\n" % len(body) + body + b"endstream")
        page_objs.append(c)
    pages_id = len(objs) + len(pages) + 1
    for c in page_objs:
        p = add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages_id, font, c))
        kids.append(p)
    assert add(b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % len(kids)) == pages_id
    cat = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id)
    info = add(b"<< /Title (" + title.encode() + b") /Producer (gen-pdfs.py) >>")
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for o in offs: out += b"%010d 00000 n \n" % o
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, cat, info, x)
    open(os.path.join(here, path), "wb").write(out)

pdf("a.pdf", "Fixture A", ["Alpha page one", "Alpha page two", "Alpha page three"])
pdf("b.pdf", "Fixture B", ["Bravo page one", "Bravo page two"])
