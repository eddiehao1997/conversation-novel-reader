/* Background work on a whole book, so the page never freezes on a phone:
   - build:  find the cast (about 1s on a laptop) and the conversation state at the start of every chapter
   - extend: add the reader's own characters and recompute that state for the whole book */
importScripts('dialogue.js');
self.onmessage = async e => {
  const { chapters, type } = e.data;
  try {
    if (type === 'extend') {
      const r = Dialogue.extendCast(chapters, e.data.base, e.data.customs);
      self.postMessage({ ok: true, extra: r.extra, tails: r.tails });
      return;
    }
    const t0 = Date.now();
    let words;
    try { words = Dialogue.parseWords(await (await fetch('dialogue-words.txt')).text()) } catch (err) { words = undefined }
    const cast = Dialogue.buildCast(chapters, { words });
    const tails = []; let tail = null;
    for (const ch of chapters) { tails.push(tail); tail = Dialogue.attributeChapter(ch, cast, tail).tail }
    self.postMessage({ ok: true, version: Dialogue.VERSION, list: cast.list, tails, ms: Date.now() - t0, words: !!words });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
