/* Builds the cast for a whole book off the main thread (about 1s on a laptop, a few
   seconds on a phone) and returns, for every chapter, the conversation state at its
   start, so any chapter can then be attributed on its own in a few milliseconds. */
importScripts('dialogue.js');
self.onmessage = async e => {
  const { chapters } = e.data;
  try {
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
