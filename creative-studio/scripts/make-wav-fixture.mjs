// Generates fixtures/sample-project/tone-a440.wav: 2 s, 8 kHz, 16-bit mono, A440 with a fade.
import fs from 'node:fs';
import path from 'node:path';

const rate = 8000, seconds = 2, n = rate * seconds;
const data = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) {
  const env = Math.min(1, i / 400, (n - i) / 1600);
  data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4 * env * 32767), i * 2);
}
const h = Buffer.alloc(44);
h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
h.write('data', 36); h.writeUInt32LE(data.length, 40);
const out = path.join(import.meta.dirname, '..', 'fixtures', 'sample-project', 'tone-a440.wav');
fs.writeFileSync(out, Buffer.concat([h, data]));
console.log('wrote', out);
