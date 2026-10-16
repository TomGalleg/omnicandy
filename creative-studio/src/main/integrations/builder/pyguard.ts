// Safety scan for AI-written Python. Two layers, both always reported:
//   1. A real syntax-tree check run by a Python interpreter when one is available (pyguard.py below).
//   2. A lexical scan in TypeScript that works without Python and double-checks the same lists.
// This is a safety NET, not a sandbox: the code still runs inside the target program with that program's privileges. What it
// does is refuse the common ways out (processes, files, networks, the interpreter's internals) and make the rest reviewable.

import { execFile } from 'node:child_process';
import { DENIED_ATTRIBUTES, DENIED_BUILTINS, DENIED_MODULES, PLAIN_METHODS, SAFE_STDLIB } from './hosts';

export interface PySource { name: string; kind: 'run' | 'verify'; text: string }

export interface PyFinding {
  name: string;
  ok: boolean;
  problems: string[];
  /** Dotted symbols rooted in an imported host module, e.g. "Part.makeBox". */
  moduleSymbols: string[];
  /** Names of methods called on objects (anything not a plain Python method), e.g. "cut". */
  methodCalls: string[];
  usesWorkPath: boolean;
  usesNewOutput: boolean;
}

export interface PyGuardReport { engine: 'python-ast' | 'lexical-only'; python: string | null; findings: PyFinding[]; note: string }

// The syntax-tree checker. Reads {sources, rules} as JSON on stdin and prints {results: [...]} as JSON.
const PYGUARD_PY = String.raw`
import ast, json, re, sys

data = json.load(sys.stdin)
rules = data["rules"]
HOST = set(rules["hostModules"])
ALLOWED = HOST | set(rules["safeStdlib"])
DENIED_MODULES = set(rules["deniedModules"])
DENIED_BUILTINS = set(rules["deniedBuiltins"])
DENIED_ATTRS = set(rules["deniedAttributes"])
PLAIN = set(rules["plainMethods"])
ABS_PATH = re.compile(r'^(?:[A-Za-z]:[\\/]|\\\\|/[A-Za-z]|~)')
BAD_STR = re.compile(r'(?:\.\.[\\/]|[\\/]\.\.|://|^file:)')

def literal_only(node):
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return all(literal_only(e) for e in node.elts)
    if isinstance(node, ast.Dict):
        return all((k is None or literal_only(k)) and literal_only(v) for k, v in zip(node.keys, node.values))
    if isinstance(node, ast.UnaryOp):
        return literal_only(node.operand)
    if isinstance(node, ast.BinOp):
        return literal_only(node.left) and literal_only(node.right)
    return False

def chain(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return list(reversed(parts))
    return None

def analyse(src):
    name, kind, text = src["name"], src["kind"], src["text"]
    problems, symbols, methods = [], set(), set()
    uses_work = uses_out = False
    try:
        tree = ast.parse(text)
    except SyntaxError as e:
        return {"name": name, "ok": False, "problems": ["syntax error on line %s: %s" % (e.lineno, e.msg)], "moduleSymbols": [], "methodCalls": [], "usesWorkPath": False, "usesNewOutput": False}
    want = "run" if kind == "run" else "verify"
    want_args = ["P", "H"] if kind == "run" else ["P", "R", "H"]
    found_entry = False
    aliases = {}
    nodes = 0
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        if isinstance(node, ast.FunctionDef):
            if node.name == want:
                found_entry = True
                if [a.arg for a in node.args.args] != want_args or node.args.vararg or node.args.kwarg or node.args.kwonlyargs:
                    problems.append("def %s must take exactly (%s)" % (want, ", ".join(want_args)))
            elif not node.name.startswith("_"):
                problems.append("extra function '%s' must start with an underscore" % node.name)
            continue
        if isinstance(node, ast.Assign) and literal_only(node.value):
            continue
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
            continue
        problems.append("only imports, helper functions and constants may stand outside def %s (line %s)" % (want, getattr(node, "lineno", "?")))
    if not found_entry:
        problems.append("the source must define def %s(%s)" % (want, ", ".join(want_args)))
    for node in ast.walk(tree):
        nodes += 1
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.ImportFrom):
                if node.level:
                    problems.append("relative import on line %s" % node.lineno)
                    continue
                mods = [(node.module or "", None)]
                for a in node.names:
                    if a.name == "*":
                        problems.append("'from %s import *' is not allowed (line %s)" % (node.module, node.lineno))
            else:
                mods = [(a.name, a.asname) for a in node.names]
            for mod, asname in mods:
                root = mod.split(".")[0]
                if root in DENIED_MODULES or root not in ALLOWED:
                    problems.append("import of '%s' is not allowed (line %s)" % (mod, node.lineno))
                    continue
                if isinstance(node, ast.Import):
                    aliases[asname or root] = mod
                else:
                    for a in node.names:
                        if a.name != "*":
                            aliases[a.asname or a.name] = mod + "." + a.name
                            if root in HOST:
                                symbols.add(mod + "." + a.name)
        elif isinstance(node, (ast.ClassDef, ast.AsyncFunctionDef, ast.Global, ast.Nonlocal, ast.Await, ast.Yield, ast.YieldFrom, ast.AsyncFor, ast.AsyncWith)):
            problems.append("%s is not allowed (line %s)" % (type(node).__name__, getattr(node, "lineno", "?")))
        elif isinstance(node, ast.Name):
            if node.id in DENIED_BUILTINS or node.id in DENIED_MODULES:
                problems.append("use of '%s' is not allowed (line %s)" % (node.id, node.lineno))
            elif node.id.startswith("__"):
                problems.append("use of '%s' is not allowed (line %s)" % (node.id, node.lineno))
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") or node.attr in DENIED_ATTRS:
                problems.append("access to '.%s' is not allowed (line %s)" % (node.attr, node.lineno))
            c = chain(node)
            if c:
                if c[0] == "H" and len(c) > 1:
                    if c[1] == "work_path": uses_work = True
                    if c[1] == "new_output": uses_out = True
                real = aliases.get(c[0])
                if real and real.split(".")[0] in HOST:
                    symbols.add(".".join([real] + c[1:]))
        elif isinstance(node, ast.Call):
            f = node.func
            if isinstance(f, ast.Attribute) and f.attr not in PLAIN:
                methods.add(f.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            s = node.value
            if len(s) < 400 and (ABS_PATH.search(s) or BAD_STR.search(s)):
                problems.append("the text %r looks like a file path or address; files go through H only" % s[:60])
        if nodes > 12000:
            problems.append("the source is too large to review")
            break
    return {"name": name, "ok": not problems, "problems": sorted(set(problems))[:20], "moduleSymbols": sorted(symbols), "methodCalls": sorted(methods), "usesWorkPath": uses_work, "usesNewOutput": uses_out}

json.dump({"results": [analyse(s) for s in data["sources"]]}, sys.stdout)
`;

