// SPECIAL rule "SHADOW" (in-game half; the chart comes from mod-tools/rules/shadow.js).
// You lead a phrase, syuP plays it back as your shadow — with your own timing: hit 30 ms early and syuP is 30 ms early
// too. A lead note you miss leaves a "?" gap in the copy. Judgement of your notes is the normal one; syuP's notes are
// never judged. Only this run is touched.
(() => {
  const CLAMP = 0.15;   // syuP copies at most the GOOD window
  const habit = ms => Math.abs(ms) < 12 ? 'ぴったり' : ms < 0 ? `ちょっと早め（${ms}ms）` : `ちょっと遅め（+${ms}ms）`;
  SyupRules.register('shadow', {
    intro: { shadow: { label: 'SHADOW', text: 'あなたが先に叩いたフレーズを、あとで syuP がまねする。早い・遅いのクセまでそっくり' } },
    labels: { partner: '♪ syuP まねっこ中', you: 'YOU LEAD', both: '♪ TOGETHER' },
    cues: { partner: '♪ syuP がまねするよ', you: 'YOU LEAD!', both: 'TOGETHER!' },
    setup(api) {
      const r = api.run, lead = new Map();
      r.notes.forEach(n => { if (!n.partner && n.raw.sid !== undefined) lead.set(n.raw.sid, n); });
      r.shadow = { links: new Map(), total: 0, copied: 0, gaps: 0, offsets: [] };
      for (const n of r.partnerNotes) {
        const src = lead.get(n.raw.shadowOf); if (!src) continue;
        n.hidden = true; n.baseTime = n.time; r.shadow.total++;
        if (!r.shadow.links.has(src)) r.shadow.links.set(src, []);
        r.shadow.links.get(src).push(n);
      }
    },
    judge(api, note, kind, { delta, tail }) {
      const sh = api.run.shadow, list = !tail && sh && sh.links.get(note); if (!list) return;
      for (const n of list) {
        n.hidden = false;
        if (kind === 'MISS') { n.silent = true; n.mark = '?'; sh.gaps++; continue; }
        const d = Math.max(-CLAMP, Math.min(CLAMP, delta || 0));
        n.time = n.baseTime + d; n.end = n.time + (n.duration || 0); sh.copied++; sh.offsets.push(d);
      }
    },
    result(api, res) {
      const sh = api.run.shadow; if (!sh || !sh.total) return null;
      const rate = sh.copied / sh.total, ms = sh.offsets.length ? Math.round(sh.offsets.reduce((a, b) => a + b, 0) / sh.offsets.length * 1000) : 0;
      const [title, ja] = rate >= 0.98 ? ['PERFECT MIRROR', 'syuP が全部まねできた！'] : rate >= 0.85 ? ['GREAT LEADER', 'ほとんどまねできたよ'] : rate >= 0.6 ? ['GOOD LEADER', 'いいお手本でした'] : ['FIRST LESSON', 'syuP もいっしょに練習中！'];
      res.shadowRate = rate;
      return { small: 'SHADOW — syuP があなたをまねっこ', title, ja, em: `まねできた音 ${sh.copied} / ${sh.total}　あなたのクセ: ${habit(ms)}`, celebrate: rate >= 0.98 ? 4 : 0, bloom: rate >= 0.9 };
    },
    save(api, rec, res) {
      if (res.shadowRate === undefined) return;
      rec.bestShadow = Math.max(rec.bestShadow || 0, +res.shadowRate.toFixed(4));
      rec.ruleStats = { 'まねっこ': `${(rec.bestShadow * 100).toFixed(1)}%` };
    }
  });
})();
