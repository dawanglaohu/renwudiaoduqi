"""1.7.0 回归：桌面密度契约（1.7.1 起探针命令行带 --init 登录态，停在别的地址退出码 2）。

11 节「间距与容器契约」与 handoff.design.spacing 进 S3 关卡（X21 + 五键齐）；product 语域的前端任务
提示词带间距契约与 D1–D6、实施与审查都跑 _run/density_probe.js，D2/D3/D6 不达标是审查阻断项；
brand 语域与后端任务一条都不带。探针的纯函数部分在 node 里核，DOM 部分靠真实页面验收。"""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_maintenance import fixture, hc, review, SCRIPTS
import test_prompt_routing as routing
import test_stage as stagecase
import install_project

PROBE = SCRIPTS / 'density_probe.js'
SPACING = 'DENSITY 8 → 页边距 16 · 块间距 12 · 卡片内边距 14；工作面吃满，表单列 780 靠左 + 侧栏'


def design(register='product 工作台 + 代理层', spacing=SPACING):
    d = {'register': register, 'dials': 'SOUL 6 / SPECTACLE 2 / DENSITY 8',
         'tokens': '--sp-3:12px;', 'components': '按钮高 32px'}
    if spacing is not None:
        d['spacing'] = spacing
    return d


class DensityPromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def payload(self, dz=None, frontend=('M1',)):
        payload = routing.payload_for('M1-T1', 'M1-T2', deps={'M1-T2': ['M1-T1']})
        ho = payload['pres']['handoff']
        ho['frontendModules'] = list(frontend)
        ho['design'] = design() if dz is None else dz
        return payload

    def compiled(self, payload, tid='M1-T2'):
        result = self.browser(payload)
        return result['tasks'][tid]['compiled'], result

    def test_product_frontend_impl_carries_spacing_contract_and_desktop_floor(self):
        compiled, _ = self.compiled(self.payload())
        impl = compiled['implementation']
        for needle in ('不自己编颜色、字号、圆角、间距与容器宽度', '间距与容器（DENSITY 的落地值', SPACING,
                       'D1 间距不随断点放大', 'D2 工作面', 'D3 网格列数不写死', 'D6 主区域',
                       '不调 ui-ux-pro-max、frontend-design 来定间距', 'max-w-7xl mx-auto',
                       '_run/density_probe.js', 'DENSITY: <pass | fail>', 'product-ui.md §1/§8'):
            self.assertIn(needle, impl)
        self.assertLess(impl.index('界面改动：起真实服务'), impl.index('3. 提交、推送、开 PR'))
        self.assertIn('不出预览页', impl)
        self.assertNotIn('[object Object]', impl)

    def test_product_frontend_review_runs_probe_and_blocks_d2_d3_d6(self):
        compiled, _ = self.compiled(self.payload())
        review_text = compiled['review']
        for needle in ('桌面在 1440×900 录', '在 1920×1080 与 1440×900 跑 node',
                       'D2 填充率、D3 空网格轨、D6 横向空带 fail 即阻断',
                       '桌面密度 D2/D3/D6 不达标（density_probe）', '\nDENSITY\n- 每个改到的页面',
                       '桌面密度不归它管'):
            self.assertIn(needle, review_text)
        self.assertLess(review_text.index('\nTS_CHECK\n'), review_text.index('\nDENSITY\n'))
        self.assertLess(review_text.index('\nDENSITY\n'), review_text.index('\nOUT_OF_SCOPE\n'))

    def test_brand_register_and_backend_tasks_get_no_desktop_floor(self):
        compiled, _ = self.compiled(self.payload(design(register='brand（落地页）')))
        impl, review_text = compiled['implementation'], compiled['review']
        self.assertIn('间距与容器（DENSITY 的落地值', impl)
        for text in (impl, review_text):
            self.assertNotIn('D1 间距不随断点放大', text)
            self.assertNotIn('density_probe', text)
        compiled, _ = self.compiled(self.payload(frontend=('M9',)))
        for text in (compiled['implementation'], compiled['review'], compiled['bug']):
            self.assertNotIn('density_probe', text)
            self.assertNotIn('间距与容器', text)

    def test_register_variants_and_old_projects_without_spacing(self):
        for register in ('product_workbench', '工作台（代理层）', 'h5 + product app 屏'):
            with self.subTest(register=register):
                impl = self.compiled(self.payload(design(register=register, spacing=None)))[0]['implementation']
                self.assertIn('D1 间距不随断点放大', impl)
                self.assertNotIn('间距与容器（DENSITY 的落地值', impl)
        impl = self.compiled(self.payload(design(register='commerce 商详 PDP')))[0]['implementation']
        self.assertNotIn('D1 间距不随断点放大', impl)

    def test_spacing_object_renders_one_line_per_key(self):
        dz = design(spacing={'刻度': 'DENSITY 8 → 页边距 16', '容器': '工作面吃满'})
        impl = self.compiled(self.payload(dz))[0]['implementation']
        self.assertIn('- 刻度：DENSITY 8 → 页边距 16\n- 容器：工作面吃满', impl)
        self.assertNotIn('[object Object]', impl)

    def test_kickoff_and_batch_wrapup_mention_probe(self):
        payload = self.payload()
        kick = self.run_node(['node', '-e', routing.KICKOFF], {'payload': payload, 'core': self.core})['kick']
        self.assertIn('间距与容器契约', kick)
        self.assertIn('_run/density_probe.js', kick)
        _, result = self.compiled(payload)
        self.assertIn('本批改过的界面在 1920×1080 与 1440×900 各跑一次', result['pure0'])
        self.assertIn('桌面密度不归它管，用 _run/density_probe.js', result['pure0'])
        backend = self.payload(frontend=())
        kick = self.run_node(['node', '-e', routing.KICKOFF], {'payload': backend, 'core': self.core})['kick']
        self.assertNotIn('density_probe', kick)


