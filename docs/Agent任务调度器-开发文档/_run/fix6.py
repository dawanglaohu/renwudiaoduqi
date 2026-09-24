import io

D = "D:/workspace/renwudiaoduqi/docs/Agent任务调度器-开发文档/"
p = D + "02-设计/10-接口约定.md"

lines = io.open(p, encoding="utf-8").read().split("\n")
out = []
n = 0
for ln in lines:
    st = ln.strip()
    if st.startswith("| `E_") and st.endswith("|"):
        cells = [c for c in st.split("|")]
        # cells[0] == '' ; cells[1] == ' `E_X` ' ; cells[2] == ' 400 ' ...
        if len(cells) >= 5 and "origin" not in ln:
            cells.insert(2, " server ")
            ln = "|".join(cells)
            n += 1
    out.append(ln)

extra = [
    "| `E_INVALID_STATE_TRANSITION` | server | 500 | 否 | 状态机白名单之外的迁移，属实现缺陷（09 节） |",
    "| `E_GATE_ALREADY_DECIDED` | server | 409 | 否 | 闸门已由另一端确认，返回既有记录（E-57） |",
    "| `E_LOG_PURGED` | server | 410 | 否 | 会话正文已被保留策略清理，与「文件丢失」区分（E-221） |",
    "| `E_DEVICE_REVOKED` | server | 401 | 否 | 该设备令牌已被吊销（E-127） |",
    "| `E_NETWORK` | client | — | 是 | 网络不可达，**由前端产生**，daemon 侧不注册 |",
    "| `E_TIMEOUT` | client | — | 是 | 请求超时，**由前端产生** |",
    "| `E_SHELL_UNAVAILABLE` | client | — | 否 | 壳能力缺失（无原生通知或安全存储），**由前端产生** |",
]

final = []
for ln in out:
    if ln.strip().startswith("| `E_INTERNAL`"):
        final.extend(extra)
    final.append(ln)

io.open(p, "w", encoding="utf-8", newline="\n").write("\n".join(final))
print("origin column added to %d rows; %d new codes appended" % (n, len(extra)))
