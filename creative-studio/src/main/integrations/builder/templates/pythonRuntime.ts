// The fixed Python half of the "python-script" template. Written by CreateCraft, not by the AI. The generated command code is
// wrapped by `assemblePythonJob` (python.ts) between RUNTIME_HEAD and RUNTIME_TAIL. Python 3.8 syntax only (Blender 4.0 ships 3.10).

export const RUNTIME_HEAD = String.raw`# CreateCraft AI Adapter Builder: fixed runtime (not written by the AI).
#
# The generated header above defines PHASE ("run" or "verify"), COMMAND, NONCE, PARAMS and PRIOR as DATA (decoded base64 JSON),
# never as code. Everything the AI wrote lives in the factory functions below and may only use the helper object H.
import json as _json
import os as _os
import re as _re
import sys as _sys
import traceback as _tb

_START_DIR = _os.path.realpath(_os.getcwd())
_STEM_RE = _re.compile(r'^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$')
_NAME_RE = _re.compile(r'^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$')
_READ_EXTS = ('.fcstd', '.step', '.stp', '.stl', '.obj', '.png', '.jpg', '.jpeg', '.svg', '.dxf', '.json', '.txt', '.csv', '.blend', '.fbx', '.glb', '.gltf', '.gcode', '.3mf', '.iges', '.igs')
_RESULT_PREFIX = 'CREATECRAFT_RESULT_' + NONCE


class JobError(Exception):
    def __init__(self, kind, message, declared=False):
        Exception.__init__(self, message)
        self.kind = kind
        # True when the command's own code raised it through H.fail / H.check (a check the command itself makes)
        self.declared = declared


class OutFile(str):
    """A path (a str) that also knows its plain file name."""
    @property
    def name(self):
        return _os.path.basename(self)


class _Helpers(object):
    """The only way generated code reaches the project's work folder."""

    def __init__(self, exts):
        self._exts = tuple(exts)
        self.created = []

    def fail(self, kind, message):
        raise JobError(kind if kind in ('app-error', 'unsupported', 'invalid-params', 'verification-failed') else 'app-error', str(message), True)

    def check(self, condition, message):
        if not condition:
            raise JobError('verification-failed', str(message), True)

    def num(self, value):
        return float(getattr(value, 'Value', value))

    def close_enough(self, a, b, rel=1e-6, abs_tol=1e-6):
        return abs(a - b) <= max(abs_tol, rel * max(abs(a), abs(b)))

    def rel(self, path):
        return _os.path.basename(str(path))

    def new_output(self, stem, ext):
        stem = str(stem)
        ext = str(ext)
        if not _STEM_RE.match(stem):
            raise JobError('invalid-params', 'A file name must be 1 to 60 letters, digits, spaces, "-" or "_" (got %r).' % stem[:40])
        if ext not in self._exts:
            raise JobError('app-error', 'This command may not create %s files.' % ext)
        path = _os.path.join(_START_DIR, stem + ext)
        if _os.path.realpath(_os.path.dirname(path)) != _START_DIR:
            raise JobError('invalid-params', 'The file would leave the project work folder.')
        if _os.path.exists(path):
            raise JobError('invalid-params', 'A file named "%s" already exists in the project work folder. Existing files are never overwritten; choose another name.' % (stem + ext))
        self.created.append(stem + ext)
        return OutFile(path)

    def work_path(self, name):
        name = str(name)
        if not _NAME_RE.match(name) or '..' in name or _os.path.splitext(name)[1].lower() not in _READ_EXTS:
            raise JobError('invalid-params', 'Expected a plain file name of a supported type in the project work folder (got %r).' % name[:60])
        path = _os.path.join(_START_DIR, name)
        if _os.path.realpath(_os.path.dirname(path)) != _START_DIR:
            raise JobError('invalid-params', 'The file is not in the project work folder.')
        if not _os.path.isfile(path):
            raise JobError('invalid-params', 'No file "%s" in the project work folder.' % name)
        return OutFile(path)


def _finish(payload):
    _sys.stdout.write('\n' + _RESULT_PREFIX + ' ' + _json.dumps(payload, default=str) + '\n')
    _sys.stdout.flush()
    _sys.stderr.flush()
    _os._exit(0)


def _list_of_str(value, limit):
    out = []
    if isinstance(value, (list, tuple)):
        for v in value:
            if isinstance(v, str):
                out.append(v[:400])
    return out[:limit]


# ---- generated command code (wrapped by CreateCraft into factory functions) ----
`;

export const RUNTIME_TAIL = String.raw`

# ---- dispatcher (fixed) ----
def _health():
    present, missing = [], []
    for m in HOST_MODULES:
        try:
            __import__(m)
            present.append(m)
        except Exception as e:
            missing.append('%s (%s)' % (m, str(e)[:80]))
    if missing and not present:
        raise JobError('app-error', 'The program started but its scripting modules are not available: ' + '; '.join(missing))
    return {
        'message': 'The program runs Python jobs. Scripting modules available: %s.' % (', '.join(present) or 'none needed'),
        'outputs': [], 'data': {'modules': present, 'python': _sys.version.split()[0]},
        'evidence': ['a job ran inside the program', 'Python %s' % _sys.version.split()[0]] + ['module %s imported' % m for m in present[:6]],
        'verified': True,
    }


def _main():
    try:
        if COMMAND == 'app.health':
            _finish(dict(_health(), ok=True))
        if PHASE == 'run':
            if COMMAND not in _RUN:
                raise JobError('unsupported', 'Unknown command %s' % COMMAND)
            helpers = _Helpers(_OUTPUT_EXTS.get(COMMAND, ()))
            result = _RUN[COMMAND]()(PARAMS, helpers)
            if not isinstance(result, dict):
                raise JobError('app-error', 'The command did not return a result.')
            outputs = _list_of_str(result.get('outputs'), 6)
            for name in outputs:
                if name not in helpers.created:
                    raise JobError('verification-failed', 'The command listed "%s" as an output but did not create it through H.new_output.' % name)
            data = result.get('data')
            _finish({
                'ok': True, 'message': str(result.get('message', 'Done.'))[:1000], 'outputs': outputs,
                'data': data if isinstance(data, dict) else {}, 'evidence': _list_of_str(result.get('evidence'), 12), 'verified': False,
            })
        elif PHASE == 'verify':
            if COMMAND not in _VERIFY:
                raise JobError('unsupported', 'No check for command %s' % COMMAND)
            result = _VERIFY[COMMAND]()(PARAMS, PRIOR, _Helpers(()))
            evidence = _list_of_str(result.get('evidence') if isinstance(result, dict) else None, 12)
            if not evidence:
                raise JobError('verification-failed', 'The independent check returned no evidence.')
            _finish({'ok': True, 'evidence': evidence, 'data': result.get('data') if isinstance(result.get('data'), dict) else {}})
        else:
            raise JobError('app-error', 'Unknown phase.')
    except JobError as e:
        _finish({'ok': False, 'kind': e.kind, 'error': str(e)[:1000], 'declared': bool(getattr(e, 'declared', False))})
    except SystemExit:
        raise
    except BaseException as e:
        tb = _tb.format_exc().strip().splitlines()[-3:]
        _finish({'ok': False, 'kind': 'app-error', 'error': ('%s: %s' % (type(e).__name__, str(e)))[:600], 'trace': ' | '.join(tb)[:600]})


_main()
`;
