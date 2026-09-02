import io, os, re

BS = chr(92)
D = "."

print("=== every line containing a backslash (recovered files) ===")
n = 0
for root, _, files in os.walk(D):
    if "_run" in root or "图谱" in root:
        continue
    for f in sorted(files):
        if not f.endswith(".md"):
            continue
        p = os.path.join(root, f)
        for i, ln in enumerate(io.open(p, encoding="utf-8").read().splitlines(), 1):
            if BS in ln:
                n += 1
                print("%-42s %4d  %s" % (p, i, ln.strip()[:110]))
print("total lines with backslash: %d" % n)

print()
print("=== suspicious double-slash outside URLs / code fences ===")
m = 0
for root, _, files in os.walk(D):
    if "_run" in root or "图谱" in root:
        continue
    for f in sorted(files):
        if not f.endswith(".md"):
            continue
        p = os.path.join(root, f)
        fence = False
        for i, ln in enumerate(io.open(p, encoding="utf-8").read().splitlines(), 1):
            if ln.lstrip().startswith("```"):
                fence = not fence
                continue
            for mt in re.finditer(r"//", ln):
                seg = ln[max(0, mt.start() - 12): mt.start() + 12]
                if "http" in seg or "://" in seg:
                    continue
                m += 1
                print("%-42s %4d  ...%s..." % (p, i, seg))
print("suspicious '//' occurrences: %d" % m)
