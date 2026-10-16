# ===========================================================================================
# MOCK FreeCAD  --  a TEST DOUBLE written for CreateCraft's automated tests. THIS IS NOT FREECAD.
# It imitates just enough of the FreeCAD Python API (documents, Part primitives, Part::Cut, Spreadsheet
# parameters, saving and re-opening) to exercise the FreeCAD adapter's own code paths. Volumes are
# closed-form formulas, "FCStd" files are zip files holding JSON, STEP/STL files are minimal imitations.
# Nothing here proves anything about real FreeCAD behaviour.
# ===========================================================================================
import json
import math
import os
import re
import time
import zipfile

MOCK = True
_docs = {}


def Version():
    return ['1', '0', '2', 'MOCK']


class Vector(object):
    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)


class Rotation(object):
    pass


class Placement(object):
    def __init__(self, base=None, rotation=None):
        self.Base = base if base is not None else Vector()
        self.Rotation = rotation if rotation is not None else Rotation()


class _BB(object):
    def __init__(self, x, y, z):
        self.XLength, self.YLength, self.ZLength = x, y, z


class MockShape(object):
    def __init__(self, volume, bbox, solids=1):
        self.Volume = volume
        self.BoundBox = _BB(*bbox)
        self.Solids = [object()] * solids if volume > 0 else []

    def isNull(self):
        return False

    def isValid(self):
        return self.Volume > 0


_PROPS = {
    'Part::Box': {'Length': 10.0, 'Width': 10.0, 'Height': 10.0},
    'Part::Cylinder': {'Radius': 2.0, 'Height': 10.0},
    'Part::Sphere': {'Radius': 2.0},
    'Part::Cone': {'Radius1': 2.0, 'Radius2': 4.0, 'Height': 10.0},
    'Part::Cut': {},
}


class Obj(object):
    def __init__(self, doc, type_id, name):
        self.__dict__['_doc'] = doc
        self.__dict__['_expr'] = {}
        self.TypeId, self.Name, self.Label = type_id, name, name
        self.Placement = Placement()
        self.State = []
        for k, v in _PROPS[type_id].items():
            self.__dict__[k] = v
        if type_id == 'Part::Cut':
            self.Base = None
            self.Tool = None

    def setExpression(self, path, expr):
        self._expr[path] = expr

    @property
    def ExpressionEngine(self):
        return list(self._expr.items())

    @property
    def InList(self):
        return [o for o in self._doc.Objects if getattr(o, 'Base', None) is self or getattr(o, 'Tool', None) is self]

    @property
    def Shape(self):
        t = self.TypeId
        if t == 'Part::Box':
            return MockShape(self.Length * self.Width * self.Height, (self.Length, self.Width, self.Height))
        if t == 'Part::Cylinder':
            return MockShape(math.pi * self.Radius ** 2 * self.Height, (2 * self.Radius, 2 * self.Radius, self.Height))
        if t == 'Part::Sphere':
            return MockShape(4.0 / 3.0 * math.pi * self.Radius ** 3, (2 * self.Radius,) * 3)
        if t == 'Part::Cone':
            r1, r2, h = self.Radius1, self.Radius2, self.Height
            return MockShape(math.pi * h * (r1 * r1 + r1 * r2 + r2 * r2) / 3.0, (2 * max(r1, r2), 2 * max(r1, r2), h))
        if t == 'Part::Cut':
            if self.Base is None or self.Tool is None:
                return MockShape(0.0, (0, 0, 0), 0)
            b, tl = self.Base.Shape, self.Tool.Shape
            bb = b.BoundBox
            return MockShape(max(b.Volume - min(tl.Volume, b.Volume), 0.0), (bb.XLength, bb.YLength, bb.ZLength))
        raise AttributeError('Shape')

    def to_dict(self):
        d = {'name': self.Name, 'type': self.TypeId, 'label': self.Label, 'expr': self._expr,
             'placement': [self.Placement.Base.x, self.Placement.Base.y, self.Placement.Base.z]}
        d['props'] = {k: self.__dict__[k] for k in _PROPS[self.TypeId]}
        if self.TypeId == 'Part::Cut':
            d['base'] = self.Base.Name if self.Base else None
            d['tool'] = self.Tool.Name if self.Tool else None
        return d


