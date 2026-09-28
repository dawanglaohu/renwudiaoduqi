/* unattended-run · density_probe.js —— 桌面密度探针（references/density.md 第 4 节）
 *
 * 浏览器里：定义 densityProbe(opts)，量主区域的填充率、横向空带、空网格轨、断点放大的间距、
 * 超契约的块间距与卡片内边距，返回一段 JSON。不改页面，不依赖框架。
 *   Playwright MCP browser_evaluate：() => { <本文件全文>; return densityProbe({type: 'work', density: 8}); }
 *   Playwright 脚本：page.evaluate(({src, opts}) => { (0, eval)(src); return densityProbe(opts); }, {src, opts})
 * 命令行（项目里装了 playwright 才能用）：
 *   node density_probe.js <URL> --type work|form|card --density 8 [--gutter 16 --gap 12 --pad 14]
 *        [--main <选择器>] [--rail <选择器>] [--wait <选择器>] [--settle 600] [--init <脚本>]
 *        [--viewports 1920x1080,1440x900,390x844] [--screens <目录>] [--out <文件>]
 *   --init 的脚本在每个视口的页面脚本之前执行，用来带上登录态（比如把令牌写进 sessionStorage）。
 *   桌面视口（宽 >= 1024）任一不过退出码 1；用法错误、找不到 playwright、页面打不开、
 *   打开后停在别的地址（多半被登录守卫转走，这时不量）退出码 2。
 */
