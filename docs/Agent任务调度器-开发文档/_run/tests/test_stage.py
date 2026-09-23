"""分阶段运行器（stage.py）的回归：关卡判定、--done 只在过关时写 stage.json、提示词打印、
不存在的目录只允许 --prompt S1、check_stale 打印「停在 S<n>」。夹具沿用 test_maintenance.fixture()，
按阶段逐步补成能过关的样子，整条 S1→S6 走一遍。"""
import contextlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
if (SCRIPTS / 'scripts').is_dir():
    SCRIPTS = SCRIPTS / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_stale
import handoff_contract as hc
import install_project
import maintain_docs as maintenance
import stage
from test_maintenance import fixture

EDGES = 16
DECISIONS = ('| # | 问题 | 评审 | 选定 | 理由 | 边界编号 | 隐含假设 | 置信 |\n'
             '|---|---|---|---|---|---|---|---|\n'
             '| 1 | 用什么语言 | sound | TypeScript | 原话没说，按 05 节 | E-01 | 无 | high |\n')


def run_stage(*args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = stage.main([str(a) for a in args])
    return code, buf.getvalue()


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def section(doc, num):
    return hc.source_file(doc, num)[0]


def append(doc, num, text):
    p = section(doc, num)
    p.write_text(p.read_text(encoding='utf-8') + text, encoding='utf-8')


def edges_text(n):
    head = '# 边界情况登记簿\n\n| 编号 | 场景 | 触发条件 | 期望行为 | 相关决策 |\n|---|---|---|---|---|\n'
    return head + ''.join('| E-%02d | 空输入%d | 长度为零 | 返回空字符串 | 1 |\n' % (i, i) for i in range(1, n + 1))


SEC06 = """# 系统架构与模块划分

| ID | 职责 | 依赖 |
|---|---|---|
| M1 | 字符串处理 | 无 |

## 全项目共用约定

- 错误体系：错误码枚举定义在 `src/shared/errors.ts`，前后端共享；只有 `src/http/` 层把错误转 HTTP 状态码。
- 环境变量：集中在 `src/config.ts` 声明并校验，业务代码禁止直接读 `process.env`。
- 共享类型：接口出入参类型在 `src/shared/types.ts`，与 10 节同源。
- 命名与格式：文件 kebab-case，常量 UPPER_SNAKE，eslint 与 prettier 在 pre-commit 拦。

## 接线注册表

- backendRoutes：`src/http/routes.ts`
- container：`src/container.ts`
"""

SEC07 = """# 前端架构

目录结构：

```text
src/
├── components/   展示组件，禁止直接调 src/api/
├── pages/        页面容器
├── api/          API 客户端层，统一封装 fetch 与错误冒泡
├── store/        状态管理：全局态只放会话与偏好
└── lib/          工具层：纯函数，带请求或状态的不许进
```

组件库用 shadcn，二次封装放 `src/components/ui/`，业务组件不直接引原始组件。
"""

SEC08 = """# 后端架构

```text
src/
├── http/         路由与 handler
├── service/      业务逻辑，事务只在这一层开
├── repo/         数据层：裸 SQL 只允许在这里
└── jobs/         后台任务
```

分层与调用方向：http → service → repo，单向，禁止 repo 反向调 service。
数据层：迁移只走 `db/migrations/`；事务由 service 开，不跨层。
"""

SEC09 = """# 数据模型

| 实体 | 字段 | 类型 | 约束 |
|---|---|---|---|
| Sample | id | string | 主键 |
| Sample | text | string | 非空 |
"""

SEC10 = """# 接口约定

| 方法 | 路径 | 入参 | 返回 | 权限 |
|---|---|---|---|---|
| POST | /api/strings/trim | text | text | 匿名 |

请求/响应示例：

```json
{"ok": true, "data": {"text": "abc"}}
```

## 错误码表

| 错误码 | HTTP | 含义 |
|---|---|---|
| E_EMPTY_INPUT | 400 | 输入为空 |
"""

SEC11 = """# UI

register 判定：product（后台）——围着一批字符串样本转，中性即可。

## 视觉方向

```css
:root { --brand: #1F3A5F; --radius: 6px; --space: 8px; }
```

组件规范：按钮高 32px，圆角 6px，禁用态 40% 透明。
"""

SEC12 = """# UX

关键流程：输入 → 校验 → 返回；失败路径返回 E_EMPTY_INPUT 并在输入框下方提示（E-01）。
"""


class StageBase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-stage-')
        self.base = Path(self.temp.name) / 'proj'
        self.base.mkdir()
        self.doc = fixture(self.base)
        self.addCleanup(self.temp.cleanup)

    def state(self):
        return hc.read_json(self.doc / '_run/stage.json')

    def install(self):
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=self.base)

    def prepare_s1(self, edges=True):
        self.install()
        run = self.doc / '_run'
        write(run / 'context.md', '# 原始需求（逐字原文，禁止改写、禁止润色）\n'
              + '做一个字符串处理工具，不要问我，你自己定。' * 6
              + '\n\n# 交付物\n24 节开发文档 + 模块任务拆分 + HTML 阅读器\n\n# 已知硬约束\n无\n')
        write(run / 'candidates.md', '# 候选能力清单\n\nNO_CANDIDATES\n')
        write(run / 'decisions.md', DECISIONS)
        if edges:
            write(run / 'edges.md', edges_text(EDGES))
        for n in (1, 2, 3, 4):
            append(self.doc, n, '\n' + '本节正文按关卡要求补足到最小体积，内容为可直接实施的约束。' * 4 + '\n')
        section(self.doc, 5).write_text(
            '# 技术栈\n\n语言 TypeScript，运行时 Node 20，构建 tsup，测试 vitest；每项一句理由：与阅读器同栈，'
            '团队现有技能覆盖，不引入第二套工具链。\n\n## 被否方案\n\nPython：否决，原话要求与阅读器同一技术栈。\n',
            encoding='utf-8')

    def prepare_s2(self, wiring=True):
        for num, text in ((6, SEC06), (7, SEC07), (8, SEC08), (9, SEC09), (10, SEC10)):
            section(self.doc, num).write_text(text, encoding='utf-8')
        pres = hc.read_json(self.doc / '_run/presentation.json')
        pres['handoff']['architecture'] = {
            'shared': {'errors': '错误码枚举在 src/shared/errors.ts', 'env': '集中在 src/config.ts',
                       'types': 'src/shared/types.ts', 'naming': 'kebab-case'},
            'frontend': {'layout': 'src/components 展示、src/pages 容器', 'api': 'src/api 统一封装'},
            'backend': {'layers': 'http → service → repo 单向', 'tx': '事务只在 service 开'}}
        if wiring:
            pres['handoff']['wiring'] = {'backendRoutes': 'src/http/routes.ts', 'container': 'src/container.ts'}
        else:
            pres['handoff'].pop('wiring', None)
        hc.write_json(self.doc / '_run/presentation.json', pres)

    def prepare_s3(self):
        section(self.doc, 11).write_text(SEC11, encoding='utf-8')
        section(self.doc, 12).write_text(SEC12, encoding='utf-8')
        pres = hc.read_json(self.doc / '_run/presentation.json')
        pres['handoff']['design'] = {'register': 'product 后台', 'dials': 'SOUL 2 / SPECTACLE 1 / DENSITY 4',
                                     'tokens': ':root { --brand: #1F3A5F; }', 'components': '按钮高 32px'}
        pres['handoff']['frontendModules'] = ['M1']
        hc.write_json(self.doc / '_run/presentation.json', pres)

    def prepare_s4(self):
        append(self.doc, 17, '\n端到端冒烟：真起服务，浏览器打开首页，断言 token 的 computed style，调用真实接口并收到真实事件；CI 运行。\n')
        append(self.doc, 15, '\n用户量与并发：未评估。\n')
        append(self.doc, 18, '\n## 分发形态\n\nnpm 包 + 单文件可执行，发布走 GitHub Release。\n')