class Sheet(object):
    TypeId = 'Spreadsheet::Sheet'

    def __init__(self, doc, name):
        self._doc = doc
        self.Name = self.Label = name
        self.State = []
        self._cells = {}
        self._alias = {}

    def set(self, cell, text):
        self._cells[cell] = str(text)

    def setAlias(self, cell, alias):
        self._alias[cell] = alias

    def getAlias(self, cell):
        return self._alias.get(cell)

    def getUsedCells(self):
        return sorted(self._cells)

    def get(self, cell):
        m = re.match(r'^\s*(-?[0-9.]+)\s*mm\s*$', self._cells[cell])
        return float(m.group(1)) if m else self._cells[cell]

    def to_dict(self):
        return {'name': self.Name, 'type': self.TypeId, 'cells': self._cells, 'alias': self._alias}


class Document(object):
    def __init__(self, name):
        self.Name = name
        self.FileName = ''
        self.Objects = []

    def addObject(self, type_id, name):
        base, n, names = name, 0, {o.Name for o in self.Objects}
        while name in names:
            n += 1
            name = '%s%03d' % (base, n)
        o = Sheet(self, name) if type_id == 'Spreadsheet::Sheet' else Obj(self, type_id, name)
        self.Objects.append(o)
        return o

    def getObject(self, name):
        for o in self.Objects:
            if o.Name == name:
                return o
        return None

    def _sheet_values(self):
        out = {}
        for o in self.Objects:
            if isinstance(o, Sheet):
                for c, a in o._alias.items():
                    v = o.get(c)
                    if not isinstance(v, str):
                        out[o.Name + '.' + a] = v
        return out

    def recompute(self):
        vals = self._sheet_values()
        for o in self.Objects:
            if isinstance(o, Sheet):
                continue
            for path, expr in o._expr.items():
                e = re.sub(r'\b([A-Za-z_]\w*\.[A-Za-z_]\w*)\b', lambda m: repr(vals[m.group(1)]), expr)
                if not re.match(r'^[0-9.+\-*/() e]+$', e):
                    raise ValueError('mock cannot evaluate expression %r' % expr)
                val = eval(e, {'__builtins__': {}}, {})
                if path.startswith('Placement.Base.'):
                    setattr(o.Placement.Base, path.split('.')[-1], float(val))
                else:
                    setattr(o, path, float(val))
            o.State = ['Invalid'] if any(isinstance(v, (int, float)) and v <= 0 for v in o.__dict__.values() if not isinstance(v, bool)) and o.TypeId != 'Part::Cut' else []
        return 0

    def saveAs(self, path):
        data = {'mock': True, 'objects': [o.to_dict() for o in self.Objects]}
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('Document.xml', '<!-- MOCK FCStd written by the CreateCraft test double -->\n' + json.dumps(data))
        self.FileName = path


def newDocument(name='Unnamed'):
    name = re.sub(r'\W', '_', name) or 'Unnamed'
    base, n = name, 0
    while name in _docs:
        n += 1
        name = '%s%d' % (base, n)
    d = Document(name)
    _docs[name] = d
    return d


def openDocument(path):
    with zipfile.ZipFile(path) as z:
        text = z.read('Document.xml').decode('utf-8')
    data = json.loads(text.split('\n', 1)[1])
    d = newDocument(os.path.splitext(os.path.basename(path))[0])
    d.FileName = path
    for od in data['objects']:
        if od['type'] == 'Spreadsheet::Sheet':
            s = d.addObject(od['type'], od['name'])
            s._cells, s._alias = od['cells'], od['alias']
            continue
        o = d.addObject(od['type'], od['name'])
        o.Label = od['label']
        o._expr.update(od['expr'])
        for k, v in od['props'].items():
            o.__dict__[k] = v
        o.Placement.Base.x, o.Placement.Base.y, o.Placement.Base.z = od['placement']
    for od in data['objects']:
        if od['type'] == 'Part::Cut':
            o = d.getObject(od['name'])
            o.Base, o.Tool = d.getObject(od['base']), d.getObject(od['tool'])
    d.recompute()
    return d


def closeDocument(name):
    _docs.pop(name, None)


def mock_test_hooks(kind):
    """Test-only switches: a file in the work folder makes the next export slow or crash."""
    if kind == 'crash' and os.path.exists('mock_crash.txt'):
        os._exit(3)
    if kind == 'delay' and os.path.exists('mock_delay.txt'):
        time.sleep(float(open('mock_delay.txt').read().strip() or '5'))
