#!/usr/bin/env python3
"""TypeSafe（System One）判断调用器：主会话与子代理都用它，不各自拼请求。

    python typesafe_ask.py check                         # 密钥找得到、接口通不通（GET /v1/models）
    python typesafe_ask.py templates                     # 十一套校准模板 + 两套最终裁决模板及各自 state 键
    python typesafe_ask.py run <模板> --state s.json     # 按模板拼问题、发一次请求、给 verdicts
    python typesafe_ask.py ask --input req.json          # 原始请求 {state, questions[, model]}
    python typesafe_ask.py run adjudicate --state s.json # S7 实施/审查/查 bug/收口碰到岔路口：Jev 裁决，不问人
    python typesafe_ask.py run design --state s.json     # S3 finesse-ui 交回的视觉岔路口：Jev 裁决，不问人

密钥查找顺序（找到第一个非空就停）：--key → 环境变量 TYPESAFE_API_KEY → 环境变量 TYPESAFE_ENV_FILE 指的文件
→ ~/.typesafe/.env → ~/.claude/skills/unattended-run/.env → 本脚本所在技能目录的 .env（scripts/ 的上一级）。
.env 只认 KEY=VALUE 行（允许 export 前缀与引号）。找不到密钥不报错：输出 {"status":"skipped"} 并以退出码 2 结束，
调用方照常往下走，把 TS_CHECK 记成 skipped——判断层是校准过的第二意见，从不阻塞流程。

只用标准库，兼容 Python 3.8；429/529 按退避重试；state 超过上限直接拒绝（先在代码里过滤，别把整篇文档塞进去）。
state 默认写英文：Jev 英文最准，中文能用但准度低；state 里中文字符占比超过 15% 时输出带 language_warning（不拒绝）。
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_BASE = 'https://api.typesafe.ai'
DEFAULT_MODEL = 'jev-latest'
MAX_STATE_CHARS = 60000       # 约 32k token 的保守上限；Jev 对无关细节敏感，越短越准
HIGH, MEDIUM = 0.75, 0.5      # choice/score 的 confidence 分档
YES, NO = 0.65, 0.35          # noul 的三态分界
CJK_WARN_RATIO = 0.15         # state 里 CJK 字符占字母类字符的比例超过它就提醒改英文
ENV_VAR = 'TYPESAFE_API_KEY'
SKIPPED_EXIT = 2

# ---------- 密钥 ----------


def parse_env_file(path):
    values = {}
    try:
        text = Path(path).read_text(encoding='utf-8-sig')
    except (OSError, UnicodeDecodeError):
        return values
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        if line.startswith('export '):
            line = line[len('export '):].strip()
        key, value = line.split('=', 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        values[key.strip()] = value
    return values


def key_candidates(script_dir=None, env=None):
    env = os.environ if env is None else env
    script_dir = Path(script_dir).resolve() if script_dir else Path(__file__).resolve().parent
    out = []
    explicit = env.get('TYPESAFE_ENV_FILE')
    if explicit:
        out.append(Path(explicit))
    home = Path.home()
    out.append(home / '.typesafe' / '.env')
    out.append(home / '.claude' / 'skills' / 'unattended-run' / '.env')
    # WSL 侧跑 codex 时 Linux home 里没有 .env：回退到 Windows 用户目录下的全局文件
    mnt = Path('/mnt/c/Users')
    if mnt.is_dir():
        for user_dir in sorted(mnt.glob('*/.typesafe/.env')):
            out.append(user_dir)
    if script_dir.name == 'scripts':
        out.append(script_dir.parent / '.env')
    return out


def find_key(explicit=None, env=None, script_dir=None):
    """返回 (key, 来源说明, 查过的路径)。key 为 None 表示没找到。"""
    env = os.environ if env is None else env
    if explicit:
        return explicit, '--key', []
    if env.get(ENV_VAR):
        return env[ENV_VAR], 'env:' + ENV_VAR, []
    searched = []
    for path in key_candidates(script_dir, env):
        searched.append(path.as_posix())
        value = parse_env_file(path).get(ENV_VAR)
        if value:
            return value, path.as_posix(), searched
    return None, None, searched


def base_url(env=None):
    env = os.environ if env is None else env
    return (env.get('TYPESAFE_BASE_URL') or DEFAULT_BASE).rstrip('/')


# ---------- HTTP ----------


def http(method, url, key, body=None, timeout=30.0, opener=None, attempts=4):
    """urllib 请求；429/529 退避重试并尊重 Retry-After。返回 (status, json)。"""
    data = json.dumps(body, ensure_ascii=False).encode('utf-8') if body is not None else None
    headers = {'Authorization': 'Bearer ' + key, 'Accept': 'application/json'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
    opener = opener or urllib.request.urlopen
    delay = 1.0
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with opener(req, timeout=timeout) as resp:
                payload = resp.read().decode('utf-8')
                return resp.status, (json.loads(payload) if payload else {})
        except urllib.error.HTTPError as err:
            payload = err.read().decode('utf-8', 'replace')
            try:
                parsed = json.loads(payload)
            except ValueError:
                parsed = {'raw': payload}
            if err.code in (429, 529) and attempt < attempts - 1:
                retry_after = err.headers.get('Retry-After') if err.headers else None
                try:
                    wait = float(retry_after) if retry_after else delay
                except ValueError:
                    wait = delay
                time.sleep(min(wait, 30.0))
                delay = min(delay * 2, 30.0)
                continue
            return err.code, parsed
    return 0, {'error': 'unreachable'}


# ---------- 问题模板 ----------

def noul(instructions, true=None, false=None):
    q = {'type': 'noul', 'instructions': instructions}
    if true or false:
        q['criteria'] = {}
        if true:
            q['criteria']['true'] = true
        if false:
            q['criteria']['false'] = false
    return q


def choice(instructions, criteria):
    return {'type': 'choice', 'instructions': instructions, 'criteria': criteria}


def score(instructions, levels):
    return {'type': 'score', 'instructions': instructions, 'criteria': list(levels)}


def need(state, *keys):
    missing = [k for k in keys if k not in state]
    if missing:
        raise ValueError('state 缺键：' + '、'.join(missing))


def ids_of(mapping, extra=None):
    crit = {}
    for key, value in (mapping or {}).items():
        crit[str(key)] = value if isinstance(value, (str, dict, list)) or value is None else str(value)
    for key, desc in (extra or {}).items():
        crit[key] = desc
    return crit


def t_decision(state):
    """代理用户裁决的第二意见。state：requirement、question、options{A:描述}，可选 decisions、ruling。"""
    need(state, 'requirement', 'question', 'options')
    opts = ids_of(state['options'])
    return {
        'sound': noul('Given `requirement`, is `question` a well-posed fork: its premise holds, the options are genuinely different, and the answer is not already stated in `requirement`?',
                      'The fork is real and needs a ruling', 'The premise is false, the options collapse into one, or the requirement already settles it'),
        'covered': noul('Does `requirement` explicitly state a preference that settles `question`?'),
        'pick': choice('Which option in `options` best fits the wording and intent of `requirement`, preferring the choice that is easiest to reverse when the requirement is silent?', opts),
        'irreversible': noul('Would choosing wrong on `question` be expensive to undo later (data migration, public interface, paid commitment)?'),
    }


def t_candidate(state):
    """产品顾问候选能力的核验。state：requirement、candidate{what,hint,cost_if_skipped}。"""
    need(state, 'requirement', 'candidate')
    dims = {'loop_gap': 'the main flow works but lacks the next step that makes it usable', 'role_blind_spot': 'a second actor (approver, support, ops, the served party) was missed',
            'lifecycle': 'create exists but edit / delete / disable / archive / restore do not', 'data_io': 'import, export, bulk, print, integration',
            'failure_recovery': 'retry, undo, appeal, escalate', 'operations': 'who maintains reference data and configuration', 'audit': 'logs, audit records, retention',
            'scale': 'search, filtering, pagination, archiving once data grows', 'judgment_gap': 'a routing / ranking / extraction / verification step that needs reading text or state'}
    return {
        'needed': noul('Is `candidate.what` necessary for the main flow described in `requirement` to be complete and usable, as opposed to a nice-to-have?',
                       'Without it a described scenario cannot finish', 'The described flows finish without it'),
        'implied': noul('Does the wording quoted in `candidate.hint` actually appear in or follow directly from `requirement`?'),
        'dimension': choice('Which dimension does `candidate` belong to?', dims),
    }


def t_edge(state):
    """边界条目的严重度、可能性、归属与可执行性。state：edge{scene,trigger,expect}，可选 modules{M1:职责}。"""
    need(state, 'edge')
    q = {
        'severity': score('If `edge.trigger` happens and `edge.expect` is not implemented, how bad is the outcome?',
                          ['cosmetic or a confusing message only', 'a feature degrades or a user is blocked until retry', 'data is lost or corrupted, money moves wrongly, or a permission is bypassed']),
        'likelihood': score('How often will `edge.trigger` occur in normal use of the described system?', ['rare, needs deliberate misuse', 'occasional', 'routine, many users will hit it']),
        'executable': noul('Is `edge.expect` concrete enough that a developer could implement it and a tester could verify it without asking a question?',
                           'It names the observable behaviour', 'It is a vague intention such as "handle it gracefully"'),
    }
    if state.get('modules'):
        q['owner'] = choice('Which module in `modules` should own the handling of `edge`?', ids_of(state['modules'], {'unclear': 'none of the listed responsibilities cover it'}))
    return q


def t_risk(state):
    """风险条目的影响、可能性与是否只有产品负责人能定。state：risk{risk,impact,mitigation,trigger}，可选 requirement。"""
    need(state, 'risk')
    return {
        'impact': score('If `risk.risk` materialises, how large is the impact on the project?', ['minor rework inside one task', 'a milestone slips or a module is reworked', 'the delivered product fails its purpose or exposes data']),
        'likelihood': score('How likely is `risk.risk` to materialise before delivery?', ['unlikely', 'plausible', 'likely']),
        'mitigation_concrete': noul('Is `risk.mitigation` a specific action someone could start today, rather than "monitor" or "be careful"?'),
        'needs_owner': noul('Does resolving `risk.risk` require a decision that only the product owner can make (scope, budget, legal, external partner)?'),
    }


def t_stack(state):
    """技术栈选型。state：requirement、options{名字:描述}，可选 constraints。"""
    need(state, 'requirement', 'options')
    return {
        'fit': choice('Which option in `options` best matches the team, scale, deployment and wording in `requirement` (and `constraints` if present)?', ids_of(state['options'])),
        'conflict': noul('Does any option in `options` contradict an explicit constraint stated in `requirement` or `constraints`?'),
        'operable': noul('Can the team described in `requirement` realistically operate the best-fitting option in production without hiring?'),
    }


def t_module(state):
    """能力归属与模块切分。state：capability、modules{M1:职责}。"""
    need(state, 'capability', 'modules')
    return {
        'owner': choice('Which module in `modules` should own `capability` according to the stated responsibilities?', ids_of(state['modules'], {'none': 'no listed module covers it; a new module or a responsibility change is needed'})),
        'spans': noul('Does `capability` need code in two or more of the modules to work end to end?'),
        'cycle_risk': noul('Would giving `capability` to its best owner create a dependency in the opposite direction of the module dependencies stated in `modules`?'),
    }


def t_endpoint(state):
    """接口的权限、幂等与副作用。state：endpoint{method,path,params,returns,permission}，可选 roles[]。"""
    need(state, 'endpoint')
    roles = {r: None for r in (state.get('roles') or ['anonymous', 'user', 'admin'])}
    roles['public'] = 'no authentication needed'
    return {
        'permission': choice('Which role is the least privileged one that should be allowed to call `endpoint`?', roles),
        'mutating': noul('Does calling `endpoint` change stored data or trigger a side effect?'),
        'idempotent': noul('Would calling `endpoint` twice with the same input produce the same stored state as calling it once?'),
        'declared_ok': noul('Is `endpoint.permission` as declared consistent with what the endpoint does and returns?'),
    }


def t_task(state):
    """任务卡的性质：接线、前端、验收可判定、有无延后词、要哪些技能、粒度。state：task{title,input,output,accept}，可选 frontend_modules、module。"""
    need(state, 'task')
    return {
        'is_wiring': noul('Does `task` register something into a shared entry point (route table, DI container, route assembly, event table, build pipeline) so that its output becomes reachable?'),
        'frontend': noul('Is `task` mainly frontend work (pages, components, styles, client state)?'),
        'objective': noul('Can every acceptance criterion in `task.accept` be checked as true or false by a tester without judgement calls?',
                          'Each criterion names an observable result', 'Some criterion uses words like good, reasonable, smooth, optimised'),
        'defers': noul('Does `task.accept` or `task.output` leave part of the work to a later task or "to be wired later"?'),
        'needs_gif': noul('Would a screen recording from the real service be the natural acceptance evidence for `task`?'),
        'needs_judgment': noul('Does `task` contain a step that must read free text or state to route, rank, extract or verify (a TypeSafe judgment)?'),
        'size': score('How much work is `task` for one developer?', ['half a day', 'one day', 'one and a half days', 'two days', 'more than two days, should be split']),
    }


def t_coverage(state):
    """一份验收标准对多条边界的覆盖（扇出）。state：acceptance、edges{E-01:{scene,trigger,expect}}。"""
    need(state, 'acceptance', 'edges')
    out = {}
    for eid in state['edges']:
        out['covered_' + str(eid)] = noul('Does `acceptance` require handling `edges.' + str(eid) + '.trigger` with the behaviour in `edges.' + str(eid) + '.expect`?',
                                          'The acceptance text names that trigger and that behaviour', 'The acceptance text is silent about it or describes a different behaviour')
    return out


def t_review(state):
    """审查：回报里的断言有没有 diff 支撑、diff 里有没有造假形态。state：diff，可选 claims{c1:断言}。"""
    need(state, 'diff')
    q = {
        'hardcoded_gate': noul('Does `diff` contain a check, gate, probe or health function that returns a constant success value regardless of input?'),
        'stub_in_production': noul('Does `diff` add placeholder, stub, "not implemented" or TODO code to a non-test file?'),
        'test_hook': noul('Does `diff` expose a hook only tests would use (a global on window/globalThis, a hidden flag) in production code?'),
        'duplicates_shared': noul('Does `diff` define a type, enum, error code or utility that a shared module referenced in the same diff already provides?'),
        'fixed_response': noul('Does `diff` replace an external service call (HTTP client, SDK, judgment model) with a hard-coded or recorded response outside the test directory?'),
    }
    for cid, claim in (state.get('claims') or {}).items():
        q['claim_' + str(cid)] = choice('How does `diff` relate to the claim `claims.' + str(cid) + '`?',
                                        {'supports': 'the diff contains code that does exactly what the claim says', 'contradicts': 'the diff does something different from the claim',
                                         'absent': 'nothing in the diff bears on the claim'})
    return q


def t_adjudicate(state):
    """S7 岔路口裁决（实施 / 审查 / 查 bug / 收口都用）。state：requirement、task{title,accept}、conflict、options{A:描述}。
    Jev 只在给定选项里选；调用方负责把岔路口写成 2–5 个真实可行的选项，其中至少一个是「最容易改回来」的。"""
    need(state, 'requirement', 'task', 'conflict', 'options')
    opts = ids_of(state['options'])
    if not 2 <= len(opts) <= 5 or any(not str(value).strip() for value in opts.values()):
        raise ValueError('adjudicate.options 须包含 2–5 个非空、真实可行的选项')
    return {
        'pick': choice('Given `requirement`, `task` and the mismatch in `conflict`, which option in `options` lets the task still satisfy its acceptance criteria while staying closest to the documented spec? Prefer the option that is easiest to reverse when they are otherwise equal.', opts),
        'spec_change': noul('Does resolving `conflict` require changing the documented specification or acceptance criteria, rather than only the implementation?',
                            'The task cannot be completed as specified without amending the spec', 'An implementation choice resolves it and the spec stands'),
        'outside_stack': noul('Does the best option in `options` require a library, service or tool that is not part of the documented tech stack?'),
        'needs_owner': noul('Does resolving `conflict` require a decision only the product owner can make: spending money, irreversible deletion of data, changing the agreed scope, a legal or external-partner commitment?',
                            'A person must authorise it', 'It is an engineering choice within the agreed scope'),
        'reversible': noul('If the chosen option turns out wrong, can it be undone later at small cost (no data migration, no public interface change, no paid commitment)?'),
    }


def t_design(state):
    """S3 视觉岔路口（finesse-ui 交回的反对意见、方向二选一、register 后台 vs 工作台）。state：requirement、question、options{A:描述}，可选 current（finesse-ui 的判定）。"""
    need(state, 'requirement', 'question', 'options')
    opts = ids_of(state['options'])
    if not 2 <= len(opts) <= 5 or any(not str(value).strip() for value in opts.values()):
        raise ValueError('design.options 须包含 2–5 个非空、真实可行的选项')
    registers = {'product_backoffice': 'an internal tool organised around a batch of business objects: lists, records, forms, dense tables',
                 'product_workbench': 'an internal tool organised around one task a person repeats: a focused work surface with tools around it',
                 'brand': 'a marketing surface: landing page, company site, portfolio, launch page',
                 'commerce': 'a shopping surface: product detail, listing, cart, checkout',
                 'h5': 'a screen that only ever opens on a phone inside an app or a campaign'}
    return {
        'pick': choice('Given `requirement` (and `current` if present), which option in `options` best fits who uses the product and what they do on it? Prefer the plainer option when the requirement says nothing about look and feel.', opts),
        'register': choice('Which register does the product described in `requirement` belong to?', registers),
        'stated': noul('Does `requirement` express any preference about look and feel (a named reference product, a style word with direction, a colour, a density)?',
                       'The wording names a direction', 'Only undirected words such as nice, clean, premium, or nothing at all'),
        'token_only': noul('Is the difference between the options in `options` expressible purely as design token values (colours, radii, spacing, type scale), so switching later costs one token file?'),
    }


def t_prompt(state):
    """派发前给提示词做语义 lint。state：prompt。"""
    need(state, 'prompt')
    return {
        'placeholder': noul('Does `prompt` still contain an unfilled placeholder such as <...>, TODO or "to be decided"?'),
        'asks_user': noul('Does `prompt` instruct the model to stop and ask a person before continuing, other than the three allowed stop conditions (contradictory acceptance criteria, cannot finish without changing the spec, needs a dependency outside the stack)?'),
        'contradiction': noul('Do two requirements inside `prompt` contradict each other?'),
        'scope_clear': noul('Does `prompt` make clear which files may be changed and which must not?'),
    }


TEMPLATES = {
    'decision': (t_decision, 'requirement, question, options{A:..}; 可选 decisions, ruling(--ruling A 比对)', '代理用户裁决后的第二意见：问题成不成立、需求覆盖没有、更贴合哪个、错了贵不贵'),
    'candidate': (t_candidate, 'requirement, candidate{what,hint,cost_if_skipped}', '产品顾问候选：是否必要、原话是否真暗示、九类维度归属'),
    'edge': (t_edge, 'edge{scene,trigger,expect}; 可选 modules{M1:职责}', '边界：严重度、可能性、期望行为可执行否、归哪个模块'),
    'risk': (t_risk, 'risk{risk,impact,mitigation,trigger}; 可选 requirement', '风险：影响、可能性、缓解是否具体、是否只有产品负责人能定'),
    'stack': (t_stack, 'requirement, options{名字:描述}; 可选 constraints', '技术栈：哪个最贴合、有无与硬约束冲突、团队能否运维'),
    'module': (t_module, 'capability, modules{M1:职责}', '模块划分：能力归谁、是否跨模块、会不会反向依赖'),
    'endpoint': (t_endpoint, 'endpoint{method,path,params,returns,permission}; 可选 roles[]', '接口：最小权限角色、是否变更数据、是否幂等、声明的权限对不对'),
    'task': (t_task, 'task{title,input,output,accept}; 可选 module, frontend_modules', '任务卡：接线否、前端否、验收可判定否、有无延后、要不要 GIF/判断层、粒度'),
    'coverage': (t_coverage, 'acceptance, edges{E-01:{scene,trigger,expect}}', '一份验收对多条边界的语义覆盖（一次请求扇出）'),
    'review': (t_review, 'diff; 可选 claims{c1:断言}', '审查：五种造假形态 + 回报断言是否被 diff 支撑'),
    'adjudicate': (t_adjudicate, 'requirement, task{title,accept}, conflict, options{A:..}', 'S7 岔路口裁决：选哪个、要不要改文档、要不要栈外依赖、是否只有产品负责人能定、可逆否；结果带 adopt'),
    'design': (t_design, 'requirement, question, options{A:..}; 可选 current', 'S3 视觉岔路口裁决：选哪个、register 五选一、需求有没有说观感、差别是否只在 token；结果带 adopt'),
    'prompt': (t_prompt, 'prompt', '派发前提示词 lint：占位符、让模型停下问人、自相矛盾、范围不清'),
}


# ---------- 结果解读 ----------

def band(conf):
    return 'high' if conf >= HIGH else ('medium' if conf >= MEDIUM else 'low')


def tri(p):
    return 'yes' if p >= YES else ('no' if p <= NO else 'unsure')


def verdicts(answers, ruling=None):
    out = {}
    for qid, ans in (answers or {}).items():
        kind = ans.get('type')
        if kind == 'noul':
            out[qid] = {'p': round(float(ans.get('noul', 0)), 3), 'verdict': tri(float(ans.get('noul', 0)))}
        elif kind == 'choice':
            conf = float(ans.get('confidence', 0))
            out[qid] = {'choice': ans.get('choice'), 'confidence': round(conf, 3), 'band': band(conf),
                        'probabilities': ans.get('probabilities')}
        elif kind == 'score':
            conf = float(ans.get('confidence', 0))
            legend = ans.get('legend') or {}
            level = max((ans.get('probabilities') or {'0': 1}).items(), key=lambda kv: kv[1])[0]
            out[qid] = {'score': ans.get('score'), 'level': legend.get(str(level), level), 'confidence': round(conf, 3), 'band': band(conf)}
    if ruling is not None and 'pick' in out:
        out['agreement'] = {'ruling': ruling, 'typesafe': out['pick'].get('choice'),
                            'agree': str(out['pick'].get('choice')) == str(ruling), 'band': out['pick'].get('band')}
    return out


def adopt_rule(template, v):
    """裁决模板的采纳规则，算好放进 verdicts['adopt']，调用方照做不再自己判：
    red_line → 停下找用户（只有 adjudicate 的 needs_owner=yes 会到这）；
    take → 即使 confidence 是 low，仍采纳 Jev 的 pick 并标记风险；
    spec_change / outside_stack 只是标记：采纳后走文档补丁或在回报点名。"""
    if template not in ('adjudicate', 'design') or 'pick' not in v:
        return None
    pick = v['pick']
    if not pick.get('choice'):
        return None
    if template == 'adjudicate' and v.get('needs_owner', {}).get('verdict') != 'no':
        return {'action': 'red_line', 'option': None, 'confidence': 'n/a',
                'why': 'needs_owner 不是明确 no：花钱 / 不可逆删除 / 改范围 / 对外承诺的授权边界须由用户确认'}
    flags = [k for k in ('spec_change', 'outside_stack') if v.get(k, {}).get('verdict') == 'yes']
    return {'action': 'take', 'option': pick['choice'], 'confidence': pick.get('band', 'low'),
            'why': 'Jev 选 %s（%s）' % (pick['choice'], pick.get('band', 'low')) +
                   ('；标记 ' + '/'.join(flags) + '，采纳后走文档补丁或在回报点名' if flags else '')}


def summary_line(template, v):
    """给子代理粘进 TS_CHECK 的一行。"""
    bits = []
    for qid, item in v.items():
        if 'verdict' in item:
            bits.append('%s=%s(%.2f)' % (qid, item['verdict'], item['p']))
        elif 'choice' in item:
            bits.append('%s=%s(%s %.2f)' % (qid, item['choice'], item['band'], item['confidence']))
        elif 'score' in item:
            bits.append('%s=%s(%s %.2f)' % (qid, item['level'], item['band'], item['confidence']))
        elif 'agree' in item:
            bits.append('agree=%s' % ('yes' if item['agree'] else 'NO'))
        elif 'action' in item:
            bits.append('adopt=%s%s' % (item['action'], '(' + str(item['option']) + ')' if item.get('option') else ''))
    return template + ': ' + ' '.join(bits)


# ---------- 主流程 ----------

def load_state(args):
    if getattr(args, 'state_json', None):
        return json.loads(args.state_json)
    if getattr(args, 'state', None):
        return json.loads(Path(args.state).read_text(encoding='utf-8-sig'))
    return json.loads(sys.stdin.read())


def guard_state(state):
    size = len(json.dumps(state, ensure_ascii=False))
    if size > MAX_STATE_CHARS:
        raise ValueError('state 有 %d 字符，超过 %d：先在代码里筛出问题需要的那几段再问，Jev 对无关细节敏感' % (size, MAX_STATE_CHARS))


def cjk_ratio(state):
    """state 文本里 CJK 字符占字母类字符的比例（0–1）。"""
    text = json.dumps(state, ensure_ascii=False)
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    cjk = sum(1 for c in letters if '\u3040' <= c <= '\u30ff' or '\u3400' <= c <= '\u9fff' or '\uac00' <= c <= '\ud7af')
    return cjk / float(len(letters))


def language_warning(state):
    ratio = cjk_ratio(state)
    if ratio > CJK_WARN_RATIO:
        return 'state 里 %d%% 是中日韩字符：Jev 英文最准，先把 requirement / question / options 忠实翻成英文再问（文档与记账仍用原文）' % round(ratio * 100)
    return None


def append_log(path, record):
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open('a', encoding='utf-8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')


def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False, indent=2))
    return code


def skipped(reason, searched):
    return emit({'status': 'skipped', 'reason': reason, 'searched': searched,
                 'hint': '把 TYPESAFE_API_KEY=... 写进 ~/.typesafe/.env（全局）或技能目录的 .env；调用方照常继续，TS_CHECK 记 skipped'},
                SKIPPED_EXIT)


def cmd_check(args, opener=None):
    key, source, searched = find_key(args.key)
    if not key:
        return skipped(ENV_VAR + ' not found', searched)
    status, body = http('GET', base_url() + '/v1/models', key, timeout=args.timeout, opener=opener)
    if status == 200:
        names = [m.get('name') for m in (body.get('models') or [])]
        return emit({'status': 'ok', 'key_source': source, 'models': names})
    return emit({'status': 'error', 'http': status, 'key_source': source, 'body': body}, 3 if status == 401 else 4)


def cmd_templates(args, opener=None):
    return emit({name: {'state': spec[1], 'answers': spec[2], 'questions': sorted(spec[0]({'requirement': 'x', 'question': 'q', 'conflict': 'c', 'options': {'A': 'first', 'B': 'second'}, 'candidate': {}, 'edge': {}, 'risk': {}, 'capability': 'c', 'modules': {'M1': 'r'}, 'endpoint': {}, 'task': {}, 'acceptance': 'a', 'edges': {'E-01': {}}, 'diff': 'd', 'prompt': 'p'}).keys())}
                 for name, spec in TEMPLATES.items()})


def run_request(key, state, questions, model, timeout, opener=None):
    body = {'state': state, 'model': model or os.environ.get('TYPESAFE_DEFAULT_MODEL') or DEFAULT_MODEL, 'questions': questions}
    status, resp = http('POST', base_url() + '/v1/systemone', key, body, timeout=timeout, opener=opener)
    return status, resp, body


def cmd_run(args, opener=None):
    if args.template not in TEMPLATES:
        return emit({'status': 'error', 'reason': '未知模板 ' + args.template, 'templates': sorted(TEMPLATES)}, 5)
    key, source, searched = find_key(args.key)
    state = load_state(args)
    try:
        guard_state(state)
        questions = TEMPLATES[args.template][0](state)
    except ValueError as exc:
        return emit({'status': 'error', 'reason': str(exc)}, 5)
    if args.dry:
        out = {'status': 'dry', 'template': args.template, 'questions': questions}
        warn = language_warning(state)
        if warn:
            out['language_warning'] = warn
        return emit(out)
    if not key:
        return skipped(ENV_VAR + ' not found', searched)
    status, resp, body = run_request(key, state, questions, args.model, args.timeout, opener)
    if status != 200:
        return emit({'status': 'error', 'http': status, 'body': resp, 'template': args.template}, 3 if status == 401 else 4)
    v = verdicts(resp.get('answers'), getattr(args, 'ruling', None))
    adopt = adopt_rule(args.template, v)
    if args.template in ('adjudicate', 'design') and (not adopt or adopt.get('option') not in questions['pick']['criteria']
                                                       and adopt.get('action') != 'red_line'):
        return emit({'status': 'error', 'reason': 'Jev 未返回有效的候选裁决，不能自行代答', 'template': args.template}, 4)
    if adopt:
        v['adopt'] = adopt
    record = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'template': args.template, 'model': resp.get('model'),
              'state_sha256': hashlib.sha256(json.dumps(state, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()[:16],
              'label': args.label, 'verdicts': v, 'usage': resp.get('usage')}
    append_log(args.log, record)
    out = {'status': 'ok', 'template': args.template, 'model': resp.get('model'), 'key_source': source,
           'verdicts': v, 'line': summary_line(args.template, v), 'usage': resp.get('usage')}
    warn = language_warning(state)
    if warn:
        out['language_warning'] = warn
        out['line'] += ' [lang: CJK state, prefer English]'
    return emit(out)


def cmd_ask(args, opener=None):
    key, source, searched = find_key(args.key)
    req = json.loads(Path(args.input).read_text(encoding='utf-8-sig')) if args.input else json.loads(sys.stdin.read())
    try:
        guard_state(req.get('state'))
    except ValueError as exc:
        return emit({'status': 'error', 'reason': str(exc)}, 5)
    if not key:
        return skipped(ENV_VAR + ' not found', searched)
    status, resp, body = run_request(key, req.get('state'), req.get('questions') or {}, req.get('model') or args.model, args.timeout, opener)
    if status != 200:
        return emit({'status': 'error', 'http': status, 'body': resp}, 3 if status == 401 else 4)
    v = verdicts(resp.get('answers'))
    append_log(args.log, {'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'template': 'ask', 'model': resp.get('model'), 'label': args.label, 'verdicts': v, 'usage': resp.get('usage')})
    out = {'status': 'ok', 'model': resp.get('model'), 'key_source': source, 'answers': resp.get('answers'), 'verdicts': v, 'usage': resp.get('usage')}
    warn = language_warning(req.get('state'))
    if warn:
        out['language_warning'] = warn
    return emit(out)


def build_parser():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--key', help='直接给密钥（一般不用，走 .env）')
    p.add_argument('--model', help='默认 jev-latest；阈值调过就钉版本号')
    p.add_argument('--timeout', type=float, default=30.0)
    p.add_argument('--log', help='追加 jsonl 记录的路径，如 <docs>/_run/judgments.jsonl')
    p.add_argument('--label', default='', help='记进日志的标签，如 决策 7 / M2-T3')
    sub = p.add_subparsers(dest='cmd')
    sub.add_parser('check')
    sub.add_parser('templates')
    r = sub.add_parser('run')
    r.add_argument('template')
    r.add_argument('--state', help='state 的 JSON 文件')
    r.add_argument('--state-json', help='state 的 JSON 字面量')
    r.add_argument('--ruling', help='decision 模板：子代理已裁的选项字母，用来算 agreement')
    r.add_argument('--dry', action='store_true', help='只打印拼好的问题，不发请求')
    a = sub.add_parser('ask')
    a.add_argument('--input', help='原始请求 JSON 文件 {state, questions[, model]}')
    return p


def main(argv=None, opener=None):
    args = build_parser().parse_args(argv)
    if args.cmd == 'check':
        return cmd_check(args, opener)
    if args.cmd == 'templates':
        return cmd_templates(args, opener)
    if args.cmd == 'run':
        return cmd_run(args, opener)
    if args.cmd == 'ask':
        return cmd_ask(args, opener)
    build_parser().print_help()
    return 1


if __name__ == '__main__':
    sys.exit(main())