class StageWalkTests(StageBase):
    def test_walk_s1_to_s6_with_gate_failures(self):
        # S1：缺 edges.md 不过，且不写 stage.json；补齐后通过并写 next: S2
        self.prepare_s1(edges=False)
        code, out = run_stage(self.doc, '--done', 'S1')
        self.assertEqual(code, 1)
        self.assertIn('edges.md', out)
        self.assertFalse((self.doc / '_run/stage.json').exists())
        write(self.doc / '_run/edges.md', edges_text(EDGES))
        code, out = run_stage(self.doc, '--done', 'S1')
        self.assertEqual(code, 0, out)
        st = self.state()
        self.assertEqual(st['next'], 'S2')
        self.assertEqual(st['schemaVersion'], 1)
        self.assertEqual(st['stages']['S1']['sourceVersion'], hc.source_version(self.doc))
        self.assertIn('/unattended-run S2 ' + self.doc.resolve().as_posix(), out)
        self.assertIn('--done S2', out)

        # S2：没填 wiring 不过；填了通过
        self.prepare_s2(wiring=False)
        code, out = run_stage(self.doc, '--done', 'S2')
        self.assertEqual(code, 1)
        self.assertIn('wiring', out)
        self.assertEqual(self.state()['next'], 'S2')
        self.prepare_s2(wiring=True)
        code, out = run_stage(self.doc, '--done', 'S2')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.state()['next'], 'S3')

        # S3：11 节有 register 与 token，design 四键齐
        self.prepare_s3()
        code, out = run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 0, out)

        # S4：13 节多出一条 edges.md 没有的 E-17 → 不一致；还原后通过
        p13 = section(self.doc, 13)
        original = p13.read_text(encoding='utf-8')
        p13.write_text(original + '| E-17 | 多出来的 | 无 | 返回空字符串 | M1 |\n', encoding='utf-8')
        self.prepare_s4()
        code, out = run_stage(self.doc, '--done', 'S4')
        self.assertEqual(code, 1)
        self.assertIn('E-17', out)
        p13.write_text(original, encoding='utf-8')
        code, out = run_stage(self.doc, '--done', 'S4')
        self.assertEqual(code, 0, out)

        # S5：review 有 BLOCK（H04 未声明有效改动路径）不过；还原后通过
        pres = hc.read_json(self.doc / '_run/presentation.json')
        saved = pres['handoff']['taskPaths']['M1-T1']
        pres['handoff']['taskPaths']['M1-T1'] = []
        hc.write_json(self.doc / '_run/presentation.json', pres)
        code, out = run_stage(self.doc, '--done', 'S5')
        self.assertEqual(code, 1)
        self.assertIn('H04', out)
        self.assertIn('M1-T1', out)
        self.assertNotIn('S5', self.state()['stages'])
        pres['handoff']['taskPaths']['M1-T1'] = saved
        hc.write_json(self.doc / '_run/presentation.json', pres)
        code, out = run_stage(self.doc, '--done', 'S5')
        self.assertEqual(code, 0, out)

        # S6：没 build 不过；build 后通过，next 变 done，报告说全部完成
        code, out = run_stage(self.doc, '--done', 'S6')
        self.assertEqual(code, 1)
        self.assertIn('build-manifest', out)
        with contextlib.redirect_stdout(io.StringIO()):
            maintenance.build(self.doc)
        code, out = run_stage(self.doc, '--done', 'S6')
        self.assertEqual(code, 0, out)
        st = self.state()
        self.assertEqual(st['next'], 'done')
        self.assertEqual(sorted(st['stages']), list(stage.STAGES))
        code, out = run_stage(self.doc)
        self.assertEqual(code, 0)
        self.assertIn('全部完成', out)
        self.assertNotIn('/unattended-run', out)