SEC11_NO_CONTRACT = stagecase.SEC11[:stagecase.SEC11.index('### 间距与容器契约')]


class DensityStageTests(stagecase.StageBase):
    def reach_s3(self):
        self.prepare_s1()
        self.assertEqual(stagecase.run_stage(self.doc, '--done', 'S1')[0], 0)
        self.prepare_s2()
        self.assertEqual(stagecase.run_stage(self.doc, '--done', 'S2')[0], 0)
        self.prepare_s3()

    def set_design(self, **changes):
        pres = hc.read_json(self.doc / '_run/presentation.json')
        dz = pres['handoff']['design']
        for key, value in changes.items():
            if value is None:
                dz.pop(key, None)
            else:
                dz[key] = value
        hc.write_json(self.doc / '_run/presentation.json', pres)

    def test_s3_gate_requires_spacing_key_and_contract_heading(self):
        self.reach_s3()
        saved = hc.read_json(self.doc / '_run/presentation.json')['handoff']['design']['spacing']
        self.set_design(spacing=None)
        code, out = stagecase.run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 1)
        self.assertIn('spacing', out)
        self.set_design(spacing=saved)
        stagecase.section(self.doc, 11).write_text(SEC11_NO_CONTRACT, encoding='utf-8')
        code, out = stagecase.run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 1)
        self.assertIn('X21', out)
        self.assertNotIn('S3', self.state()['stages'])
        stagecase.section(self.doc, 11).write_text(stagecase.SEC11, encoding='utf-8')
        code, out = stagecase.run_stage(self.doc, '--done', 'S3')
        self.assertEqual(code, 0, out)

    def test_prompt_s3_asks_for_spacing_contract(self):
        code, out = stagecase.run_stage(self.doc, '--prompt', 'S3')
        self.assertEqual(code, 0)
        self.assertIn('间距与容器契约', out)
        self.assertIn('spacing 五键齐', out)


class DensityReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-density-')
        self.addCleanup(self.temp.cleanup)
        self.doc = fixture(Path(self.temp.name))

    def x21(self, body):
        hc.source_file(self.doc, 11)[0].write_text(body, encoding='utf-8')
        return [i for i in review.review(str(self.doc)).items if i['code'] == 'X21']

    def test_x21_warns_for_product_ui_without_contract(self):
        head = '# UI\n\nregister 判定：product（后台）。\n\n```css\n:root { --sp-4: 16px; }\n```\n'
        found = self.x21(head)
        self.assertEqual(len(found), 1, found)
        self.assertEqual(found[0]['level'], 'WARN')
        self.assertIn('11-', found[0]['where'])
        self.assertEqual(self.x21(head + '\n### 间距与容器契约\n\nDENSITY 6 → 页边距 24。\n'), [])
        self.assertEqual(self.x21(head + '\n### Spacing and Container Contract\n\nDENSITY 6.\n'), [])
        # 围栏里的示例标题不算
        self.assertEqual(len(self.x21(head + '\n```markdown\n### 间距与容器契约\n```\n')), 1)

    def test_x21_skips_brand_only_and_not_applicable_ui(self):
        self.assertEqual(self.x21('# UI\n\nregister 判定：brand（落地页），留白是设计的一部分。\n'), [])
        self.assertEqual(self.x21('# UI\n\n不适用：纯命令行工具，没有界面。\n'), [])


