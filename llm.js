/* Local model review of dialogue attribution, through Ollama (https://ollama.com).
 *
 * The rules in dialogue.js name the speaker of most lines. The lines they are unsure of
 * (inferred / unknown, plus context-only ones) are sent here, a passage at a time, to a
 * small model running on the reader's own computer. The model may only answer with a
 * name from the book's cast (JSON-schema enum) or "未知", so it can never invent a
 * character, and every colour and avatar stays the same.
 *
 * Works in the browser (window.LocalLLM) and in Node (module.exports) for tools/eval.mjs.
 * Nothing leaves the machine: requests go to http://localhost:11434 by default.
 */
(function (root) {
  'use strict';
  const DEFAULT_HOST = 'http://localhost:11434';
  const DEFAULT_MODEL = 'qwen2.5:7b';
  const UNKNOWN = '未知';
  const MAX_CHARS = 2600;          /* text per request; keeps prompts small for a local model */
  const CONTEXT_PARAS = 6;         /* paragraphs of lead-in before the first line under review */

  function hostOf(h) { return String(h || DEFAULT_HOST).replace(/\/+$/, '') }

  /* GET /api/tags → ['qwen2.5:7b', …]; throws {code:'unreachable'|'http'} */
  async function listModels({ host, fetch: f = root.fetch, timeoutMs = 4000 } = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try { r = await f(hostOf(host) + '/api/tags', { signal: ctl.signal }) }
    catch (e) { throw { code: 'unreachable', message: String(e && e.message || e) } }
    finally { clearTimeout(t) }
    if (!r.ok) throw { code: 'http', status: r.status };
    const j = await r.json();
    return (j.models || []).map(m => m.name);
  }

  /* which lines to review: everything the rules did not state outright */
  function targetsOf(res, anchors) {
    const out = [];
    res.paras.forEach((segs, pi) => {
      let qi = 0;
      for (const s of segs) {
        if (!(s.t === 'q' && s.spoken)) continue;
        const key = pi + ':' + (qi++);
        if (anchors && Object.prototype.hasOwnProperty.call(anchors, key)) continue;
        if (s.conf !== 'explicit' && s.conf !== 'anchor') out.push({ pi, key, s });
      }
    });
    return out;
  }

  /* split the chapter into passages: each holds some target lines plus the paragraphs leading up to them */
  function passages(paras, targets) {
    const out = []; let i = 0;
    while (i < targets.length) {
      const start = Math.max(0, targets[i].pi - CONTEXT_PARAS);
      let end = targets[i].pi, chars = 0;
      for (let p = start; p <= end; p++) chars += paras[p].length;
      let j = i;
      while (j + 1 < targets.length) {
        let add = 0; for (let p = end + 1; p <= targets[j + 1].pi; p++) add += paras[p].length;
        if (chars + add > MAX_CHARS) break;
        chars += add; end = targets[j + 1].pi; j++;
      }
      out.push({ start, end: Math.min(paras.length - 1, end + 1), lines: targets.slice(i, j + 1) });
      i = j + 1;
    }
    return out;
  }

  /* the candidate names for one passage: everyone named in it, recent speakers, the main cast */
  function candidates(text, cast, around) {
    const ids = new Set();
    for (const m of cast.matcher.all(text)) ids.add(m.id);
    for (const id of around) if (id) ids.add(id);
    for (const c of cast.list.slice(0, 12)) ids.add(c.id);
    const byId = cast.byId || (cast.byId = new Map(cast.list.map(c => [c.id, c])));
    return [...ids].map(id => byId.get(id)).filter(Boolean);
  }

  const SYSTEM = [
    '你是中文小说的对话标注员。任务：判断每一句带编号的对话是谁说出口的。',
    '规则：',
    '1. 只能从「候选角色」里选一个名字，原样输出；如果说话的人不在候选里、无法确定、或者这句话其实是书信/日记/念出来的文字且作者不是候选角色，输出“未知”。',
    '2. 「【克莱恩】“……”」表示这句已经确定是克莱恩说的，可以作为上下文线索。',
    '3. 注意：被称呼的人（“X，……”）通常不是说话人；“他/她”指代前文最近的同性别人物；一个人连续说多段话时说话人不变；同一个人可能有别名或代号（如“愚者”）。',
    '4. 只输出 JSON。'
  ].join('\n');

  function buildPrompt(chapter, res, pass, cands, examples) {
    const names = cands.map(c => c.name);
    const label = new Map(pass.lines.map((l, n) => [l.key, 'L' + (n + 1)]));
    const byId = new Map(cands.map(c => [c.id, c]));
    const lines = [];
    for (let pi = pass.start; pi <= pass.end; pi++) {
      let qi = 0;
      const txt = res.paras[pi].map(s => {
        if (s.t === 'q' && s.spoken) {
          const key = pi + ':' + (qi++);
          if (label.has(key)) return '【' + label.get(key) + '】' + s.open + s.text + s.close;
          if (s.speaker && (s.conf === 'explicit' || s.conf === 'anchor') && byId.has(s.speaker)) return '【' + byId.get(s.speaker).name + '】' + s.open + s.text + s.close;
          return s.open + s.text + s.close;
        }
        return s.t === 'q' ? s.open + s.text + s.close : s.text;
      }).join('');
      lines.push(txt);
    }
    const aliasNote = cands.filter(c => (c.aliases || []).length).map(c => `${c.name}（也叫：${c.aliases.slice(0, 4).join('、')}）`);
    let user = `候选角色：${names.join('、')}\n`;
    if (aliasNote.length) user += `别名：${aliasNote.join('；')}\n`;
    if (examples && examples.length) user += '\n读者已确认的例子（同一本书）：\n' + examples.slice(0, 3).map(e => `- ${e.text} → ${e.answer}`).join('\n') + '\n';
    user += `\n正文：\n${lines.join('\n')}\n\n请为 ${pass.lines.map((l, n) => 'L' + (n + 1)).join('、')} 给出说话人。`;
    const schema = {
      type: 'object',
      properties: Object.fromEntries(pass.lines.map((l, n) => ['L' + (n + 1), { type: 'string', enum: [...names, UNKNOWN] }])),
      required: pass.lines.map((l, n) => 'L' + (n + 1)),
    };
    return { user, schema, label };
  }

  async function chat({ host, model, f, system, user, schema, signal }) {
    let r;
    try {
      r = await f(hostOf(host) + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ model, stream: false, format: schema, keep_alive: '10m',
          options: { temperature: 0, num_ctx: 8192 },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw { code: 'timeout' };
      throw { code: 'unreachable', message: String(e && e.message || e) };
    }
    if (r.status === 404) throw { code: 'no_model', model };
    if (!r.ok) throw { code: 'http', status: r.status, message: await r.text().catch(() => '') };
    const j = await r.json();
    const content = j && j.message && j.message.content;
    try { return JSON.parse(content) } catch (e) { throw { code: 'bad_output', message: String(content).slice(0, 200) } }
  }

  /* Review one chapter. Returns {"paragraph:line": castId | null} for every line it reviewed
     (null = the model said 未知). Throws {code} on connection problems. */
  async function reviewChapter({ chapter, res, cast, host, model = DEFAULT_MODEL, fetch: f = root.fetch, anchors, examples,
                                 timeoutMs = 180000, signal, onProgress } = {}) {
    const targets = targetsOf(res, anchors);
    const out = {};
    if (!targets.length) return out;
    const byName = new Map();
    for (const c of cast.list) { byName.set(c.name, c.id); for (const a of c.aliases || []) if (!byName.has(a)) byName.set(a, c.id) }
    const ps = passages(chapter.paras, targets);
    let done = 0;
    for (const pass of ps) {
      if (signal && signal.aborted) throw { code: 'aborted' };
      const text = chapter.paras.slice(pass.start, pass.end + 1).join('');
      const around = [];
      for (let pi = pass.start; pi <= pass.end; pi++) for (const s of res.paras[pi]) if (s.speaker) around.push(s.speaker);
      const cands = candidates(text, cast, around);
      const { user, schema, label } = buildPrompt(chapter, res, pass, cands, examples);
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
      if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
      let ans;
      try { ans = await chat({ host, model, f, system: SYSTEM, user, schema, signal: ctl.signal }) }
      finally { clearTimeout(t) }
      for (const l of pass.lines) {
        const v = ans[label.get(l.key)];
        if (typeof v !== 'string') continue;
        if (v === UNKNOWN) { out[l.key] = null; continue }
        if (byName.has(v)) out[l.key] = byName.get(v);       /* anything outside the cast is ignored */
      }
      done += pass.lines.length;
      if (onProgress) onProgress(done, targets.length);
    }
    return out;
  }

  const api = { DEFAULT_HOST, DEFAULT_MODEL, listModels, reviewChapter, targetsOf, passages, buildPrompt, SYSTEM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocalLLM = api;
})(typeof window !== 'undefined' ? window : globalThis);
