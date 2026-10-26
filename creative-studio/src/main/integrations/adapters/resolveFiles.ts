// Resolve Free edition support: files the person imports into Resolve themselves (File > Import > Timeline / Subtitle).
// Pure builders, no Resolve needed. Free Resolve refuses outside scripting, so this is the route that works there.

export const EDL_FPS = [23.976, 24, 25, 30, 50, 60] as const;
export const MAX_CLIPS = 500;
export const MAX_CUES = 2000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface EdlClip { file: string; in_seconds?: number; duration_seconds: number }
export interface SrtCue { start: number; end: number; text: string }

/** Schema check for the json parameter of a command; returns a problem text or undefined. */
export function validateResolveJson(commandId: string, param: string, value: unknown): string | undefined {
  if (commandId === 'timeline.write_edl' && param === 'clips') {
    if (!Array.isArray(value) || !value.length) return 'clips must be a list like [{"file": "shot1.mp4", "duration_seconds": 5}].';
    if (value.length > MAX_CLIPS) return `at most ${MAX_CLIPS} clips.`;
    for (const [i, c] of value.entries()) {
      if (!isObj(c)) return `clip ${i + 1} must be an object.`;
      if (Object.keys(c).some((k) => !['file', 'in_seconds', 'duration_seconds'].includes(k))) return `clip ${i + 1} may only have "file", "in_seconds" and "duration_seconds".`;
      if (typeof c.file !== 'string' || !c.file.trim() || c.file.length > 200) return `clip ${i + 1}: file must be a file name of 1 to 200 characters.`;
      if (!num(c.duration_seconds) || c.duration_seconds <= 0 || c.duration_seconds > 86_400) return `clip ${i + 1}: duration_seconds must be more than 0 and at most 86400.`;
      if ('in_seconds' in c && (!num(c.in_seconds) || c.in_seconds < 0 || c.in_seconds > 86_400)) return `clip ${i + 1}: in_seconds must be 0 or more.`;
    }
    return undefined;
  }
  if (commandId === 'media.import' && param === 'paths') {
    if (!Array.isArray(value) || !value.length) return 'paths must be a list of full file paths.';
    if (value.length > 200) return 'at most 200 files at once.';
    for (const [i, f] of value.entries()) {
      if (typeof f !== 'string' || f.length > 400 || !/^([A-Za-z]:[\\/]|\/)/.test(f)) return `path ${i + 1} must be a full path such as C:\\Media\\shot1.mp4.`;
    }
    return undefined;
  }
  if (commandId === 'subtitles.write_srt' && param === 'cues') {
    if (!Array.isArray(value) || !value.length) return 'cues must be a list like [{"start": 0, "end": 2.5, "text": "Hello"}].';
    if (value.length > MAX_CUES) return `at most ${MAX_CUES} cues.`;
    let last = 0;
    for (const [i, c] of value.entries()) {
      if (!isObj(c)) return `cue ${i + 1} must be an object.`;
      if (Object.keys(c).some((k) => !['start', 'end', 'text'].includes(k))) return `cue ${i + 1} may only have "start", "end" and "text".`;
      if (!num(c.start) || !num(c.end) || c.start < 0 || c.end <= c.start || c.end > 86_400) return `cue ${i + 1}: start must be 0 or more and end later than start (seconds).`;
      if (c.start < last) return `cue ${i + 1} starts before the previous one ends; list cues in time order without overlap.`;
      last = c.end;
      if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 500) return `cue ${i + 1}: text must be 1 to 500 characters.`;
    }
    return undefined;
  }
  return undefined;
}

function tc(frames: number, base: number): string {
  const f = frames % base, s = Math.floor(frames / base);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}

/** CMX3600 EDL, non-drop frame. The clip name comment is what Resolve matches to media already in the media pool. */
export function buildEdl(title: string, fps: number, clips: EdlClip[], withAudio: boolean, startHour = 1): string {
  if (!(EDL_FPS as readonly number[]).includes(fps)) throw new Error(`fps must be one of ${EDL_FPS.join(', ')}.`);
  const base = Math.round(fps);
  let rec = startHour * 3600 * base;
  const lines = [`TITLE: ${title}`, 'FCM: NON-DROP FRAME', ''];
  clips.forEach((c, i) => {
    const inF = Math.round((c.in_seconds ?? 0) * fps);
    const len = Math.max(1, Math.round(c.duration_seconds * fps));
    const name = c.file.replace(/[\r\n]+/g, ' ').trim();
    lines.push(`${String(i + 1).padStart(3, '0')}  AX       ${withAudio ? 'AA/V' : 'V   '}  C        ${tc(inF, base)} ${tc(inF + len, base)} ${tc(rec, base)} ${tc(rec + len, base)}`);
    lines.push(`* FROM CLIP NAME: ${name}`, '');
    rec += len;
  });
  return lines.join('\r\n');
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

export function buildSrt(cues: SrtCue[]): string {
  return cues.map((c, i) => `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${c.text.replace(/\r?\n\s*\r?\n/g, '\n').trim()}\r\n`).join('\r\n');
}