class DensityProbeTests(unittest.TestCase):
    def node(self, script, env=None, args=()):
        return subprocess.run(['node'] + list(args) + ([] if script is None else ['-e', script]),
                              text=True, encoding='utf-8', capture_output=True, timeout=60,
                              env=dict(os.environ, **(env or {})))

    def test_probe_parses_and_pure_helpers_behave(self):
        self.assertEqual(self.node(None, args=['--check', str(PROBE)]).returncode, 0)
        script = r"""
const p = require(%s);
const c = p.contract({density: 8});
const base = {growth: [], emptyTracks: [], gapOffenders: [], padOffenders: [], sparseBlocks: [],
              contentFound: true, avail: {width: 1648}, interiorBand: {px: 0}};
const v = (m, type, mobile) => p.verdict(Object.assign({}, base, m), type, c, !!mobile);
process.stdout.write(JSON.stringify({
  type: typeof p, c: c, c6: p.contract({density: 6, gap: 20}),
  px: [p.spacingPx('6'), p.spacingPx('2.5'), p.spacingPx('px'), p.spacingPx('[18px]'),
       p.spacingPx('[var(--sp-4)]', n => n === '--sp-4' ? ' 16px' : ''), p.spacingPx('[calc(1px+2px)]')],
  grow: [p.growthOf(['p-4', 'sm:p-6']), p.growthOf(['gap-3', 'lg:gap-2']), p.growthOf(['sm:px-6']),
         p.growthOf(['p-4', 'sm:px-6']), p.growthOf(['-mt-4', 'sm:-mt-8']),
         p.growthOf(['pb-[calc(var(--x)+16px)]', 'sm:pb-6']), p.growthOf(['max-w-4xl', 'mx-auto', 'min-h-screen'])],
  merged: p.merge([[50, 60], [0, 10], [11, 20]], 2),
  narrow: v({fill: 0.54, leftGap: 376, rightGap: 376}, 'work'),
  full: v({fill: 0.97, leftGap: 16, rightGap: 16}, 'work'),
  formLeft: v({fill: 0.6, leftGap: 20, rightGap: 600}, 'form'),
  formCentered: v({fill: 0.6, leftGap: 330, rightGap: 330}, 'form'),
  mobile: v({fill: 0.3, leftGap: 100, rightGap: 100}, 'work', true),
  tracks: v({fill: 0.9, leftGap: 16, rightGap: 16, emptyTracks: [{wasted: 800}]}, 'work'),
  card: v({fill: 0.3, leftGap: 700, rightGap: 700}, 'card'),
  empty: v({fill: 0, leftGap: 1648, rightGap: 1648, contentFound: false}, 'work'),
  mobileSparse: v({fill: 1, leftGap: 0, rightGap: 0, sparseBlocks: [{pad: 32}], gapOffenders: [{gap: 24}]}, 'work', true),
  overflow: v({fill: 1, leftGap: 0, rightGap: 0, overflowX: 180}, 'work', true)
}));
""" % json.dumps(str(PROBE))
        result = self.node(script)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out['type'], 'function')
        self.assertEqual(out['c'], {'density': 8, 'gutter': 16, 'gap': 12, 'pad': 14})
        self.assertEqual(out['c6'], {'density': 6, 'gutter': 24, 'gap': 20, 'pad': 18})
        self.assertEqual(out['px'], [24, 10, 1, 18, 16, None])
        grow = out['grow']
        self.assertEqual(grow[0], [{'cls': 'sm:p-6', 'from': 16, 'to': 24}])
        self.assertEqual(grow[1], [])
        self.assertEqual(grow[2], [{'cls': 'sm:px-6', 'from': 0, 'to': 24}])
        self.assertEqual(grow[3], [{'cls': 'sm:px-6', 'from': 16, 'to': 24}])
        self.assertEqual(grow[4:], [[], [], []])
        self.assertEqual(out['merged'], [[0, 20], [50, 60]])
        self.assertEqual((out['narrow']['D2'], out['narrow']['D6'], out['narrow']['pass']), ('fail', 'fail', False))
        self.assertTrue(out['full']['pass'])
        self.assertEqual((out['formLeft']['D2'], out['formLeft']['pass']), ('pass', True))
        self.assertEqual(out['formCentered']['D2'], 'fail')
        self.assertEqual((out['mobile']['D1'], out['mobile']['D2'], out['mobile']['D6'], out['mobile']['pass']), ('n/a', 'n/a', 'n/a', True))
        # 手机档只作对照：D4/D5 不判，横向溢出在任何宽度都判
        self.assertEqual((out['mobileSparse']['D4'], out['mobileSparse']['D5'], out['mobileSparse']['pass']), ('n/a', 'n/a', True))
        self.assertEqual((out['overflow']['overflow'], out['overflow']['pass']), ('fail', False))
        self.assertEqual(out['full']['overflow'], 'pass')
        self.assertEqual((out['tracks']['D3'], out['tracks']['pass']), ('fail', False))
        self.assertEqual((out['card']['D2'], out['card']['D6'], out['card']['pass']), ('n/a', 'n/a', True))
        self.assertEqual(out['empty']['D2'], 'fail')
        self.assertIn('note', out['empty'])

    def test_cli_usage_and_missing_playwright_exit_2(self):
        result = self.node(None, args=[str(PROBE)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('用法', result.stderr)
        result = self.node(None, args=[str(PROBE), 'http://127.0.0.1:9/', '--type', 'work', '--viewports', '1920'])
        self.assertEqual(result.returncode, 2)
        result = self.node(None, args=[str(PROBE), 'http://127.0.0.1:9/', '--type', 'work'],
                           env={'DENSITY_PROBE_PLAYWRIGHT': 'no-such-playwright-for-density-test'})
        self.assertEqual(result.returncode, 2)
        self.assertIn('找不到 playwright', result.stderr)

    def fake_playwright(self, tmp):
        """假的 playwright：记录 addInitScript、量了哪个地址、有没有关浏览器；goto 之后 url() 返回
        FAKE_PW_LANDED（缺省就是原地址），用来模拟登录守卫把页面转走。"""
        mod = Path(tmp) / 'fake_playwright.js'
        mod.write_text(r"""
const fs = require('fs');
const log = (s) => fs.appendFileSync(process.env.FAKE_PW_LOG, s + '\n');
module.exports = {chromium: {launch: async () => ({
  newContext: async (opts) => ({
    addInitScript: async (s) => log('init ' + opts.viewport.width + ' ' + s.content),
    newPage: async () => {
      let cur = null;
      return {
        goto: async (u) => { cur = process.env.FAKE_PW_LANDED || u; },
        waitForSelector: async () => { throw new Error('selector timeout'); },
        waitForTimeout: async () => {},
        url: () => cur,
        evaluate: async () => { log('measure ' + cur); return {url: cur, verdict: {pass: true}}; },
        screenshot: async () => {}
      };
    },
    close: async () => {}
  }),
  close: async () => log('closed')
})}};
""", encoding='utf-8')
        return mod

    def run_cli(self, tmp, url, *extra, landed=None):
        log = Path(tmp) / 'log.txt'
        if log.exists():
            log.unlink()
        env = {'DENSITY_PROBE_PLAYWRIGHT': str(self.fake_playwright(tmp)), 'FAKE_PW_LOG': str(log)}
        if landed:
            env['FAKE_PW_LANDED'] = landed
        result = self.node(None, args=[str(PROBE), url, '--type', 'work', '--viewports', '1920x1080,390x844'] + list(extra), env=env)
        return result, (log.read_text(encoding='utf-8').splitlines() if log.exists() else [])

    def test_cli_init_script_runs_before_page_scripts(self):
        with tempfile.TemporaryDirectory(prefix='density-cli-') as tmp:
            init = Path(tmp) / 'init.js'
            init.write_text("sessionStorage.setItem('agsched.token', 'T');", encoding='utf-8')
            result, log = self.run_cli(tmp, 'http://127.0.0.1:9/#/', '--init', str(init))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([r['url'] for r in json.loads(result.stdout)], ['http://127.0.0.1:9/#/'] * 2)
            self.assertEqual(log, ["init 1920 sessionStorage.setItem('agsched.token', 'T');", 'measure http://127.0.0.1:9/#/',
                                   "init 390 sessionStorage.setItem('agsched.token', 'T');", 'measure http://127.0.0.1:9/#/',
                                   'closed'])
            # 读不到 --init 脚本是用法错误，不开浏览器
            result, log = self.run_cli(tmp, 'http://127.0.0.1:9/#/', '--init', str(Path(tmp) / 'missing.js'))
            self.assertEqual(result.returncode, 2)
            self.assertIn('--init', result.stderr)
            self.assertEqual(log, [])

    def test_cli_redirect_measures_nothing_and_exits_2(self):
        with tempfile.TemporaryDirectory(prefix='density-cli-') as tmp:
            result, log = self.run_cli(tmp, 'http://127.0.0.1:9/#/', landed='http://127.0.0.1:9/#/pair')
            self.assertEqual(result.returncode, 2)
            self.assertIn('http://127.0.0.1:9/#/pair', result.stderr)
            self.assertIn('--init', result.stderr)
            self.assertEqual(log, ['closed'])
            # --wait 等不到选择器时先看是不是被转走了，报跳转而不是超时
            result, log = self.run_cli(tmp, 'http://127.0.0.1:9/#/', '--wait', 'main', landed='http://127.0.0.1:9/#/pair')
            self.assertEqual(result.returncode, 2)
            self.assertIn('--init', result.stderr)
            self.assertNotIn('selector timeout', result.stderr)
            # 末尾斜杠、hash 路由里的查询串不算跳转
            for url, landed in (('http://127.0.0.1:9', 'http://127.0.0.1:9/#/'),
                                ('http://127.0.0.1:9/#/?pane=tasks', 'http://127.0.0.1:9/#/?pane=tasks&x=1'),
                                ('http://127.0.0.1:9/app/', 'http://127.0.0.1:9/app')):
                result, log = self.run_cli(tmp, url, landed=landed)
                self.assertEqual(result.returncode, 0, (url, landed, result.stderr))
                self.assertEqual(log[-1], 'closed')


class DensityReleaseTests(unittest.TestCase):
    def test_installer_ships_probe_regression_and_version(self):
        self.assertEqual(hc.VERSION, '1.7.2')
        self.assertIn('density_probe.js', install_project.RUNTIME)
        self.assertIn('test_release_1_7_density.py', install_project.TESTS)
        with tempfile.TemporaryDirectory(prefix='skill-density-install-') as tmp:
            base = Path(tmp) / 'proj'
            base.mkdir()
            doc = fixture(base)
            with contextlib.redirect_stdout(io.StringIO()):
                install_project.install(doc, root=base)
            self.assertEqual((doc / '_run/density_probe.js').read_bytes().replace(b'\r\n', b'\n'),
                             PROBE.read_bytes().replace(b'\r\n', b'\n'))
            self.assertTrue((doc / '_run/tests/test_release_1_7_density.py').exists())


if __name__ == '__main__':
    unittest.main()
