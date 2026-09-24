import io

D = "D:/workspace/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

def patch(path, pairs):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit("ANCHOR MISSING in %s:\n---\n%s\n---" % (path, a[:160]))
        s = s.replace(a, b, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched " + path)

CONCLUSION = """## 结论先行：桌面版能不能被外部发派？

**原始需求第 4 点问的就是这个。答案分两半，两半都要说清楚。**
（核对时间：2026-08-31。本结论**只在此处维护**，其他小节交叉引用而不复述。）

**一、两个桌面 GUI 都不能被外部直接发派任务。**

- **codex 桌面版**——它其实就是 ChatGPT 桌面 app 里的一个模式，不是独立产品。
  有 `codex://` deep link，但官方明文写着它**只把内容填进输入框、不会自动发送**。
  〔证据强度：**官方明文**〕
- **claude 桌面端**——官方对照表逐字写着 `--print` / `--output-format` →
  "Not available. Desktop is interactive only."，以及
  "Scripting and automation | Desktop: **Not available**"。
  〔证据强度：**官方明文**〕

**二、但这不影响本产品，因为每家都有官方的 headless 引擎，而且会话与 GUI 互通。**

本产品统一走各家的 **CLI / daemon 通道**——下表里那四个可执行文件就是通道本体。
更要紧的是：**headless 跑出来的会话可以在对应的 GUI 里打开继续**
（codex 用 `codex://threads/〈id〉` 或 TUI 内 `/app`；claude 用 TUI 内 `/desktop`）。
所以实际形态是「**后台派活跑完，想深入时切到 GUI 接手**」，桌面版并没有白装。
〔证据强度：**官方文档**；本机未逐条实测〕

**三、一条相关的推断，不要当事实用。**

`codex agents` 的 help 文本称它浏览「共享本地 app-server daemon」上的所有会话，
且 `~/.codex/config.toml` 里确有 `[desktop]` 段——这**暗示**桌面 app 与 CLI 共用同一个
daemon 与同一份配置。〔证据强度：**仅 help 文本佐证，本机未实测，属推断**〕
**本产品不得有任何任务的验收条件依赖这一条**（E-251）；
真被证伪时只需删掉这一句，不触发返工。

完整引文与出处见 24 节；下面两张表是本机 `--help` 与配置文件的一手实测。

"""

patch("01-约束/04-开发条件.md", [
    ("## 被调度的 agent（本机实测已装 4 个）", CONCLUSION + "## 被调度的 agent（本机实测已装 4 个）"),
    # 修正「四个都支持调用方指定 session-id」这句夸大
    ("四个都支持**由调用方指定 session-id** 与恢复 / 分叉，这是调度器能回读会话的前提。",
     "**claude / pi / grok 三家支持由调用方指定 session-id**；\n**codex 不支持**——它只提供 `codex exec resume 〈id〉` / `fork`，认的是它自己生成的 thread id，\n所以 codex 适配器必须**另存一份「任务 id ↔ thread id」映射**才能回读（这是 M4-T8 的隐含产出）。\n四家都支持恢复 / 分叉，这是调度器能回读会话的共同前提。"),
])
