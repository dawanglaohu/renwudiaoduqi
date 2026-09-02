import io, os

BS = chr(92)   # backslash
SL = "/"

def unmangle(s):
    """Inverse of the damaging transform. Per original character c it emitted:
         c == BS  ->  SL           (backslash consumed)
         else     ->  SL + c
       plus one trailing SL. Bottom-up DP; at an ambiguous 'SL SL' prefer
       'the original char was a literal slash', fall back to 'backslash'."""
    n = len(s)
    if n == 0:
        return None
    ok = [False] * (n + 1)
    pick = [None] * (n + 1)          # ('char', c) | ('slash',) | ('bs',)

    ok[n - 1] = (s[n - 1] == SL)     # the lone trailing separator
    if ok[n - 1]:
        pick[n - 1] = ("end",)

    for i in range(n - 2, -1, -1):
        if s[i] != SL:
            continue
        c = s[i + 1]
        if c != SL:
            if i + 2 <= n - 1 and ok[i + 2]:
                ok[i] = True
                pick[i] = ("char", c)
        else:
            if i + 2 <= n - 1 and ok[i + 2]:
                ok[i] = True
                pick[i] = ("slash",)
            elif ok[i + 1]:
                ok[i] = True
                pick[i] = ("bs",)

    if not ok[0]:
        return None

    out = []
    i = 0
    while True:
        kind = pick[i]
        if kind[0] == "end":
            break
        if kind[0] == "char":
            out.append(kind[1]); i += 2
        elif kind[0] == "slash":
            out.append(SL); i += 2
        else:
            out.append(BS); i += 1
    return "".join(out)


def main():
    for root, _, files in os.walk("."):
        if "_run" in root or "图谱" in root:
            continue
        for f in files:
            if not f.endswith(".md"):
                continue
            p = os.path.join(root, f)
            s = io.open(p, encoding="utf-8").read()
            if len(s) < 2 or s[0] != SL or s[-1] != SL:
                continue
            if s.count(SL) / float(len(s)) < 0.40:
                continue
            rec = unmangle(s)
            if rec is None:
                print("PARSE FAILED: " + p)
                continue
            rec = rec.replace(BS + "|", SL)     # the escaped pipes I originally meant to fix
            io.open(p, "w", encoding="utf-8", newline="\n").write(rec)
            print("recovered %s -> %d chars" % (p, len(rec)))


main()