var densityProbe = (function () {
  'use strict';

  // DENSITY -> [页边距, 块间距, 卡片内边距]，取 density.md 第 1 节每档的上沿
  var SCALE = {9: [12, 8, 12], 8: [16, 12, 14], 7: [20, 16, 16], 6: [24, 16, 18], 5: [28, 20, 22], 4: [28, 20, 22]};
  var MOBILE_BELOW = 768;
  var SPACING = /^(?:(sm|md|lg|xl|2xl):)?(-?)(px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m|gap-x|gap-y|gap|space-x|space-y)-(.+)$/;
  var FAMILY = {px: 'p', py: 'p', pt: 'p', pr: 'p', pb: 'p', pl: 'p',
                mx: 'm', my: 'm', mt: 'm', mr: 'm', mb: 'm', ml: 'm', 'gap-x': 'gap', 'gap-y': 'gap'};
  var REPLACED = /^(IMG|SVG|CANVAS|VIDEO|INPUT|SELECT|TEXTAREA|BUTTON|PROGRESS|METER|IFRAME)$/;
  var LIMIT = 30;

  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : dflt;
  }

  function contract(opts) {
    opts = opts || {};
    var d = Math.max(4, Math.min(9, Math.round(Number(opts.density) || 8)));
    var row = SCALE[d];
    return {density: d, gutter: num(opts.gutter, row[0]), gap: num(opts.gap, row[1]), pad: num(opts.pad, row[2])};
  }

  // 'p-6' -> 24；'p-[18px]' -> 18；'p-[var(--sp-4)]' -> 按 CSS 变量解析；'px' -> 1；认不出 -> null
  function spacingPx(value, resolveVar) {
    value = String(value);
    if (value === 'px') return 1;
    if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 4;
    var m = /^\[(.+)\]$/.exec(value);
    if (!m) return null;
    var inner = m[1];
    var v = /^var\((--[\w-]+)\)$/.exec(inner);
    if (v) inner = resolveVar ? String(resolveVar(v[1]) || '').trim() : '';
    var px = /^(\d+(?:\.\d+)?)px$/.exec(inner);
    if (px) return Number(px[1]);
    var rem = /^(\d+(?:\.\d+)?)rem$/.exec(inner);
    if (rem) return Number(rem[1]) * 16;
    return null;
  }

  // 一个元素的类名 -> 断点前缀把间距调大的条目（D1）。负值是叠压效果，不算留白
  function growthOf(classes, resolveVar) {
    var base = {}, pref = [];
    (classes || []).forEach(function (c) {
      var m = SPACING.exec(c);
      if (!m || m[2] === '-') return;
      var px = spacingPx(m[4], resolveVar);
      if (!m[1]) base[m[3]] = px;          // 认不出的基准值记 null：无从比较，不判
      else if (px !== null) pref.push({prop: m[3], px: px, cls: c});
    });
    var out = [];
    pref.forEach(function (p) {
      var key = p.prop in base ? p.prop : (FAMILY[p.prop] && FAMILY[p.prop] in base ? FAMILY[p.prop] : null);
      var b = key === null ? 0 : base[key];
      if (b === null) return;
      if (p.px > b) out.push({cls: p.cls, from: b, to: p.px});
    });
    return out;
  }

  // 横向区间合并；相距不超过 tol 的并成一段
  function merge(intervals, tol) {
    var xs = (intervals || []).filter(function (i) { return i[1] - i[0] > 0; })
      .map(function (i) { return [i[0], i[1]]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    xs.forEach(function (i) {
      var last = out[out.length - 1];
      if (last && i[0] <= last[1] + (tol || 0)) last[1] = Math.max(last[1], i[1]);
      else out.push(i);
    });
    return out;
  }

  // 六条底线的判定。m 是量出来的数；type 取 work / form / card
  function verdict(m, type, c, mobile) {
    var v = {};
    v.D1 = mobile ? 'n/a' : (m.growth.length ? 'fail' : 'pass');   // 断点类只在宽屏生效，桌面那两趟已经判过
    if (mobile || type === 'card') v.D2 = 'n/a';
    else if (type === 'form') v.D2 = (m.fill >= 0.55 && m.leftGap <= c.gutter + 24) ? 'pass' : 'fail';
    else v.D2 = m.fill >= 0.85 ? 'pass' : 'fail';
    v.D3 = m.emptyTracks.length ? 'fail' : 'pass';
    v.D4 = mobile ? 'n/a' : ((m.gapOffenders.length || m.padOffenders.length) ? 'fail' : 'pass');
    v.D5 = mobile ? 'n/a' : (m.sparseBlocks.length ? 'fail' : 'pass');
    if (mobile || type === 'card') v.D6 = 'n/a';
    else {
      var limit = 0.15 * m.avail.width;
      var edges = type === 'work' ? Math.max(m.leftGap - c.gutter, m.rightGap - c.gutter) : 0;
      v.D6 = (m.interiorBand.px <= limit && edges <= limit) ? 'pass' : 'fail';
    }
    if (!m.contentFound) { v.D2 = mobile || type === 'card' ? v.D2 : 'fail'; v.note = '主区域第一屏没有可见内容：页面没加载完，或 main 选择器不对'; }
    v.overflow = (m.overflowX || 0) > 1 ? 'fail' : 'pass';   // 任何宽度都不许横向溢出；手机对照主要看它
    v.pass = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'overflow'].every(function (k) { return v[k] !== 'fail'; });
    return v;
  }

  function round(x, n) { var p = Math.pow(10, n); return Math.round(x * p) / p; }

  function probe(opts) {
    opts = opts || {};
    var type = opts.type === 'form' || opts.type === 'card' ? opts.type : 'work';
    var c = contract(opts);
    var doc = document, win = window;
    var vw = doc.documentElement.clientWidth || win.innerWidth, vh = win.innerHeight;
    var mobile = vw < MOBILE_BELOW;
    var rootStyle = win.getComputedStyle(doc.documentElement);
    var resolveVar = function (name) { return rootStyle.getPropertyValue(name); };

    function pick(sel) { try { return sel ? doc.querySelector(sel) : null; } catch (e) { return null; } }
    function style(el) { return win.getComputedStyle(el); }
    function shown(el, cs) {
      cs = cs || style(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1;
    }
    function path(el) {
      var parts = [];
      for (var n = el, i = 0; n && n.nodeType === 1 && i < 4; n = n.parentElement, i++) {
        var s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift(s + '#' + n.id); break; }
        var cls = String(n.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
        if (cls.length) s += '.' + cls.join('.').replace(/:/g, '\\:');
        parts.unshift(s);
      }
      return parts.join(' > ');
    }
    function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
    function alpha(color) {
      if (!color || color === 'transparent') return 0;
      var m = /rgba?\(([^)]+)\)/.exec(color);
      if (!m) return 1;
      var parts = m[1].split(/[\s,\/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    }
    function surface(cs) {
      if (alpha(cs.backgroundColor) > 0.02 || (cs.backgroundImage && cs.backgroundImage !== 'none')) return true;
      return ['Top', 'Right', 'Bottom', 'Left'].some(function (s) {
        return px(cs['border' + s + 'Width']) > 0 && cs['border' + s + 'Style'] !== 'none' && alpha(cs['border' + s + 'Color']) > 0.02;
      });
    }
    function inflowChildren(el) {
      var out = [];
      for (var i = 0; i < el.children.length; i++) {
        var ch = el.children[i], cs = style(ch);
        if (cs.position === 'absolute' || cs.position === 'fixed' || !shown(ch, cs)) continue;
        out.push(ch);
      }
      return out;
    }

    var main = pick(opts.main) || doc.querySelector('main') || doc.querySelector('[role=main]') || doc.body;
    var everything = Array.prototype.slice.call(doc.querySelectorAll('body *'));
    // 左栏：贴左边、高 >= 60% 视口、宽 <= 35% 视口；先认语义标签，认不到再按几何找，且不能是 main 的祖先
    function railLike(el) {
      if (el === main || el.contains(main)) return false;
      var rr = el.getBoundingClientRect();
      return rr.left <= 8 && rr.height >= 0.6 * vh && rr.width > 40 && rr.width <= 0.35 * vw && shown(el);
    }
    var rail = opts.rail ? pick(opts.rail) : null;
    if (!opts.rail) {
      var semantic = everything.filter(function (el) { return el.matches('aside, nav, [role=navigation], [role=complementary]'); });
      rail = semantic.filter(railLike)[0] || null;
      if (!rail) {
        rail = everything.filter(function (el) {
          var parent = el.parentElement;
          if (!parent || !railLike(el)) return false;
          var ps = style(parent);
          return (ps.display.indexOf('flex') >= 0 && ps.flexDirection.indexOf('row') === 0) || ps.display.indexOf('grid') >= 0;
        })[0] || null;
      }
    }
    var railRect = rail && shown(rail) ? rail.getBoundingClientRect() : null;
    var availLeft = railRect && railRect.left <= 8 ? Math.max(0, railRect.right) : 0;
    var avail = {left: availLeft, right: vw, width: Math.max(1, vw - availLeft)};

    var fixed = everything.filter(function (el) { return style(el).position === 'fixed'; });
    // 通栏：贴着视口顶部或底部、横跨可用宽度、高 <= 72 的条（顶栏、工具栏、面包屑、底栏）。
    // 它们两端都有字，算进内容跨度会把填充率抬到 1；里面的间距照常量
    var bars = everything.filter(function (el) {
      var br = el.getBoundingClientRect();
      return br.width >= 0.9 * avail.width && br.height >= 16 && br.height <= 72 &&
        (br.top <= 0.2 * vh || br.bottom >= 0.9 * vh) && !el.contains(main) && shown(el);
    });
    function excluded(el) {
      if (rail && rail.contains(el)) return true;
      for (var k = 0; k < fixed.length; k++) if (fixed[k].contains(el)) return true;
      return false;
    }
    function inBar(el) {
      for (var k = 0; k < bars.length; k++) if (bars[k].contains(el)) return true;
      return false;
    }

    var intervals = [], gapOffenders = [], padOffenders = [], sparseBlocks = [], emptyTracks = [], centeredCaps = [];
    var range = doc.createRange();
    var nodes = [main].concat(Array.prototype.slice.call(main.querySelectorAll('*')));
    nodes.forEach(function (el) {
      if (excluded(el)) return;
      var cs = style(el);
      if (!shown(el, cs)) return;
      var r = el.getBoundingClientRect();
      var onScreen = r.bottom > 0 && r.top < vh;

      // 内容的横向跨度：文字按字形量，替换元素与控件按盒子量，有底色或描边的面按盒子量（通栏的面不算，它只是背景）
      if (onScreen && !inBar(el)) {
        for (var t = 0; t < el.childNodes.length; t++) {
          var node = el.childNodes[t];
          if (node.nodeType === 3 && node.nodeValue.trim()) {
            range.selectNodeContents(node);
            var tr = range.getBoundingClientRect();
            if (tr.width > 0) intervals.push([tr.left, tr.right]);
          }
        }
        if (REPLACED.test(el.tagName.toUpperCase())) intervals.push([r.left, r.right]);
        // 通宽的面：矮的是整行（表格行、列表行），算内容；高的是页面底板，不算
        else if (el !== main && surface(cs) && (r.width < 0.97 * avail.width || r.height <= 120)) intervals.push([r.left, r.right]);
      }

      var pads = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)];
      var pad = Math.max.apply(null, pads);
      var isControl = REPLACED.test(el.tagName.toUpperCase()) || el.getAttribute('role') === 'button';

      // D4：卡片内边距
      if (!isControl && el !== main && surface(cs) && px(cs.borderTopLeftRadius) >= 4 &&
          r.width >= 160 && r.height >= 40 && r.width < 0.97 * avail.width && pad > c.pad + 4) {
        padOffenders.push({path: path(el), pad: pad, limit: c.pad + 4});
      }
      // D5：大内边距、少内容的块
      var text = (el.textContent || '').trim();
      if (pad >= 32 && r.height >= 80 && text.length < 120 && el.children.length <= 4) {
        sparseBlocks.push({path: path(el), pad: pad, text: text.slice(0, 40)});
      }
      // D2：居中限宽
      var ml = px(cs.marginLeft), mr = px(cs.marginRight);
      if (el !== main && cs.maxWidth !== 'none' && ml > 16 && Math.abs(ml - mr) <= 2 &&
          r.width >= 240 && r.width < 0.8 * avail.width) {
        centeredCaps.push({path: path(el), maxWidth: cs.maxWidth, width: round(r.width, 1)});
      }

      var kids = inflowChildren(el);
      if (kids.length < 2 && !(cs.display.indexOf('grid') >= 0 && kids.length >= 1)) return;
      var spaced = /space-(between|around|evenly)/.test(cs.justifyContent);

      // D4：相邻块间距（竖向堆叠的兄弟之间的净间距）。超过四分之一屏高的是 mt-auto 一类的推挤，不算间距
      var worst = 0;
      if (!spaced) {
        for (var j = 1; j < kids.length; j++) {
          var a = kids[j - 1].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
          var between = b.top - a.bottom;
          if (b.top >= a.bottom - 1 && b.left < a.right && a.left < b.right && between < 0.25 * vh) worst = Math.max(worst, between);
        }
        var colGap = px(cs.columnGap);
        if (cs.display.indexOf('flex') >= 0 && cs.flexDirection.indexOf('row') === 0) worst = Math.max(worst, colGap);
        if (cs.display.indexOf('grid') >= 0) worst = Math.max(worst, colGap, px(cs.rowGap));
      }
      if (worst > c.gap * 1.5 + 0.5) gapOffenders.push({path: path(el), gap: round(worst, 1), limit: c.gap * 1.5});

      // D3：多列网格里没被占用的宽度
      if (cs.display.indexOf('grid') >= 0) {
        var tracks = String(cs.gridTemplateColumns || '').split(/\s+/).map(px).filter(function (w) { return w > 0; });
        if (tracks.length >= 2) {
          var left = r.left + px(cs.paddingLeft) + px(cs.borderLeftWidth);
          var right = r.right - px(cs.paddingRight) - px(cs.borderRightWidth);
          var used = merge(kids.map(function (k) { var kr = k.getBoundingClientRect(); return [kr.left, kr.right]; }), px(cs.columnGap) + 2);
          if (used.length) {
            var wasted = Math.max(0, used[0][0] - left) + Math.max(0, right - used[used.length - 1][1]);
            for (var u = 1; u < used.length; u++) wasted += used[u][0] - used[u - 1][1];
            if (wasted >= 120 && wasted >= 0.1 * (right - left)) {
              emptyTracks.push({path: path(el), tracks: tracks.length, items: kids.length, wasted: round(wasted, 1)});
            }
          }
        }
      }
    });

    var growth = [];
    doc.querySelectorAll('[class]').forEach(function (el) {
      if (growth.length >= LIMIT) return;
      var classes = String(el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
      growthOf(classes, resolveVar).forEach(function (g) {
        if (growth.length < LIMIT) growth.push({path: path(el), cls: g.cls, from: g.from, to: g.to});
      });
    });

    var clipped = intervals.map(function (i) { return [Math.max(i[0], avail.left), Math.min(i[1], avail.right)]; });
    var spans = merge(clipped, 2);
    var found = spans.length > 0;
    var first = found ? spans[0][0] : avail.left, last = found ? spans[spans.length - 1][1] : avail.left;
    var interior = 0;
    for (var s = 1; s < spans.length; s++) interior = Math.max(interior, spans[s][0] - spans[s - 1][1]);

    var m = {
      probe: 'density', version: 2, url: String(win.location && win.location.href || ''),
      type: type, contract: c, viewport: {width: vw, height: vh}, mobile: mobile,
      main: path(main), rail: railRect ? {path: path(rail), width: round(railRect.width, 1)} : null,
      avail: {left: round(avail.left, 1), right: round(avail.right, 1), width: round(avail.width, 1)},
      contentFound: found,
      fill: round(found ? (last - first) / avail.width : 0, 3),
      leftGap: round(found ? first - avail.left : avail.width, 1),
      rightGap: round(found ? avail.right - last : avail.width, 1),
      interiorBand: {px: round(interior, 1), ratio: round(interior / avail.width, 3)},
      overflowX: Math.max(0, (doc.documentElement.scrollWidth || 0) - (doc.documentElement.clientWidth || vw)),
      bars: bars.length,
      growth: growth,
      emptyTracks: emptyTracks.slice(0, LIMIT),
      gapOffenders: gapOffenders.slice(0, LIMIT),
      padOffenders: padOffenders.slice(0, LIMIT),
      sparseBlocks: sparseBlocks.slice(0, LIMIT),
      centeredCaps: centeredCaps.slice(0, LIMIT),
      counts: {growth: growth.length, emptyTracks: emptyTracks.length, gapOffenders: gapOffenders.length,
               padOffenders: padOffenders.length, sparseBlocks: sparseBlocks.length, centeredCaps: centeredCaps.length}
    };
    m.verdict = verdict(m, type, c, mobile);
    return m;
  }

  probe.contract = contract;
  probe.spacingPx = spacingPx;
  probe.growthOf = growthOf;
  probe.merge = merge;
  probe.verdict = verdict;
  return probe;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = densityProbe;
  if (typeof require === 'function' && require.main === module) {
    (function cli(argv) {
      var fs = require('fs'), path = require('path');
      var USAGE = '用法：node density_probe.js <URL> --type work|form|card --density <4-9> ' +
        '[--gutter N --gap N --pad N] [--main 选择器] [--rail 选择器] [--wait 选择器] [--settle 毫秒] [--init 脚本] ' +
        '[--viewports 1920x1080,1440x900,390x844] [--screens 目录] [--out 文件]';
      var args = {viewports: '1920x1080,1440x900,390x844', settle: '600'}, url = null;
      for (var i = 0; i < argv.length; i++) {
        var a = argv[i];
        if (a.slice(0, 2) === '--') {
          var val = argv[i + 1];
          if (val === undefined || val.slice(0, 2) === '--') { console.error(USAGE); process.exit(2); }
          args[a.slice(2)] = val;
          i++;
        } else if (!url) url = a;
      }
      if (!url) { console.error(USAGE); process.exit(2); }
      var vps = String(args.viewports).split(',').map(function (s) {
        var m = /^(\d+)x(\d+)$/.exec(s.trim());
        return m ? {width: Number(m[1]), height: Number(m[2])} : null;
      });
      if (!vps.length || vps.some(function (v) { return !v; })) { console.error(USAGE); process.exit(2); }
      var init = null;
      if (args.init) {
        try { init = fs.readFileSync(args.init, 'utf8'); } catch (e) {
          console.error('读不到 --init 脚本：' + args.init);
          process.exit(2);
        }
      }
      var moduleName = process.env.DENSITY_PROBE_PLAYWRIGHT || 'playwright';
      var pw;
      try {
        pw = require(require.resolve(moduleName, {paths: [process.cwd(), __dirname]}));
      } catch (e) {
        console.error('找不到 playwright：在项目里装上（npm i -D playwright && npx playwright install chromium），' +
                      '或者改用浏览器工具执行 densityProbe（见文件头）。');
        process.exit(2);
      }
      // 只比源、路径与 hash 路由，不比查询串：页面自己补上的参数、末尾的斜杠都不算跳转
      function routeOf(u) {
        try {
          var x = new URL(u);
          return x.origin + '/' + x.pathname.replace(/^\/+|\/+$/g, '') + '#' +
            x.hash.replace(/^#/, '').split('?')[0].replace(/^\/+|\/+$/g, '');
        } catch (e) {
          return String(u);
        }
      }
      var src = fs.readFileSync(__filename, 'utf8');
      var opts = {type: args.type, density: args.density, gutter: args.gutter, gap: args.gap, pad: args.pad,
                  main: args.main, rail: args.rail};
      (async function () {
        var browser = await pw.chromium.launch();
        var results = [], bad = false, landed = null;
        try {
          for (var j = 0; j < vps.length; j++) {
            var vp = vps[j];
            var ctx = await browser.newContext({viewport: vp, bypassCSP: true});
            if (init) await ctx.addInitScript({content: init});
            var page = await ctx.newPage();
            await page.goto(url, {waitUntil: 'load'});
            var waitError = null;
            if (args.wait) {
              try { await page.waitForSelector(args.wait, {timeout: 15000}); } catch (e) { waitError = e; }
            }
            await page.waitForTimeout(Number(args.settle) || 0);
            // 被登录守卫或路由转走时，量到的是别的页面：不量，按打不开处理
            if (routeOf(page.url()) !== routeOf(url)) {
              landed = page.url();
              await ctx.close();
              break;
            }
            if (waitError) throw waitError;
            var r = await page.evaluate(function (input) {
              (0, eval)(input.src);
              return densityProbe(input.opts);
            }, {src: src, opts: opts});
            if (args.screens) {
              fs.mkdirSync(args.screens, {recursive: true});
              await page.screenshot({path: path.join(args.screens, 'density-' + vp.width + 'x' + vp.height + '.png')});
            }
            results.push(r);
            if (vp.width >= 1024 && !r.verdict.pass) bad = true;
            await ctx.close();
          }
        } finally {
          await browser.close();
        }
        if (landed) {
          console.error('要量的是 ' + url + '，页面停在 ' + landed + '：多半是登录守卫或路由把它转走了，没有量。' +
                        '页面要登录态就加 --init <脚本>（在页面脚本之前执行，比如把令牌写进 sessionStorage）；' +
                        '确实是正常跳转，就直接量跳转后的地址。');
          process.exit(2);
        }
        var text = JSON.stringify(results, null, 2) + '\n';
        if (args.out) fs.writeFileSync(args.out, text); else process.stdout.write(text);
        process.exit(bad ? 1 : 0);
      })().catch(function (e) {
        console.error(String((e && e.stack) || e));
        process.exit(2);
      });
    })(process.argv.slice(2));
  }
}
