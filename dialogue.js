/* Dialogue engine: who says each line of dialogue in a Chinese novel.
 *
 * Runs entirely in the browser, no network. Two passes over the book:
 *  1. buildCast(chapters): find character names from how the book tags speech
 *     ("X道：" / "”X笑道。"), using right-branching to cut names out of the
 *     surrounding words (so 克莱恩 is kept, 克莱恩笑 and 克莱 are not). The cast is
 *     ranked by how often each character speaks; colours and avatars are assigned
 *     from that rank, so the same txt file gives the same cast, colours and
 *     avatars on every device and in every chapter.
 *  2. attributeChapter(chapter, cast, prevTail): split each paragraph into
 *     narration and quotes and give every spoken quote a speaker + confidence:
 *       'explicit'  tagged with a speech verb  (X道：“…” / “…”X问。)
 *       'context'   the paragraph's own actor  (X皱了皱眉。“…”) or a continued quote
 *       'inferred'  pronoun or turn-taking guess (他道：“…” / A,B,A…)
 *       null        not enough evidence -> shown as an unknown speaker
 *
 * Works in browsers (window.Dialogue) and Node (module.exports) so it can be tested
 * against real books.
 */
(function (root) {
  'use strict';
  const VERSION = 4;
  const HAN = '\\u3400-\\u9fff';
  const DOT = '·•‧・';
  const SPEECH = '说道|问道|答道|笑道|叹道|喝道|叫道|喊道|骂道|回道|应道|回答道|开口道|出声道|低声道|轻声道|沉声道|冷声道|厉声道|柔声道|' +
    '说|道|问|答|喊|叫|嚷|吼|喝|骂|叹|嘀咕|呢喃|喃喃|低语|开口|回答|回应|询问|追问|反问|解释|补充|感叹|吩咐|提醒|重复|插话|嘟囔|' +
    '宣布|命令|祈求|祷告|念诵|诵念|自语|附和|打断|强调|介绍|总结|安慰|招呼|吐槽|抱怨|嘟哝|咕哝|呼喊|叮嘱|交代|请求|喊道|笑着说';
  const SPEECH_RE = new RegExp('(' + SPEECH + ')');
  const PRONOUN_RE = /^(他|她|它|祂|我|你|您|他们|她们|对方|那人|此人|众人|大家|两人|三人|有人)/;
  /* sentence-initial words that are not names; stripped before reading the subject */
  const LEAD = ['这个瞬间', '这一刻', '此刻', '此时此刻', '下一秒钟', '然后', '于是', '这时', '此时', '随即', '接着', '紧接着', '片刻后', '过了一会儿', '过了几秒', '过了片刻', '最终', '最后', '终于',
    '但', '而', '可', '只见', '旁边的', '对面的', '同时', '突然', '忽然', '顿时', '立刻', '马上', '很快', '这一次', '这次', '下一秒', '下一刻',
    '见状', '闻言', '听到这里', '听到这句话', '说完', '说到这里', '想了想', '想了一下', '沉默了几秒', '沉默片刻', '与此同时', '另一边', '当然',
    '因此', '所以', '又', '也', '还', '则', '便', '就', '才', '再', '都', '一旁的', '身旁的', '身边的', '坐在', '站在', '旁边'];
  const LEAD_RE = new RegExp('^(?:' + LEAD.sort((a, b) => b.length - a.length).join('|') + ')[，,]?');
  /* frequent sentence starters that look like names to the branching test */
  const STOP = new Set(['这个', '那个', '这位', '那位', '这里', '那里', '这样', '那样', '这种', '那种', '这些', '那些', '什么', '怎么', '为什么',
    '如果', '虽然', '因为', '不过', '但是', '可是', '然而', '而且', '只是', '只要', '甚至', '其中', '其他', '其余', '另外', '另一位', '一位',
    '一个', '一名', '一道', '一阵', '一声', '一边', '整个', '所有', '每个', '各自', '自己', '目前', '现在', '刚才', '之前', '之后', '然后',
    '接下来', '紧接着', '同时', '他们', '她们', '我们', '你们', '对方', '大家', '众人', '两人', '三人', '有人', '没有', '不是', '就是',
    '还是', '已经', '正在', '似乎', '好像', '仿佛', '依旧', '仍然', '果然', '当然', '确实', '真的', '的确', '心里', '心中', '脑海', '内心',
    '声音', '语气', '表情', '目光', '视线', '眼睛', '脸上', '嘴里', '嘴角', '老人', '男子', '女子', '少女', '少年', '青年', '女孩', '男孩',
    '女士', '先生', '小姐', '夫人', '中年男子', '中年人', '年轻人', '老者', '侍者', '仆人', '女仆', '男仆', '警察', '店主', '老板', '他的',
    '她的', '它们', '这名', '那名', '这道', '那道', '于是', '这时', '此时', '随即', '接着', '片刻后', '最终', '最后', '终于', '突然', '忽然',
    '顿时', '立刻', '马上', '很快', '见状', '闻言', '说完', '想了想', '沉默', '笑了笑', '点了点头', '摇了摇头', '开口', '回答', '询问',
    '低声', '轻声', '沉声', '下一秒', '下一刻', '与此同时', '这一次', '这次', '因此', '所以', '可惜', '幸好', '虽说', '听到', '看到',
    '旁边', '对面', '身旁', '周围', '外面', '里面', '上面', '下面', '前面', '后面', '略显', '略带', '颇为']);
  /* fragments that are never names: leading prepositions/negations, trailing aspect particles */
  const FRAG_RE = /^(?:的|在|对|向|把|被|和|与|给|跟|将|让|从|朝|往|见|没|不|很|有一|另外)|.[了着过到地]$|的$|^.[了着过向住至]|^.[笑完然感眸哑静起下上出在定开回进住]$|之[上下中内外前后间]$/;
  /* parse dialogue-words.txt -> {all:Set, verbish:Set} */
  function parseWords(txt) {
    const all = new Set(), verbish = new Set();
    for (const line of String(txt || '').split('\n')) {
      if (!line || line[0] === '#') continue;
      if (line[0] === '!') { const w = line.slice(1).trim(); all.add(w); verbish.add(w) } else all.add(line.trim());
    }
    return { all, verbish };
  }
  /* common characters that start clauses but are never a one-character name */
  const SINGLE_STOP = '祂他她它我你您这那就又也还都便只但而可在是有没不很再才却则且并即已正将把被让给对向从朝往和与跟同及或若如虽因所以为了的地得着过一二三四五六七八九十几两个些每各某其此该何谁什么怎么哪多少大小老新旧上下左右前后里外中内东西南北见看听说问答想觉知道笑哭叫喊走跑坐站拿放打开关吃喝睡醒抬低点摇伸收转回进出来去到起落用以于至自当随沿顺按据趁凭靠替为由经等似像如同比更最太极非真实好坏高矮长短快慢早晚先后刚才曾已经正在马上立刻忽然突然渐渐慢慢轻轻静静默默悄悄偷偷心眼手脚头脸嘴身声音气光影门窗墙桌椅床车船街路房屋人物事情话语字句书信纸笔衣帽鞋袜钱金银铜铁石木水火土风雨雪云天地日月星时分秒年月日夜晨昏今昨明';
  /* clauses that set the scene for someone else's action: 等到X…，他… / 不等X开口，他… */
  const SUBORD_RE = /^(?:等到|不等|没等|待到|直到|等|见到|见|看到|看见|听到|听见|发现|察觉|注意到|随着|面对|对于|因为|由于|趁着?|当)/;
  const TITLE_RE = /^[“「『]([\u3400-\u9fff]{1,6})[”」』](?=[\u3400-\u9fff])/;
  const QUOTE_RE = /[“「『]([^”」』]*)[”」』]/g;
  const END_PUNCT = /[。？！?!…—~～，,、；;）)]$/;

  const nameCharRe = new RegExp('[' + HAN + DOT + ']');

  function stripLead(s) {
    let prev;
    s = s.replace(/^[…—\s　]+/, '');
    do { prev = s; s = s.replace(LEAD_RE, '') } while (s !== prev && s);
    return s;
  }
  /* last sentence of a narration chunk (before a colon or quote) */
  function lastSentence(s) {
    const parts = s.split(/[。！？!?…；;]/);
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].trim()) return parts[i].trim();
    return '';
  }
  function firstClause(s) { return (s.split(/[。！？!?…；;“「]/)[0] || '').trim() }

  /* Split a paragraph into ordered segments: {t:'n', text} narration, {t:'q', text, spoken} quote */
  function segment(p, prevEndsColon) {
    /* multi-paragraph speech: every paragraph opens with “ and only the last one closes it.
       A paragraph that opens a quote it never closes is speech to its end. */
    if (isOpenSpeech(p)) return [{ t: 'q', text: p.slice(1), open: p[0], close: '', spoken: true, open_run: true }];
    const segs = []; let last = 0, m, anySpoken = false;
    QUOTE_RE.lastIndex = 0;
    while ((m = QUOTE_RE.exec(p))) {
      if (m.index > last) segs.push({ t: 'n', text: p.slice(last, m.index) });
      const inner = m[1], before = p.slice(0, m.index), open = p[m.index], close = p[m.index + m[0].length - 1];
      const atStart = m.index === 0 || /[：:]\s*$/.test(before) || /[”」』]\s*$/.test(before);
      const glued = /^[\u3400-\u9fff]/.test(p.slice(m.index + m[0].length)) && !END_PUNCT.test(inner) && inner.length <= 8;
      const spoken = inner.length > 0 && !glued && (
        (atStart && (END_PUNCT.test(inner) || inner.length > 8 || (m.index === 0 && prevEndsColon))) ||
        (/[：:，,]\s*$/.test(before) && SPEECH_RE.test(lastSentence(before).slice(-8)) && inner.length > 1) ||
        (anySpoken && /[：:，,]\s*$/.test(before) && (END_PUNCT.test(inner) || inner.length > 8))   /* “…”X摇头，“…” */
      );
      if (spoken) anySpoken = true;
      segs.push({ t: 'q', text: inner, open, close, spoken });
      last = m.index + m[0].length;
    }
    if (last < p.length) segs.push({ t: 'n', text: p.slice(last) });
    return segs;
  }

  function isOpenSpeech(p) {
    if (!/^[“「『]/.test(p)) return false;
    const o = (p.match(/[“「『]/g) || []).length, c = (p.match(/[”」』]/g) || []).length;
    return o > c;
  }

  /* ---------- pass 1: cast ---------- */
  function* subjectSlots(paras) {
    /* yield raw text that starts at a speaker-subject position */
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      if (/[：:]$/.test(p) && i + 1 < paras.length && /^[“「]/.test(paras[i + 1])) {
        const s = lastSentence(p.replace(/[：:]$/, ''));
        if (SPEECH_RE.test(s.slice(-8))) {
          for (const c of s.split(/[，,]/)) yield stripLead(c.trim());
        }
      }
      QUOTE_RE.lastIndex = 0; let m;
      while ((m = QUOTE_RE.exec(p))) {
        const after = p.slice(m.index + m[0].length);
        const c = firstClause(after);
        if (c && SPEECH_RE.test(c.slice(0, 14))) yield stripLead(c);
        const before = p.slice(0, m.index);
        if (/[：:]\s*$/.test(before)) {
          const s = lastSentence(before.replace(/[：:]\s*$/, ''));
          if (SPEECH_RE.test(s.slice(-8))) for (const cl of s.split(/[，,]/)) yield stripLead(cl.trim());
        }
      }
    }
  }

  function buildCast(chapters, opts = {}) {
    const paras = chapters.flatMap(c => c.paras);
    const cnt = new Map(), ext = new Map(), titles = new Map();
    const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
    for (const slot of subjectSlots(paras)) {
      if (!slot || PRONOUN_RE.test(slot)) continue;
      const qt = slot.match(TITLE_RE);
      if (qt) {                                   /* quoted code name used as a subject */
        const nm = '“' + qt[1] + '”';
        bump(cnt, nm); bump(titles, nm);
        let e = ext.get(nm); if (!e) ext.set(nm, e = new Map());
        bump(e, slot[qt[0].length] || '#');
        continue;
      }
      let k = 0;
      while (k < slot.length && k < 12 && nameCharRe.test(slot[k])) k++;
      const w = slot.slice(0, k);
      for (let L = 1; L <= Math.min(10, w.length); L++) {
        const pre = w.slice(0, L);
        if (DOT.includes(pre[L - 1])) continue;
        bump(cnt, pre);
        const nx = L < slot.length ? slot[L] : '#';
        let e = ext.get(pre); if (!e) ext.set(pre, e = new Map());
        bump(e, nx);
      }
    }
    /* right-branching: a name is followed by many different characters */
    const min = opts.minCount || 4;
    const words = opts.words || { all: new Set(), verbish: new Set() };
    const prefixWord = w => w.length >= 3 && !DOT.split('').some(d => w.includes(d)) && (words.all.has(w.slice(0, 2)) || STOP.has(w.slice(0, 2)));
    const isWord = w => STOP.has(w) || words.all.has(w) ||
      /^(边|一边|用|以|于|却|是|忙|好|半|低|慢|轻|嘴|语|嗓|眸|眼|面朝|下意识|笑容|握|环视|双手|小心|颇|具现|勾勒|拔|轻敲|侧|未|略|穿|笑呵呵|自言自语|金发|黑发|黄发|棕发|红发|白发)/.test(w);
    let cands = [], singles = [], borderline = [];
    for (const [w, c] of cnt) {
      if (w.length === 1) {
        if (c < 15 || SINGLE_STOP.includes(w) || DOT.includes(w)) continue;
        const e = ext.get(w); let top = 0; for (const v of e.values()) top = Math.max(top, v);
        if (e.size >= 8 && top / c < 0.3) singles.push({ name: w, count: c, single: true });
        continue;
      }
      if (titles.has(w)) { if (c >= min && !/^“[嗯啊哦呵哈唔咦哼嘿喂呃噢唉嗬]+”$/.test(w)) cands.push({ name: w, count: c }); continue }
      if (c < min || isWord(w) || FRAG_RE.test(w) || /^(?:[一二三四五六七八九十几两]|这|那|某|每|其|该|此)/.test(w)) continue;
      if (SPEECH_RE.test(w.slice(-2)) && !DOT.split('').some(d => w.includes(d))) continue;
      const e = ext.get(w); let top = 0;
      for (const v of e.values()) top = Math.max(top, v);
      if (top / c > 0.55) continue;                       /* mostly continues with the same char -> not a word end */
      if (prefixWord(w)) { if (c >= 10) borderline.push({ name: w, count: c }); continue }
      cands.push({ name: w, count: c });
    }
    /* starts with a common word (马里奇 / 表面却): keep only if the book also uses it as a noun — 和马里奇, 对马里奇, 马里奇的 */
    if (borderline.length) {
      const nounUse = new Map(borderline.map(b => [b.name, 0]));
      const re = new RegExp('(?:[对向和与跟给把被让替帮陪叫找见问看望朝]|^)(' + borderline.map(b => b.name).join('|') + ')|(' + borderline.map(b => b.name).join('|') + ')(?=的|[，。])', 'g');
      for (const p of paras) { re.lastIndex = 0; let m; while ((m = re.exec(p))) { const n = m[1] || m[2]; nounUse.set(n, nounUse.get(n) + 1) } }
      for (const b of borderline) if (nounUse.get(b.name) >= Math.max(5, b.count * 0.15)) cands.push(b);
    }
    /* drop a candidate that is just a prefix of a stronger one (克莱 vs 克莱恩) */
    cands = cands.filter(a => a.single || !cands.some(b => b !== a && b.name.startsWith(a.name) && !DOT.includes(b.name[a.name.length]) && b.count >= a.count * 0.6));
    /* a one-character name must not just be the first character of other names (艾 from 艾伦/艾辛格) */
    for (const one of singles) {
      const longer = cands.filter(b => b.name[0] === one.name && b.name.split(/[·•‧・]/)[0] !== one.name);
      const real = longer.filter(b => !words.all.has(b.name.slice(1, 3)) && !SPEECH_RE.test(b.name.slice(1, 3)) && b.count >= 8);
      if (real.length) continue;
      /* and the book must also give it as the first part of a full name: 休 / 休·迪尔查 */
      const full = [...cnt.keys()].some(k => k.length > 2 && k.split(/[·•‧・]/)[0] === one.name && /[·•‧・]/.test(k));
      if (full) cands.push(one);
    }
    /* a longer candidate that starts with a one-character name is that name plus a verb (休犹豫) */
    cands = cands.filter(a => !cands.some(b => b !== a && b.single && a.name.length > 1 && a.name.startsWith(b.name) && !DOT.includes(a.name[1])));
    /* drop "name + verb" phrases (克莱恩笑) when the bare name is a candidate */
    cands = cands.filter(a => !cands.some(b => b !== a && a.name.startsWith(b.name) && !DOT.includes(a.name[b.name.length]) && b.count >= a.count));
    /* aliases: 阿兹克·艾格斯 -> 阿兹克, keep the most frequent form as the display name */
    const alias = new Map();
    const isTitle = pre => { for (let i = 0; i <= pre.length - 2; i++) if (words.all.has(pre.slice(i)) || STOP.has(pre.slice(i))) return true; return false };
    for (const a of cands) for (const b of cands)
      if (a !== b && b.name.startsWith(a.name) && DOT.includes(b.name[a.name.length])) alias.set(b.name, a.name);
    for (const a of cands) for (const b of cands)
      if (a !== b && !a.single && a.name.length >= 2 && b.name.length > a.name.length && b.name.endsWith(a.name) && !alias.has(b.name) &&
          isTitle(b.name.slice(0, b.name.length - a.name.length))) alias.set(b.name, alias.get(a.name) || a.name);
    const byName = new Map();
    for (const a of cands) {
      const root = alias.get(a.name) || a.name;
      if (!byName.has(root)) byName.set(root, { id: root, name: root, aliases: [], count: 0 });
      const ch = byName.get(root);
      if (a.name !== root) ch.aliases.push(a.name);
      ch.count += a.count;
    }
    /* count actual speaking turns to rank the cast */
    let cast = [...byName.values()];
    const matcher = makeMatcher(cast);
    const turns = new Map();
    let ctxTail = null;
    for (const ch of chapters) {
      const res = attributeChapter(ch, { list: cast, matcher }, ctxTail);
      ctxTail = res.tail;
      for (const para of res.paras) for (const s of para) if (s.t === 'q' && s.speaker && s.conf !== 'inferred') bump(turns, s.speaker);
    }
    cast.forEach(c => c.lines = turns.get(c.id) || 0);
    /* final sweep: entries that are ordinary words or verb phrases (明白 / 摩挲 / 忍不住又) are not characters */
    const JUNK_RE = /^(?:边|一边|用|以|于|却|是|忙|好|半|低|慢|轻|嘴|语|嗓|眸|眼|面朝|下意识|笑容|握|环视|双手|小心|颇|具现|勾勒|拔|轻敲|侧|未|略|穿|戴|坐|抵|并|急|讪|安静|摩|合|忍)|[又却了着过于]$/;
    cast = cast.filter(c => !/^[“「]/.test(c.name) ? !(words.all.has(c.name) || STOP.has(c.name) || FRAG_RE.test(c.name) || JUNK_RE.test(c.name)) || c.lines >= 200 : true);
    cast = cast.filter(c => c.lines >= (opts.minLines || 5)).sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id));
    cast.forEach((c, i) => { c.rank = i; Object.assign(c, look(c, i)) });
    /* 帕列斯·索罗亚斯德 is also called 帕列斯: add the given name when no one else uses it */
    const taken = new Set(cast.flatMap(c => [c.name, ...(c.aliases || [])]));
    const firstUse = new Map();
    for (const c of cast) for (const n of [c.name, ...(c.aliases || [])]) {
      const parts = n.split(/[·•‧・]/); if (parts.length < 2 || parts[0].length < 2) continue;
      const g = parts[0]; if (taken.has(g) || words.all.has(g) || STOP.has(g)) continue;
      firstUse.set(g, firstUse.has(g) && firstUse.get(g) !== c ? null : c);
    }
    for (const [g, c] of firstUse) if (c) c.aliases.push(g);
    const finalMatcher = makeMatcher(cast);
    estimateGender(paras, cast, finalMatcher);
    return { version: VERSION, list: cast, matcher: finalMatcher };
  }

  /* 他 or 她: count which pronoun picks up right after a character acts as subject */
  function estimateGender(paras, cast, matcher) {
    const m = new Map(), f = new Map(), add = (mp, id) => mp.set(id, (mp.get(id) || 0) + 1);
    for (const p of paras) {
      if (p[0] === '“') continue;
      const sents = p.split(/[。！？!?]/);
      for (let i = 0; i < sents.length; i++) {
        const cls = sents[i].split(/[，,]/);
        const id = matcher.lead(stripLead((cls[0] || '').trim()));
        if (!id) continue;
        const nextCls = cls.slice(1).concat(sents[i + 1] ? sents[i + 1].split(/[，,]/)[0] : []);
        for (const c of nextCls) {
          const t = c.trim();
          if (/^他(?!们)/.test(t)) { add(m, id); break }
          if (/^她(?!们)/.test(t)) { add(f, id); break }
          if (matcher.lead(stripLead(t))) break;
        }
      }
    }
    for (const c of cast) {
      const a = m.get(c.id) || 0, b = f.get(c.id) || 0;
      if (a + b >= 3) { if (a / (a + b) >= 0.75) c.g = 'm'; else if (b / (a + b) >= 0.75) c.g = 'f' }
    }
  }

  function makeMatcher(cast) {
    const forms = [];
    for (const c of cast) { forms.push([c.name, c.id]); for (const a of c.aliases || []) forms.push([a, c.id]) }
    forms.sort((a, b) => b[0].length - a[0].length);
    const map = new Map(forms);
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = forms.length ? new RegExp(forms.map(f => esc(f[0])).join('|'), 'g') : null;
    return {
      /* all name mentions in s: [{id, at, len}] */
      all(s) { if (!re) return []; re.lastIndex = 0; const out = []; let m; while ((m = re.exec(s))) { if (m[0].length > 1) out.push({ id: map.get(m[0]), at: m.index, len: m[0].length }); else re.lastIndex = m.index + 1 } return out },
      lead(s) {
        let t = stripLead(s); if (!re) return null;
        const qt = t.match(TITLE_RE);
        if (qt) {
          const rest = t.slice(qt[0].length);
          re.lastIndex = 0; const m2 = re.exec(rest);
          if (m2 && m2.index === 0) return map.get(m2[0]);        /* “正义”奥黛丽 -> 奥黛丽 */
          return map.get('“' + qt[1] + '”') || null;              /* “世界” */
        }
        re.lastIndex = 0; const m = re.exec(t);
        if (m && m.index === 0) return map.get(m[0]);
        /* short title before the name: 心理医生伊思兰特 / 巨人格罗塞尔 (not 看着X / 对X / 和X) */
        re.lastIndex = 0; const m4 = re.exec(t);
        if (m4 && m4.index >= 2 && m4.index <= 6 && !/^[“「『]/.test(m4[0])) {
          const pre = t.slice(0, m4.index), nextCh = t[m4.index + m4[0].length] || '';
          if (!/[，,。！？：:“”、的了着过]/.test(pre) && !/[向对和与跟给把被让替帮陪叫找见问看望朝冲盯瞥扫打量眼到听]$/.test(pre) &&
              !SUBORD_RE.test(pre) && !/^(?:他|她|它|祂|我|你|您)/.test(pre) && !/[之的]/.test(nextCh)) return map.get(m4[0]);
        }
        const head = t.slice(0, 30), de = head.lastIndexOf('的');
        if (de > 0 && !/^(他|她|它|祂)的/.test(t)) {
          re.lastIndex = de + 1; const m3 = re.exec(t);
          if (m3 && m3.index === de + 1 && !/[，,。！？]/.test(t.slice(0, de))) return map.get(m3[0]);
        }
        return null;
      },
      /* names that are not grammatical objects (对X / 向X / 和X …) */
      subjects(s) { return this.all(s).filter(x => !/[对向朝给跟和与把被让替帮陪叫找见问看望]$/.test(s.slice(Math.max(0, x.at - 1), x.at))) },
    };
  }

  /* ---------- look: stable colour + avatar per character ---------- */
  /* 16 hues spread for distinctness, assigned by speaking rank; ranks beyond get a golden-angle hue
     from a hash of the name. Only depends on the book text, so it is identical on every device. */
  const HUES = [28, 210, 140, 330, 265, 85, 185, 5, 300, 160, 235, 55, 115, 350, 200, 245];
  function hash(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0 } return h }
  function look(c, i) {
    const hue = i < HUES.length ? HUES[i] : Math.round((hash(c.id) * 137.508) % 360);
    const glyph = [...c.name.replace(new RegExp('[' + DOT + ']', 'g'), '')][0] || '?';
    const pattern = hash(c.id) % 4;     /* small avatar ornament so same-initial characters still differ */
    return { hue, glyph, pattern };
  }

  /* ---------- pass 2: attribution ---------- */
  function speakerFromText(s, cast, mode) {
    /* mode 'pre': narration before a quote/colon, subject of its last sentence; 'post': clause after a quote */
    if (mode === 'post') {
      const qt = s.match(TITLE_RE);
      const c = qt ? qt[0] + firstClause(s.slice(qt[0].length)) : firstClause(s);
      if (!c) return null;
      const verbNear = SPEECH_RE.test(c.slice(0, 16));
      const id = cast.matcher.lead(c);
      if (id) return { id, conf: verbNear ? 'explicit' : 'context' };   /* “…”克莱恩放下刀叉 */
      if (!verbNear) return null;
      const t = stripLead(c);
      if (/^(他|她|它|祂)(?![们的])/.test(t)) return { id: null, pronoun: t[0], conf: 'inferred', ctx: '' };
      const near = cast.matcher.all(c.slice(0, 12))[0];
      return near ? { id: near.id, conf: 'explicit' } : null;
    }
    const sent = lastSentence(s.replace(/[：:]\s*$/, ''));
    if (!sent) return null;
    const verb = SPEECH_RE.test(sent.slice(-8));
    /* walk clauses backwards from the speech verb: the nearest clause with a subject owns the verb */
    const clauses = sent.split(/[，,]/);
    for (let ci = clauses.length - 1; ci >= 0; ci--) {
      const t = stripLead(clauses[ci].trim());
      if (!t) continue;
      /* 就听见莎伦…说道 / 听到伦纳德问道 → the one heard is the speaker */
      const heard = t.match(/^(?:就|只)?(?:听见|听到)(.{2,14})$/);
      if (heard && verb && ci === clauses.length - 1) { const h = cast.matcher.lead(heard[1]); if (h) return { id: h, conf: 'explicit' } }
      if (SUBORD_RE.test(t)) continue;                                    /* 等到X…，… : X is not the subject */
      const id = cast.matcher.lead(t);
      if (id) return { id, conf: verb ? 'explicit' : 'context' };
      const pm = t.match(/^(他|她|它|祂)(?![们的])/) || t.match(/^[^，,]{1,14}的(他|她|祂)(?![们的])/);   /* …的他 */
      if (pm) return { id: null, pronoun: pm[1], conf: 'inferred', ctx: clauses.slice(0, ci).join('，') };
      if (PRONOUN_RE.test(t) && !/^(他|她|它|祂)的/.test(t)) return null;
    }
    const any = cast.matcher.subjects(sent);
    if (any.length && verb) return { id: any[any.length - 1].id, conf: 'inferred' };
    return null;
  }

  /* ---------- inner monologue ----------
     The book writes thoughts unquoted, then tags them:
       对！一定是队长赶到附近了！他心中一喜，…      无耻！…！克莱恩不由在心里腹诽了两句。
       我知道了未来的方向……她愉快地在心里补充了一句。
       克莱恩心想：这简直太好了！
     A thought is the text before a ……/？/！ (or 。 when it speaks in the first person)
     whose next clause has a person as subject and a thinking word soon after. */
  const THINK = '思绪|心念|心想|暗想|心道|暗道|想道|腹诽|吐槽|自语|暗忖|嘀咕|在心里|心里|心中|内心|暗自|默默|无声|念头|想着|琢磨|自嘲|暗叹|暗骂|思索|心头|心底|于心';
  const THINK_TAG_RE = new RegExp('^([^，。“”？！…：:；]{1,16}?)(?:' + THINK + ')');
  const THINK_AFTER_RE = new RegExp('(' + THINK + ')(?:了一?句|地|道)?[：:]\\s*$');
  /* split a narration chunk into [{t:'th', text, who}|{t:'n', text}] */
  function splitThoughts(text, cast) {
    const out = [];
    /* X心想：<thought> */
    const colon = text.match(/^(.{1,30}?(?:心想|暗想|心道|暗道|想道|在心里说|心里说))[：:]\s*(.{2,})$/);
    if (colon && !/[“”]/.test(colon[2])) {
      const who = subjectOfClause(colon[1], cast);
      if (who) return [{ t: 'n', text: colon[1] + '：' }, { t: 'th', text: colon[2], who }, { colon: true }];
    }
    const sepRe = /……|[？！?!。]/g;
    let m;
    while ((m = sepRe.exec(text))) {
      const end = m.index + m[0].length;
      if (end < 2 || end > 320) continue;
      const head = text.slice(0, end), tail = text.slice(end);
      const tm = tail.match(THINK_TAG_RE);
      if (!tm) continue;
      if (m[0] === '。' && !/[我咱]/.test(head)) continue;          /* plain narration sentence */
      if (/^[，,]/.test(tail)) continue;
      if ((head.match(/[\u3400-\u9fff]/g) || []).length < 2) continue;
      const who = subjectOfClause(tm[1], cast);
      if (!who) continue;
      out.push({ t: 'th', text: head, who });
      out.push({ t: 'n', text: tail });
      return out;
    }
    return null;
  }
  /* the person a clause starts with: a cast name, or a pronoun ('他'/'她'/'祂') */
  function subjectOfClause(cl, cast) {
    const t = stripLead(cl.trim()).replace(/^(?:不由|忍不住|顿时|立刻|当即)/, '');
    const id = cast.matcher.lead(t);
    if (id) return { id };
    const pm = t.match(/^(他|她|祂)(?![们的])/);
    return pm ? { pronoun: pm[1] } : null;
  }
  /* 他/她/祂 → a cast member.
     1. a name earlier in the same sentence that is not inside a scene-setting clause (这次回答的是马里奇，他…),
     2. otherwise the most recent sentence subject, skipping characters of the wrong gender. */
  function genderOk(c, pr) { if (!c || !c.g || pr === '祂') return true; return pr === '她' ? c.g === 'f' : c.g === 'm' }
  function resolvePronoun(pr, ctx, cast, hist) {
    const byId = cast.byId || (cast.byId = new Map(cast.list.map(c => [c.id, c])));
    if (ctx) {
      const cls = ctx.split(/[，,]/).map(x => stripLead(x.trim())).filter(x => x && !SUBORD_RE.test(x));
      for (let i = cls.length - 1; i >= 0; i--) {
        const ms = cast.matcher.subjects(cls[i]);
        for (let j = ms.length - 1; j >= 0; j--) if (genderOk(byId.get(ms[j].id), pr)) return ms[j].id;
      }
    }
    for (const id of hist) if (genderOk(byId.get(id), pr)) return id;
    return null;
  }
  /* the person a line opens by addressing: “克莱恩，…” / “奥黛丽小姐，…” */
  function vocative(text, cast) {
    const m = text.match(/^([^，,！!？?。…“”]{1,10}?)(?:先生|小姐|女士|阁下|大人|队长|老师|夫人)?[，,！!]/);
    if (!m) return null;
    const id = cast.matcher.lead(m[1]);
    return id && cast.matcher.all(m[1]).length <= 1 && m[1].length <= 8 ? id : null;
  }
  /* subject (lead name) of each clause in a narration chunk; pronoun-led clauses keep the previous subject */
  function subjectsOf(text, cast) {
    const out = [];
    for (const sent of text.split(/[。！？!?…；;：:]/)) {
      for (const cl of sent.split(/[，,]/)) {
        const t = stripLead((cl || '').trim());
        if (!t || SUBORD_RE.test(t)) continue;
        const id = cast.matcher.lead(t);
        if (id) { out.push(id); break }
        if (/^(他|她|祂)/.test(t)) break;
      }
    }
    return out;
  }
  /* chapter: {paras:[...]}. prevTail carries recent speakers across chapter boundaries. */
  /* anchors: {"paragraph:line": castId | null} — speakers already known (reader labels, model answers).
     They are used as facts, so turn-taking and pronouns around them follow. */
  function attributeChapter(chapter, cast, prevTail, anchors) {
    const out = [];
    let recent = prevTail ? prevTail.recent.slice() : [];          /* last speakers, newest first */
    let lastMention = prevTail ? prevTail.lastMention : null;       /* last named character in narration */
    let lastSubject = prevTail ? prevTail.lastSubject : null;       /* last cast member acting as a sentence subject */
    let shortRun = prevTail ? prevTail.shortRun : 0;                /* consecutive short quote-only turns */
    let lastWasDialogue = prevTail ? prevTail.lastWasDialogue : false;
    let run = prevTail ? prevTail.run || null : null;              /* open multi-paragraph speech: {id, conf} */
    const paras = chapter.paras;
    const push = id => { if (!id) return; recent = [id, ...recent.filter(x => x !== id)].slice(0, 4) };
    /* recent sentence subjects, newest first, as [id, age in paragraphs]; a pronoun never reaches further back than ~25 paragraphs */
    let subjHist = prevTail && prevTail.subjHist ? prevTail.subjHist.map(x => x.slice()) : [];
    const pushSubj = id => { if (!id) return; lastSubject = id; subjHist = [[id, 0], ...subjHist.filter(x => x[0] !== id)].slice(0, 6) };
    const liveSubj = () => subjHist.filter(x => x[1] <= 25).map(x => x[0]);
    for (let i = 0; i < paras.length; i++) {
      for (const x of subjHist) x[1]++;
      const p = paras[i], prev = i ? paras[i - 1] : '';
      const prevColon = /[：:]$/.test(prev);
      let segs = segment(p, prevColon);
      if (!(segs[0] && segs[0].t === 'q' && segs[0].spoken)) {
        /* a paragraph that opens with narration may open with an unquoted thought; quoted terms inside it stay part of it */
        let cut = p.length, pos = 0;
        for (const sg of segs) {
          const len = sg.t === 'q' ? sg.text.length + 2 : sg.text.length;
          if (sg.t === 'q' && sg.spoken) { cut = pos; break }
          pos += len;
        }
        const th = splitThoughts(p.slice(0, cut), cast);
        if (th && th[0].t === 'th') {
          const head = th[0].text;
          segs = [th[0], ...segment(p.slice(head.length), false)];
        } else if (th && th[2] && th[2].colon) {
          segs = [th[0], th[1], ...segment(p.slice(cut), false)];
        }
      }
      let paraSpeaker = null, sawQuote = false, narrSinceQuote = '', li = 0;
      const cont = run && /^[“「『]/.test(p) ? run : null;         /* this paragraph continues someone's speech */
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        if (s.t === 'th') {
          let id = s.who.id || null, conf = id ? 'explicit' : 'inferred';
          if (!id) id = resolvePronoun(s.who.pronoun, '', cast, liveSubj()) || null;
          s.speaker = id; s.conf = id ? conf : null; delete s.who;
          if (id) pushSubj(id);
          continue;
        }
        if (s.t === 'n') {
          narrSinceQuote += s.text;
          const ms = cast.matcher.all(s.text);
          if (ms.length) lastMention = ms[ms.length - 1].id;
          for (const sub of subjectsOf(s.text, cast)) pushSubj(sub);
          continue;
        }
        if (!s.spoken) continue;
        let r = null;
        const akey = i + ':' + (li++);
        const before = k > 0 && segs[k - 1].t === 'n' ? segs[k - 1].text : '';
        const after = k + 1 < segs.length && segs[k + 1].t === 'n' ? segs[k + 1].text : '';
        if (k === 0 && cont) {
          r = cont.id ? { id: cont.id, conf: cont.conf } : null;
          if (after.trim()) { const r2 = speakerFromText(after, cast, 'post'); if (r2 && r2.id && r2.conf === 'explicit') r = r2 }
        }
        if (!r && before.trim()) r = speakerFromText(before, cast, 'pre');
        if ((!r || r.conf === 'inferred') && after.trim()) { const r2 = speakerFromText(after, cast, 'post'); if (r2 && (r2.id || !r)) r = r2 }
        if (!r && k === 0 && prevColon) r = speakerFromText(prev, cast, 'pre');
        if (!r && sawQuote && paraSpeaker && !narrSinceQuote.trim()) r = { id: paraSpeaker, conf: 'context' };
        if (!r && sawQuote && paraSpeaker) r = { id: paraSpeaker, conf: 'context' };
        if (r && !r.id && r.pronoun) {
          const id = resolvePronoun(r.pronoun, r.ctx || '', cast, liveSubj());
          r = id ? { id, conf: 'inferred' } : null;
        }
        /* “克莱恩，你……” : the person addressed is not the one speaking */
        const voc = vocative(s.text, cast);
        if (r && voc && r.id === voc && r.conf !== 'explicit') r = null;
        if (!r && voc && recent.length >= 2 && recent.slice(0, 2).includes(voc) && recent[0] !== recent[1])
          r = { id: recent[0] === voc ? recent[1] : recent[0], conf: 'inferred' };
        if (!r && k === 0 && segs.length === 1 && lastWasDialogue && shortRun >= 2 && s.text.length <= 30 &&
            recent.length >= 2 && recent[0] !== recent[1]) {
          r = { id: recent[1], conf: 'inferred' };                 /* quick A, B, A … exchange */
        }
        if (!r && k === 0 && prev && !prevColon && !/[”」』]$/.test(prev)) {
          const clauses = lastSentence(prev).split(/[，,]/);
          const lead = cast.matcher.lead(stripLead((clauses[clauses.length - 1] || '').trim()));
          if (lead) r = { id: lead, conf: 'inferred' };            /* actor of the previous beat */
        }
        if (anchors && Object.prototype.hasOwnProperty.call(anchors, akey)) r = { id: anchors[akey] || null, conf: 'anchor' };
        if (r && r.id) { s.speaker = r.id; s.conf = r.conf; push(r.id); paraSpeaker = r.id }
        else { s.speaker = null; s.conf = null }
        sawQuote = true; narrSinceQuote = '';
      }
      /* “我……”“也……”“不……”“知道……”X说道 : the tag after the last quote covers the whole run */
      for (let k = segs.length - 1; k > 0; k--) {
        const a = segs[k];
        if (!(a.t === 'q' && a.spoken && a.speaker && (a.conf === 'explicit' || a.conf === 'context'))) continue;
        for (let j = k - 1; j >= 0; j--) {
          const b = segs[j];
          if (b.t === 'n' && !b.text.trim()) continue;
          if (!(b.t === 'q' && b.spoken)) break;
          if (b.conf === 'anchor') break;
          if (!b.speaker || b.conf === 'inferred' || b.speaker === a.speaker) { b.speaker = a.speaker; b.conf = a.conf } else break;
        }
      }
      /* a speech that stays open carries its speaker into the next “ paragraph */
      run = segs[0] && segs[0].t === 'q' && segs[0].open_run ? { id: segs[0].speaker || null, conf: segs[0].conf || null } : null;
      const hasDialogue = segs.some(s => s.t === 'q' && s.spoken);
      const narrOnly = !hasDialogue;
      if (narrOnly && p.length > 60) recent = recent.slice(0, 2);  /* long narration loosens turn-taking */
      lastWasDialogue = hasDialogue && segs.every(s => s.t === 'q' || !s.text.trim() || s.text.length < 30);
      const quoteOnly = segs.length === 1 && segs[0].t === 'q' && segs[0].spoken;
      shortRun = quoteOnly && segs[0].text.length <= 30 ? shortRun + 1 : (hasDialogue && segs[0].t === 'q' && segs.every(x => x.t === 'q' || x.text.length < 30) ? 1 : 0);
      out.push(segs);
    }
    return { paras: out, tail: { recent, lastMention, lastSubject, subjHist, shortRun, lastWasDialogue, run } };
  }

  const api = { VERSION, segment, buildCast, attributeChapter, makeMatcher, parseWords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dialogue = api;
})(typeof window !== 'undefined' ? window : globalThis);
