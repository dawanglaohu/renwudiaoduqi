import io

D = "D:/workspace/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

def patch(path, pairs, required=True):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    o = s
    for a, b in pairs:
        if required and a not in s:
            raise SystemExit("anchor missing in %s: %s" % (path, a[:60]))
        s = s.replace(a, b)
    if s != o:
        io.open(p, "w", encoding="utf-8", newline="\n").write(s)
        print("patched " + path)

# 1) 边界台账：去掉会被误判为占位符的写法（源头改，13 节随后重生成）
patch("_run/edges.md", [
    ("<JSON 字面量>", "〈JSON 字面量〉"),
    ("含未知占位符或括号未闭合", "含未知模板变量或括号未闭合"),
])

# 2) 决策台账：同上
patch("_run/decisions.md", [
    ("%APPDATA%/<app>/", "%APPDATA%/〈app〉/"),
    ("<app>", "〈app〉"),
], required=False)

# 3) 08 节：泛型写法改成中文描述
patch("02-设计/08-后端架构.md", [
    ("`CODE_TO_STATUS: Record<ErrorCode, number>`",
     "`CODE_TO_STATUS`（一张 `ErrorCode` → HTTP 状态码的常量表）"),
])

# 4) 19 节：去掉主观词，并给三个任务补边界引用
patch("04-执行/19-模块任务拆分.md", [
    ("3) 重跑时原 agent 不在线则快速失败并明示",
     "3) 重跑时原 agent 不在线则立即失败并明示"),
    ("4) 不注册 `@fastify/cors`；代码中出现即判失败 | 1.5d |",
     "4) 不注册 `@fastify/cors`；代码中出现即判失败 "
     "5) 错误信封的 `details` 字段能承载结构化信息（如实测版本串与期望模式），"
     "供前端就地渲染而不必解析 message（E-195） | 1.5d |"),
    ("4) 与社区同名 CLI 的区分由 M4-T3 的指纹探测负责，本任务不再判定 | 1.5d |",
     "4) 与社区同名 CLI 的区分由 M4-T3 的指纹探测负责，本任务不再判定 "
     "5) 该家拿不到 token 用量时字段置 null 由上层显示「—」，**不得填 0**（E-26） | 1.5d |"),
    ("5) 键盘焦点用**内嵌环**，滚动列表不整体抖 | 2d |",
     "5) 键盘焦点用**内嵌环**，滚动列表不整体抖 "
     "6) 轨段形态与状态徽标共用同一张形状枚举，状态区分不只靠色相（E-110）；"
     "「失联」「审查未完成」等态各有专属形状而非复用失败形状（E-230） | 2d |"),
])

print("done")
