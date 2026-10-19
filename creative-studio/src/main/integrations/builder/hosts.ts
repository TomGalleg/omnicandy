// OmniCandi's own table of programs that run Python jobs, and the safety lists the validators use. Owned by OmniCandi:
// a blueprint can pick a row (or, for an unknown program, describe a launch line that is checked against strict rules), but it
// cannot change a row. Nothing here runs anything.

export interface PythonHost {
  id: 'freecad' | 'blender' | 'custom';
  label: string;
  exeNames: string[];
  displayNames: string[];
  /** Arguments that make the program print its version and exit. */
  versionArgs: string[];
  /** First capture group = version. */
  versionRegex: string;
  /** Arguments that run the job script; `{run}` is replaced by the launcher file name inside the work folder (a full path when absolutePaths). */
  launchArgs: string[];
  /** "file": the program has no version option; the version found when the program was detected is used. */
  versionFrom: 'command' | 'file';
  /** A project file extension (".uproject") when the program must be started with a project; commands then take a `project` setting placed at {project}. */
  projectExtension: string | null;
  /** The program may change its working folder, so the job gets full paths (launcher, job file and work folder). */
  absolutePaths: boolean;
  /** Modules the host program provides (imports the generated code may use besides the safe standard library). */
  hostModules: string[];
  /** The program's core modules: a class or function defined anywhere in its documentation counts for a symbol written Core.Name. */
  coreModules: string[];
  /** Python's bytecode cache keys on size + whole-second mtime; programs that import the script as a module need the launcher indirection. */
  launcher: 'exec-stub' | 'direct';
  /** Symbols OmniCandi recognises. A module-level symbol outside the list is flagged "not recognised" (a warning, never trusted). */
  knownSymbols: RegExp[];
  docs: string[];
  /** Newest version OmniCandi has actually run its scripts on, if any (documentation only). */
  testedNote: string;
}

const FREECAD_SYMBOLS = [
  /^Part\.(makeBox|makeCylinder|makeSphere|makeCone|makeTorus|makePlane|makeLine|makeCircle|makePolygon|makeCompound|makeLoft|makeRuledSurface|makeHelix|makeShell|makeSolid|makeWedge|makeRevolution|makeLongHelix|makeSplineApprox|Face|Wire|Shape|Solid|Compound|Shell|Edge|Vertex|Circle|LineSegment|Plane|read|show|export|Feature|BRepFormat|__version__)$/,
  /^FreeCAD\.(newDocument|openDocument|closeDocument|listDocuments|setActiveDocument|ActiveDocument|Vector|Placement|Rotation|Matrix|Units|Console|Version|Base|Document|getDocument|getUserAppDataDir)$/,
  /^App\.(newDocument|openDocument|closeDocument|listDocuments|ActiveDocument|Vector|Placement|Rotation|Units|Version|Console)$/,
  /^(Mesh)\.(Mesh|export|read|show)$/,
  /^MeshPart\.(meshFromShape|findSectionParameters)$/,
  /^Import\.(insert|export|open|readDXF|writeDXF)$/,
  /^Spreadsheet\./,
  /^Draft\./,
  /^Sketcher\./,
  /^PartDesign\./,
];

const BLENDER_SYMBOLS = [
  /^bpy\.(ops|data|context|types|app|props|utils|path)(\.|$)/,
  /^bmesh\.(new|from_edit_mesh|from_mesh|ops|types|geometry|utils)(\.|$)/,
  /^mathutils\.(Vector|Matrix|Euler|Quaternion|Color|geometry|noise|kdtree|bvhtree)(\.|$)/,
];

export const PYTHON_HOSTS: Record<'freecad' | 'blender', PythonHost> = {
  freecad: {
    id: 'freecad', label: 'FreeCAD', exeNames: ['FreeCADCmd.exe'], displayNames: ['FreeCAD'],
    versionArgs: ['--version'], versionRegex: 'FreeCAD\\s+(\\d+(?:\\.\\d+){1,2})',
    launchArgs: ['{run}'], versionFrom: 'command', projectExtension: null, absolutePaths: false,
    hostModules: ['FreeCAD', 'App', 'Part', 'Mesh', 'MeshPart', 'Import', 'Spreadsheet', 'Draft', 'Sketcher', 'PartDesign'],
    coreModules: ['FreeCAD', 'App'],
    launcher: 'exec-stub', knownSymbols: FREECAD_SYMBOLS,
    docs: ['https://wiki.freecad.org/Python_scripting_tutorial', 'https://wiki.freecad.org/Topological_data_scripting'],
    testedNote: 'FreeCAD 1.1.4 on Windows is the only version OmniCandi has run scripts on.',
  },
  blender: {
    id: 'blender', label: 'Blender', exeNames: ['blender.exe'], displayNames: ['Blender'],
    versionArgs: ['--version'], versionRegex: 'Blender\\s+(\\d+(?:\\.\\d+){1,2})',
    launchArgs: ['-b', '--factory-startup', '--python', '{run}'], versionFrom: 'command', projectExtension: null, absolutePaths: false,
    hostModules: ['bpy', 'bmesh', 'mathutils'],
    coreModules: ['bpy'],
    launcher: 'direct', knownSymbols: BLENDER_SYMBOLS,
    docs: ['https://docs.blender.org/api/current/'],
    testedNote: 'Blender 4.0.2 on Windows is the only version OmniCandi has run scripts on.',
  },
};