class StageS3GateTests(StageBase):
    """S3 只出取值不出页面：11 节不许写目视确认闸门，文档目录与项目根下不许有 _preview/。"""

    def reach_s3(self):
        self.prepare_s1()
        self.assertEqual(run_stage(self.doc, '--done', 'S1')[0], 0)
        self.prepare_s2()
        self.assertEqual(run_stage(self.doc, '--done', 'S2')[0], 0)
        self.prepare_s3()

    def test_section_11_with_visual_confirmation_gate_fails_s3(self):
        self.reach_s3()
        append(self.doc, 11, '\n验收前置：第一个前端任务先出一屏真页给用户目视确认再定方向。\n')
        code, out = run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 1)
        self.assertIn('真页', out)
        self.assertIn('目视确认', out)
        self.assertNotIn('S3', self.state()['stages'])
        section(self.doc, 11).write_text(SEC11, encoding='utf-8')
        code, out = run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 0, out)

    def test_preview_dir_fails_s3(self):
        self.reach_s3()
        root_preview = self.base / '_preview'
        write(root_preview / 'run-deck.html', '<html></html>')
        code, out = run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 1)
        self.assertIn('_preview', out)
        self.assertNotIn('S3', self.state()['stages'])
        shutil.rmtree(root_preview)
        docs_preview = self.doc / '_preview'
        write(docs_preview / 'index.html', '<html></html>')
        code, out = run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 1)
        self.assertIn('_preview', out)
        shutil.rmtree(docs_preview)
        code, out = run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 0, out)
        self.assertEqual(self.state()['next'], 'S4')

    def test_prompt_s3_forbids_page_files(self):
        code, out = run_stage(self.doc, '--prompt', 'S3')
        self.assertEqual(code, 0)
        self.assertIn('_preview/', out)
        self.assertIn('真屏', out)