const RULES = () => ({
  deniedModules: DENIED_MODULES, deniedBuiltins: DENIED_BUILTINS, deniedAttributes: DENIED_ATTRIBUTES, plainMethods: [...PLAIN_METHODS], safeStdlib: SAFE_STDLIB,
});

let pythonCache: Promise<string | null> | null = null;

/** The absolute path of the first working Python 3 interpreter on this PC, or null. */
export function findPython(): Promise<string | null> {
  pythonCache ??= (async () => {
    const candidates: Array<[string, string[]]> = process.env.CREATECRAFT_PYTHON
      ? [[process.env.CREATECRAFT_PYTHON, []]]
      : [['python', []], ['py', ['-3']]];
    for (const [c, pre] of candidates) {
      const out = await new Promise<string | null>((res) => execFile(c, [...pre, '-c', 'import sys;print(sys.version_info[0], sys.executable)'], { timeout: 15_000, windowsHide: true }, (e, o) => res(e ? null : String(o).trim())));
      const m = out ? /^3 (.+)$/.exec(out) : null;
      if (m?.[1]) return m[1];
    }
    return null;
  })();
  return pythonCache;
}

export function pythonArgs(_py: string, rest: string[]): string[] { return rest; }

// ---- layer 2: lexical scan (no Python needed) ----

