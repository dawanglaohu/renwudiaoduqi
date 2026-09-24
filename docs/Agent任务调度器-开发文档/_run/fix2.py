import io

D = "D:/workspace/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

def patch(path, pairs):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit("anchor missing in %s:\n%s" % (path, a[:90]))
        s = s.replace(a, b, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched " + path)

# 06 节：表头首格若写成 M1，会被解析器 fullmatch 成第 11 个模块
patch("02-设计/06-系统架构与模块划分.md", [
    ("| M1 | 职责 | 依赖 |", "| 模块 | 职责 | 依赖 |"),
])

# 20 节：批次行的首格必须能被 fullmatch，昵称移到「结束时可演示」列
patch("04-执行/20-里程碑与交付顺序.md", [
    ("| 第一批 | 模块 | 人天 | 结束时可演示 |", "| 批次 | 模块 | 人天 | 结束时可演示 |"),
    ("| 第一批 · 跑起来 | M1 | 12.5 | daemon 能启动",
     "| 第一批 | M1 | 12.5 | **跑起来**——daemon 能启动"),
    ("| 第二批 · 连得上 | M2, M3 | 17.0 | 用 curl 完成配对",
     "| 第二批 | M2, M3 | 17.0 | **连得上**——用 curl 完成配对"),
    ("| 第三批 · 派得出去 | M4, M5 | 24.5 | **四个 agent 各派一个真任务并跑完**",
     "| 第三批 | M4, M5 | 24.5 | **派得出去**——四个 agent 各派一个真任务并跑完"),
    ("| 第四批 · 看得见 | M6 | 13.5 | 完整的运行状态机跑通",
     "| 第四批 | M6 | 13.5 | **看得见**——完整的运行状态机跑通"),
    ("| 第五批 · 自动起来 | M7, M8 | 13.0 | **半自动跑完一整批**",
     "| 第五批 | M7, M8 | 13.0 | **自动起来**——半自动跑完一整批"),
    ("| 第六批 · 两个端 | M9, M10 | 35.0 | 桌面端多流并置",
     "| 第六批 | M9, M10 | 35.0 | **两个端**——桌面端多流并置"),
])
print("done")