/** Standard-library modules every generated Python command may import (pure computation and data). */
export const SAFE_STDLIB = ['math', 'json', 're', 'itertools', 'functools', 'collections', 'decimal', 'fractions', 'typing', 'string', 'statistics', 'enum', 'dataclasses'];

/** Imports that open files, processes, networks or the interpreter itself. */
export const DENIED_MODULES = [
  'os', 'sys', 'subprocess', 'socket', 'shutil', 'pathlib', 'importlib', 'ctypes', 'builtins', 'urllib', 'http', 'ftplib', 'smtplib', 'telnetlib',
  'requests', 'pickle', 'marshal', 'shelve', 'tempfile', 'glob', 'fnmatch', 'multiprocessing', 'threading', 'asyncio', 'signal', 'platform', 'getpass',
  'webbrowser', 'code', 'codeop', 'runpy', 'pty', 'mmap', 'winreg', '_winapi', 'msvcrt', 'zipfile', 'tarfile', 'io', 'inspect', 'gc', 'site', 'sysconfig',
  'xmlrpc', 'ssl', 'select', 'selectors', 'sqlite3', 'cProfile', 'pdb', 'trace', 'atexit', 'resource', 'pwd', 'grp', 'posix', 'nt', 'bpy_extras',
];

/** Built-in functions that execute text, open files or reach the interpreter. */
export const DENIED_BUILTINS = [
  'exec', 'eval', 'compile', 'open', '__import__', 'input', 'breakpoint', 'globals', 'locals', 'vars', 'getattr', 'setattr', 'delattr', 'dir',
  'memoryview', 'exit', 'quit', 'help', 'print', 'type', 'super', 'classmethod', 'staticmethod', 'property',
];

/** Attribute names that start processes, delete or move files, or load code, whatever object they are called on. */
export const DENIED_ATTRIBUTES = [
  'system', 'popen', 'startfile', 'spawn', 'spawnl', 'spawnv', 'execv', 'execl', 'execve', 'fork', 'kill', 'remove', 'unlink', 'rmdir', 'rmtree', 'removedirs',
  'rename', 'replace_file', 'chmod', 'chown', 'symlink', 'link', 'loadLibrary', 'LoadLibrary', 'CDLL', 'WinDLL', 'exec_module', 'load_module', 'execfile',
  'python_file_run', 'python_console', 'run_python', 'open_browser', 'openurl', 'check_output', 'check_call', 'Popen', 'urlopen', 'urlretrieve', 'import_module',
  'write_text', 'write_bytes', 'read_text', 'read_bytes', 'mkdir', 'makedirs', 'walk', 'listdir', 'scandir', 'environ', 'getenv', 'putenv', 'modules',
];

/** Methods of plain Python values: they never need a documentation entry. */
export const PLAIN_METHODS = new Set([
  'append', 'extend', 'insert', 'items', 'keys', 'values', 'get', 'pop', 'update', 'setdefault', 'copy', 'clear', 'sort', 'reverse', 'index', 'count',
  'join', 'split', 'rsplit', 'strip', 'lstrip', 'rstrip', 'lower', 'upper', 'title', 'startswith', 'endswith', 'replace', 'format', 'find', 'isdigit', 'zfill',
  'add', 'discard', 'union', 'intersection', 'difference', 'isalpha', 'isalnum', 'encode', 'decode', 'bit_length', 'is_integer', 'hex',
  // the fixed runtime helpers OmniCandi provides
  'new_output', 'work_path', 'fail', 'check', 'num', 'close_enough', 'rel',
]);

/** Programs that run Python and are described by the blueprint, not by this table: the launch line must satisfy these rules. */
export const CUSTOM_ARG_FORBIDDEN = /^(-c|--command|--python-expr|--python-console|-e|--eval|--exec|-exec|-x|\/c|\/k|-command|--execute|--run-command|--script-text)$/i;

export function hostFor(id: string): PythonHost | null {
  return id === 'freecad' || id === 'blender' ? PYTHON_HOSTS[id] : null;
}