/** Source with comments and the inside of string literals blanked, so words in text do not trigger rules. */
export function blankStringsAndComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      out += q;
      i += q.length;
      while (i < n && !src.startsWith(q, i)) { if (src[i] === '\\') { i += 2; continue; } out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += q;
      i += q.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function lexicalFindings(s: PySource, hostModules: string[]): PyFinding {
  const problems: string[] = [];
  const code = blankStringsAndComments(s.text);
  const allowed = new Set([...hostModules, ...SAFE_STDLIB]);
  for (const m of code.matchAll(/^[ \t]*import[ \t]+([^\n]+)$/gm)) {
    for (const part of m[1]!.split(',')) {
      const mod = part.trim().split(/\s+as\s+/)[0]!.trim().split('.')[0]!;
      if (mod && !allowed.has(mod)) problems.push(`import of '${mod}' is not allowed`);
    }
  }
  for (const m of code.matchAll(/^[ \t]*from[ \t]+(\.*)([A-Za-z_][\w.]*)?[ \t]+import[ \t]+([^\n]+)$/gm)) {
    if (m[1]) problems.push('relative import is not allowed');
    const mod = (m[2] ?? '').split('.')[0]!;
    if (mod && !allowed.has(mod)) problems.push(`import of '${mod}' is not allowed`);
    if (m[3]!.trim().startsWith('*')) problems.push("'import *' is not allowed");
  }
  for (const b of DENIED_BUILTINS) if (new RegExp(`(?<![\\w.])${b}\\s*\\(`).test(code)) problems.push(`call of '${b}()' is not allowed`);
  for (const m of DENIED_MODULES) if (new RegExp(`(?<![\\w])${m}\\s*\\.`).test(code)) problems.push(`use of the '${m}' module is not allowed`);
  for (const a of DENIED_ATTRIBUTES) if (new RegExp(`\\.\\s*${a}\\b`).test(code)) problems.push(`access to '.${a}' is not allowed`);
  if (/\.\s*__\w+__/.test(code) || /(?<![\w.])__\w+__/.test(code)) problems.push('names with double underscores are not allowed');
  if (/^[ \t]*class[ \t]/m.test(code)) problems.push('classes are not allowed');
  for (const m of s.text.matchAll(/(['"])((?:\\.|(?!\1).){2,300})\1/g)) {
    const t = m[2]!;
    if (/^(?:[A-Za-z]:[\\/]|\\\\|\/[A-Za-z]|~)/.test(t) || /(?:\.\.[\\/]|[\\/]\.\.|:\/\/)/.test(t)) problems.push(`the text '${t.slice(0, 40)}' looks like a file path or address; files go through H only`);
  }
  const want = s.kind === 'run' ? /^def run\(P, H\):/m : /^def verify\(P, R, H\):/m;
  if (!want.test(s.text)) problems.push(s.kind === 'run' ? 'the source must define def run(P, H)' : 'the source must define def verify(P, R, H)');
  return { name: s.name, ok: !problems.length, problems: [...new Set(problems)].slice(0, 20), moduleSymbols: [], methodCalls: [], usesWorkPath: /\bH\s*\.\s*work_path\b/.test(code), usesNewOutput: /\bH\s*\.\s*new_output\b/.test(code) };
}

export async function guardPython(sources: PySource[], hostModules: string[]): Promise<PyGuardReport> {
  const lexical = sources.map((s) => lexicalFindings(s, hostModules));
  const py = await findPython();
  if (!py) {
    return { engine: 'lexical-only', python: null, findings: lexical, note: 'No Python interpreter was found on this PC, so only the text-level safety scan ran. The syntax-tree check was skipped.' };
  }
  const payload = JSON.stringify({ sources, rules: { ...RULES(), hostModules } });
  const out = await new Promise<string | null>((resolve) => {
    const child = execFile(py, pythonArgs(py, ['-I', '-B', '-c', PYGUARD_PY]), { timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => resolve(e ? null : String(stdout)));
    child.stdin?.end(payload);
  });
  let ast: Array<Omit<PyFinding, never>> | null = null;
  try { ast = out ? (JSON.parse(out) as { results: PyFinding[] }).results : null; } catch { ast = null; }
  if (!ast) return { engine: 'lexical-only', python: py, findings: lexical, note: 'The syntax-tree check could not run; only the text-level safety scan ran.' };
  const findings = sources.map((s, i) => {
    const a = ast!.find((x) => x.name === s.name) ?? ast![i]!;
    const l = lexical[i]!;
    const problems = [...new Set([...a.problems, ...l.problems])];
    return { ...a, problems, ok: !problems.length };
  });
  return { engine: 'python-ast', python: py, findings, note: 'Syntax-tree check and text-level scan both ran.' };
}