class StageCommandTests(StageBase):
    def test_done_out_of_order_is_refused(self):
        code, out = run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 1)
        self.assertIn('S1', out)
        self.assertFalse((self.doc / '_run/stage.json').exists())

    def test_report_marks_next_stage_and_source_drift(self):
        self.prepare_s1()
        self.assertEqual(run_stage(self.doc, '--done', 'S1')[0], 0)
        code, out = run_stage(self.doc)
        self.assertEqual(code, 0)
        self.assertIn('S1 需求裁决：done', out)
        self.assertIn('S2 架构与契约：pending  ← 下一步', out)
        self.assertIn('/unattended-run S2 ' + self.doc.resolve().as_posix(), out)
        self.assertNotIn('源已变化', out)
        append(self.doc, 1, '\n改了 01 节。\n')
        code, out = run_stage(self.doc)
        self.assertEqual(code, 0)
        self.assertIn('源已变化', out)
        self.assertEqual(self.state()['next'], 'S2')

    def test_prompt_s3_contains_command_and_absolute_path(self):
        code, out = run_stage(self.doc, '--prompt', 'S3')
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith('/unattended-run S3 ' + self.doc.resolve().as_posix()), out)
        self.assertIn('references/stages.md 的 S3 段', out)
        self.assertIn('"' + self.doc.resolve().as_posix() + '/_run/stage.py"', out)
        self.assertIn('--done S3', out)
        self.assertNotIn('<在此粘贴用户原话>', out)

    def test_missing_docs_only_allows_prompt_s1(self):
        missing = Path(self.temp.name) / 'nope' / '文档'
        code, out = run_stage(missing, '--prompt', 'S1')
        self.assertEqual(code, 0)
        self.assertIn('/unattended-run S1 ' + missing.resolve().as_posix(), out)
        self.assertIn('<在此粘贴用户原话>', out)
        self.assertIn('install_project.py', out)
        self.assertEqual(run_stage(missing, '--prompt', 'S2')[0], 2)
        self.assertEqual(run_stage(missing)[0], 2)
        self.assertEqual(run_stage(missing, '--done', 'S1')[0], 2)
        self.assertFalse(missing.exists())
        self.assertEqual(run_stage(self.doc, '--prompt', 'S9')[0], 2)
        self.assertEqual(run_stage(self.doc, '--bogus', 'S1')[0], 2)

    def test_script_runs_standalone_and_import_has_no_side_effects(self):
        before = sorted(p.name for p in self.base.iterdir())
        run = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(SCRIPTS / 'stage.py')],
                             cwd=str(self.base), capture_output=True, text=True, encoding='utf-8', timeout=60)
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn('--prompt S<n>', run.stdout)
        run = subprocess.run([sys.executable, '-X', 'utf8', '-B', str(SCRIPTS / 'stage.py'),
                              str(Path(self.temp.name) / 'absent'), '--prompt', 'S1'],
                             cwd=str(self.base), capture_output=True, text=True, encoding='utf-8', timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('/unattended-run S1 ', run.stdout)
        self.assertEqual(before, sorted(p.name for p in self.base.iterdir()))
        self.assertFalse((self.doc / '_run/stage.json').exists())

    def test_check_stale_prints_where_generation_stopped(self):
        hc.write_json(self.doc / '_run/stage.json', {'schemaVersion': 1, 'next': 'S3', 'stages': {
            'S1': {'done': '2026-09-18T00:00:00+00:00', 'sourceVersion': 'x'},
            'S2': {'done': '2026-09-18T00:00:00+00:00', 'sourceVersion': 'x'}}})
        cwd = os.getcwd()
        os.chdir(str(self.base))
        self.addCleanup(os.chdir, cwd)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            check_stale.main()
        out = buf.getvalue()
        # 与同一脚本里 [文档维护] 行的写法一致：路径相对当前目录（Stop hook 在项目根跑）
        rel = (Path('docs') / self.doc.name).as_posix()
        self.assertIn('[文档生成] ' + str(Path('docs') / self.doc.name) + '：停在 S3，下一步 python "'
                      + rel + '/_run/stage.py" "' + rel + '"', out)
        hc.write_json(self.doc / '_run/stage.json', {'schemaVersion': 1, 'next': 'done', 'stages': {}})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            check_stale.main()
        self.assertNotIn('停在', buf.getvalue())


if __name__ == '__main__':
    unittest.main()
