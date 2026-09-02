import io, os

D = "."
BAD = "�"

print("=== U+FFFD occurrences ===")
hits = []
for root, _, files in os.walk(D):
    if "_run" in root or "图谱" in root:
        continue
    for f in sorted(files):
        if not f.endswith(".md"):
            continue
        p = os.path.join(root, f)
        for i, ln in enumerate(io.open(p, encoding="utf-8").read().splitlines(), 1):
            if BAD in ln:
                hits.append((p, i))
                # show a tight window around each bad char
                for j, ch in enumerate(ln):
                    if ch == BAD:
                        print("%-44s %4d  ...%s..." % (p, i, ln[max(0, j - 14): j + 14]))
                        break
print("lines with U+FFFD: %d" % len(hits))
