#!/usr/bin/env node
/* Evaluate speaker attribution against a labels file.

   node tools/eval.mjs <book.txt> <labels.json> [--ollama <model>] [--host http://localhost:11434] [--verbose]

   labels.json: tests/labels-guimi.json, or a file exported from the reader
   (Aa → 管理角色 → 准确率 → 导出标注). Keys are "chapter:paragraph:line".
   Reports, per source, how many lines it named and how many of those were right.
   A label whose speaker is not in the book's cast counts as "should be unknown". */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'dialogue.js'));

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null };
const [bookPath, labelsPath] = args.filter((a, i) => !a.startsWith('--') && !(i && args[i - 1].startsWith('--') && !['--verbose'].includes(args[i - 1])));
if (!bookPath || !labelsPath) { console.error('usage: node tools/eval.mjs book.txt labels.json [--ollama model] [--host url] [--verbose]'); process.exit(1) }
const verbose = args.includes('--verbose');

/* same decoding and chapter split as index.html */
function decode(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch (e) {}
  return new TextDecoder('gb18030').decode(buf);
}
const NUM = '[0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+';
const VOL_RE = new RegExp(`^(第${NUM}[部卷集篇]|卷${NUM})(\\s.*)?$`);
const CH_RE = new RegExp(`^(第${NUM}[章节回话]|序章|序言|楔子|引子|尾声|后记|番外|终章|完本感言|上架感言)(\\s.*|[:：].*)?$`);
function parse(text) {
  const raw = []; let cur = { title: '前言', paras: [] };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim();
    if (t.length && t.length <= 40 && (VOL_RE.test(t) || CH_RE.test(t))) { raw.push(cur); cur = { title: t, paras: [] } }
    else if (t) cur.paras.push(t.replace(/^[\s　]+/, ''));
  }
  raw.push(cur);
  return raw.filter((c, i) => !(i === 0 && !c.paras.length));
}

const chapters = parse(decode(readFileSync(bookPath)));
const doc = JSON.parse(readFileSync(labelsPath, 'utf8'));
const labels = doc.labels || doc.line || {};
let words;
try { words = D.parseWords(readFileSync(path.join(here, '..', 'dialogue-words.txt'), 'utf8')) } catch (e) {}
const t0 = Date.now();
const cast = D.buildCast(chapters.map(c => ({ paras: c.paras })), { words });
const tails = []; { let tail = null; for (const ch of chapters) { tails.push(tail); tail = D.attributeChapter(ch, cast, tail).tail } }
console.log(`book: ${chapters.length} chapters, cast ${cast.list.length}, analysed in ${Date.now() - t0} ms`);

/* name equivalence: personas / code names count as the same person */
const canon = new Map();
for (const [k, list] of Object.entries(doc.equiv || {})) { canon.set(k, k); for (const n of list) canon.set(n, k) }
const byId = new Map(cast.list.map(c => [c.id, c]));
for (const c of cast.list) for (const a of c.aliases || []) if (!canon.has(a)) canon.set(a, canon.get(c.name) || c.name);
const C = n => (n == null ? null : canon.get(n) || n);
const castCanon = new Set(cast.list.map(c => C(c.name)));

/* group labels by chapter */
const byCh = new Map();
for (const [k, v] of Object.entries(labels)) {
  const [ci, pi, qi] = k.split(':').map(Number);
  if (!byCh.has(ci)) byCh.set(ci, []);
  byCh.get(ci).push({ key: k, pi, qi, gold: v === '' ? null : v });
}

let llm = null;
const model = opt('--ollama');
if (model) {
  const L = require(path.join(here, '..', 'llm.js'));
  llm = { L, model, host: opt('--host') || 'http://localhost:11434' };
}

const stat = {}; const bump = (src, ok) => { const s = stat[src] || (stat[src] = { n: 0, ok: 0 }); s.n++; if (ok) s.ok++ };
const confusions = new Map(); let missing = 0, total = 0, finalOk = 0, finalNamed = 0, finalNamedOk = 0;
for (const [ci, items] of [...byCh].sort((a, b) => a[0] - b[0])) {
  const ch = chapters[ci];
  if (!ch) { missing += items.length; continue }
  const res = D.attributeChapter(ch, cast, tails[ci]);
  const lines = new Map();
  res.paras.forEach((segs, pi) => { let qi = 0; for (const s of segs) if (s.t === 'q' && s.spoken) lines.set(pi + ':' + (qi++), s) });
  let mres = null;
  if (llm) {
    const t1 = Date.now();
    try { mres = await llm.L.reviewChapter({ chapter: ch, ci, res, cast, host: llm.host, model: llm.model, fetch }) }
    catch (e) { console.log(`ch ${ci}: model error ${e.message || e}`) }
    if (mres) console.log(`ch ${ci}: model reviewed ${Object.keys(mres).length} lines in ${Date.now() - t1} ms`);
  }
  for (const it of items) {
    total++;
    const s = lines.get(it.pi + ':' + it.qi);
    if (!s) { missing++; if (verbose) console.log('  not a detected line:', it.key, it.gold); continue }
    const want = it.gold && castCanon.has(C(it.gold)) ? C(it.gold) : null;   /* speaker outside the cast → should be unknown */
    const rule = s.speaker ? C(byId.get(s.speaker).name) : null;
    const src = 'rule:' + (s.conf || 'none');
    bump(src, rule === want);
    let fin = rule, finSrc = src;
    if (mres && mres[it.pi + ':' + it.qi] !== undefined && s.conf !== 'explicit') {
      const m = mres[it.pi + ':' + it.qi]; const mv = m ? C(byId.get(m).name) : null;
      bump('model', mv === want);
      if (m) { fin = mv; finSrc = 'model' }
    }
    if (fin === want) finalOk++;
    if (fin) { finalNamed++; if (fin === want) finalNamedOk++ }
    if (fin !== want) {
      const k = `${want || '(未知)'} ← ${fin || '(未知)'}`; confusions.set(k, (confusions.get(k) || 0) + 1);
      if (verbose) console.log(`  ✗ ${it.key} gold=${it.gold} got=${fin || '-'} via ${finSrc}`);
    }
  }
}
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '-';
console.log(`\nlabels ${total}, matched to detected lines ${total - missing}${missing ? ` (${missing} not found as lines)` : ''}\n`);
console.log('source            lines   correct');
for (const k of ['rule:explicit', 'rule:context', 'rule:inferred', 'rule:none', 'model']) if (stat[k]) console.log(`${k.padEnd(16)} ${String(stat[k].n).padStart(6)}   ${pct(stat[k].ok, stat[k].n)}`);
console.log(`\noverall correct      ${pct(finalOk, total - missing)}  (unknown counts as correct only when the speaker is outside the cast)`);
console.log(`named lines correct  ${pct(finalNamedOk, finalNamed)}  (${finalNamed} of ${total - missing} lines got a name)`);
console.log('\nmost common mistakes (truth ← shown):');
for (const [k, n] of [...confusions].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(3)}  ${k}`);
