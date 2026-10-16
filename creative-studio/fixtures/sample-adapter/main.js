'use strict';
// Sample Text Kit: the smallest useful CreateCraft integration. It runs in its own restricted process:
// it can read this folder and talk to CreateCraft through `ctx`, nothing else. See docs/external-integration-sdk.md.

exports.probe = async () => ({ version: '1.0.0', detail: 'Self-contained; no program to find.' });
exports.connect = async () => undefined;
exports.healthCheck = async () => ({ ok: true, detail: 'Sample Text Kit is ready.' });
exports.disconnect = async () => undefined;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelled')); }, { once: true });
});

exports.execute = async (command, params, ctx) => {
  switch (command) {
    case 'text.stats': {
      const text = String(params.text);
      const words = (text.match(/\S+/g) || []).length;
      const lines = text.length ? text.split(/\r?\n/).length : 0;
      return {
        message: `${words} words, ${lines} lines, ${text.length} characters.`,
        outputs: [],
        data: { words, lines, characters: text.length },
        evidence: [`counted ${text.length} characters`],
        verified: true,
      };
    }
    case 'report.write': {
      const words = (String(params.text).match(/\S+/g) || []).length;
      const body = `${params.title}\n${'='.repeat(String(params.title).length)}\nWords: ${words}\n\n${params.text}\n`;
      await ctx.writeFile('report.txt', body);
      return { message: `Wrote report.txt (${words} words).`, outputs: ['report.txt'] };
    }
    case 'slow.count': {
      const seconds = Number(params.seconds);
      for (let i = 1; i <= seconds; i++) {
        await sleep(1000, ctx.signal);
        ctx.progress(`Counted ${i} of ${seconds}`, i / seconds);
      }
      return { message: `Counted to ${seconds}.`, outputs: [], data: { counted: seconds }, verified: true };
    }
    case 'selftest.isolation': {
      const results = {};
      try { require('child_process').execSync('cmd /c echo escaped'); results.spawn = 'ALLOWED'; } catch (e) { results.spawn = e.code || 'refused'; }
      try { require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'createcraft-escape.txt'), 'x'); results.write = 'ALLOWED'; } catch (e) { results.write = e.code || 'refused'; }
      const ok = results.spawn !== 'ALLOWED' && results.write !== 'ALLOWED';
      if (!ok) throw ctx.error('verification-failed', `The isolation is not holding: ${JSON.stringify(results)}`);
      return { message: 'The operating system refused both attempts.', outputs: [], data: results, evidence: [`start a program: ${results.spawn}`, `write outside the folder: ${results.write}`], verified: true };
    }
    default:
      throw ctx.error('unsupported', `Unknown command ${command}`);
  }
};
