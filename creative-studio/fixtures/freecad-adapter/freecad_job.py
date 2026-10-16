# CreateCraft FreeCAD adapter: the job script that runs INSIDE FreeCADCmd.
#
# main.js writes this file into the project's work folder after a generated header that defines
#   COMMAND  (one of the fixed command ids below) and
#   PARAMS   (a dict decoded from base64 JSON: parameters are data, never spliced into code).
# FreeCADCmd runs with the work folder as its current directory. Every document, STEP and STL file is a plain
# file name in that folder; anything else is refused here as well as in main.js (defence in depth).
# The result is ONE line:  CREATECRAFT_RESULT {json}
import json
import math
import os
import re
import sys

_START_DIR = os.path.realpath(os.getcwd())
_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$')
_OBJ_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,40}$')


class JobError(Exception):
    def __init__(self, kind, message):
        Exception.__init__(self, message)
        self.kind = kind


def _finish(payload):
    sys.stdout.write("\nCREATECRAFT_RESULT " + json.dumps(payload) + "\n")
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


def num(v):
    """A plain float from a number or a FreeCAD Quantity."""
    return float(getattr(v, 'Value', v))


def stem(value, what):
    value = str(value)
    if not _NAME_RE.match(value):
        raise JobError('invalid-params', '%s must be 1 to 60 letters, digits, spaces, "-" or "_" (got %r).' % (what, value[:40]))
    return value


def work_path(file_name, what, must_exist):
    """Absolute path of a .FCStd file that lives directly in the work folder, or a JobError."""
    file_name = str(file_name)
    if not re.match(r'^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}\.FCStd$', file_name) or '..' in file_name:
        raise JobError('invalid-params', '%s must be a plain file name ending in .FCStd, inside the project work folder (got %r).' % (what, file_name[:60]))
    p = os.path.join(_START_DIR, file_name)
    if os.path.realpath(os.path.dirname(p)) != _START_DIR:
        raise JobError('invalid-params', '%s leaves the project work folder.' % what)
    if must_exist and not os.path.isfile(p):
        raise JobError('invalid-params', 'No document "%s" in the project work folder. Create one first or check the name.' % file_name)
    return p


def out_path(file_name, ext, what):
    """A new output file in the work folder. Existing files are never overwritten."""
    file_name = str(file_name)
    if not file_name.lower().endswith(ext.lower()):
        file_name += ext
    if ext == '.FCStd':
        p = work_path(file_name, what, False)
    else:
        if not re.match(r'^[A-Za-z0-9][A-Za-z0-9 _.-]{0,80}$', file_name) or '..' in file_name:
            raise JobError('invalid-params', '%s must be a plain file name (got %r).' % (what, file_name[:60]))
        p = os.path.join(_START_DIR, file_name)
        if os.path.realpath(os.path.dirname(p)) != _START_DIR:
            raise JobError('invalid-params', '%s leaves the project work folder.' % what)
    if os.path.exists(p):
        raise JobError('invalid-params', '"%s" already exists. CreateCraft never overwrites a file; choose another name.' % os.path.basename(p))
    return p


def _tmp(ext):
    return os.path.join(_START_DIR, '_cc_tmp_%d%s' % (os.getpid(), ext))


def _positive(name, lo=0.1, hi=100000.0):
    v = PARAMS.get(name)
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not (lo <= v <= hi):
        raise JobError('invalid-params', '%s must be a number between %s and %s millimetres.' % (name, lo, hi))
    return float(v)


# ---------------------------------------------------------------------------------------------
import FreeCAD  # noqa: E402  (only available inside FreeCAD)


def _fc_version():
    try:
        return '.'.join(str(x) for x in FreeCAD.Version()[:3])
    except Exception:
        return 'unknown'


def _shape_info(o):
    info = {}
    s = getattr(o, 'Shape', None)
    if s is None:
        return info
    try:
        if s.isNull():
            return info
        info['valid'] = bool(s.isValid())
        if len(s.Solids):
            info['volume_mm3'] = round(float(s.Volume), 3)
        bb = s.BoundBox
        info['bbox_mm'] = [round(float(bb.XLength), 3), round(float(bb.YLength), 3), round(float(bb.ZLength), 3)]
    except Exception:
        pass
    return info


def describe(doc):
    objs = []
    params = {}
    for o in doc.Objects:
        item = {'name': o.Name, 'label': o.Label, 'type': o.TypeId}
        if o.TypeId == 'Spreadsheet::Sheet':
            try:
                for cell in o.getUsedCells():
                    alias = o.getAlias(cell)
                    if alias:
                        try:
                            params[alias] = round(num(o.get(cell)), 6)
                        except Exception:
                            pass
            except Exception:
                pass
        else:
            props = {}
            for p in ('Length', 'Width', 'Height', 'Radius', 'Radius1', 'Radius2', 'Angle'):
                if hasattr(o, p):
                    try:
                        props[p] = round(num(getattr(o, p)), 6)
                    except Exception:
                        pass
            if props:
                item['properties'] = props
            try:
                exprs = [{'property': e[0], 'expression': e[1]} for e in getattr(o, 'ExpressionEngine', [])]
            except Exception:
                exprs = []
            if exprs:
                item['expressions'] = exprs
            item.update(_shape_info(o))
        objs.append(item)
    return objs, params


def top_level_solids(doc, only=None):
    out = []
    for o in doc.Objects:
        s = getattr(o, 'Shape', None)
        if s is None or s.isNull() or not len(s.Solids):
            continue
        if only and o.Name != only:
            continue
        if not only and any(hasattr(p, 'Shape') for p in o.InList):
            continue  # a part of something bigger (for example the box and the cylinder of a cut)
        out.append(o)
    return out


def save_new(doc, final):
    tmp = _tmp('.FCStd')
    doc.saveAs(tmp)
    os.replace(tmp, final)


def reopen(path):
    d = FreeCAD.openDocument(path)
    try:
        return describe(d)
    finally:
        FreeCAD.closeDocument(d.Name)


def solid_volume_sum(objs):
    return sum(float(o.Shape.Volume) for o in objs)


def recompute_ok(doc, what):
    doc.recompute()
    bad = [o.Name for o in doc.Objects if 'Invalid' in list(getattr(o, 'State', []))]
    if bad:
        raise JobError('app-error', 'FreeCAD could not recompute %s: %s became invalid.' % (what, ', '.join(bad)))


def _near(a, b, rel):
    return abs(a - b) <= max(abs(b) * rel, 1e-6)


# ---- parametric models -------------------------------------------------------------------------
def _sheet(doc, rows):
    sheet = doc.addObject('Spreadsheet::Sheet', 'Params')
    for i, (alias, value) in enumerate(rows, start=1):
        sheet.set('A%d' % i, alias)
        sheet.set('B%d' % i, '%s mm' % repr(float(value)))
        sheet.setAlias('B%d' % i, alias)
    doc.recompute()
    return sheet


def cmd_doc_create():
    shape = str(PARAMS.get('shape', 'box'))
    if shape not in ('box', 'cylinder', 'plate_with_hole'):
        raise JobError('invalid-params', 'shape must be box, cylinder or plate_with_hole.')
    name = stem(PARAMS.get('name', 'Part'), 'name')
    final = out_path(name + '.FCStd', '.FCStd', 'name')
    doc = FreeCAD.newDocument(name.replace(' ', '_'))
    expected = None
    if shape == 'box':
        L, W, H = _positive('length'), _positive('width'), _positive('height')
        _sheet(doc, [('length', L), ('width', W), ('height', H)])
        b = doc.addObject('Part::Box', 'Box')
        b.setExpression('Length', 'Params.length')
        b.setExpression('Width', 'Params.width')
        b.setExpression('Height', 'Params.height')
        expected = L * W * H
    elif shape == 'cylinder':
        R, H = _positive('radius'), _positive('height')
        _sheet(doc, [('radius', R), ('height', H)])
        c = doc.addObject('Part::Cylinder', 'Cylinder')
        c.setExpression('Radius', 'Params.radius')
        c.setExpression('Height', 'Params.height')
        expected = math.pi * R * R * H
    else:
        L, W, H = _positive('length'), _positive('width'), _positive('height')
        D = _positive('hole_diameter')
        if D >= min(L, W):
            raise JobError('invalid-params', 'hole_diameter (%s) must be smaller than the length and width of the plate.' % D)
        _sheet(doc, [('length', L), ('width', W), ('height', H), ('hole_diameter', D)])
        b = doc.addObject('Part::Box', 'Plate')
        b.setExpression('Length', 'Params.length')
        b.setExpression('Width', 'Params.width')
        b.setExpression('Height', 'Params.height')
        c = doc.addObject('Part::Cylinder', 'Hole')
        c.setExpression('Radius', 'Params.hole_diameter / 2')
        c.setExpression('Height', 'Params.height')
        c.setExpression('Placement.Base.x', 'Params.length / 2')
        c.setExpression('Placement.Base.y', 'Params.width / 2')
        cut = doc.addObject('Part::Cut', 'PlateWithHole')
        cut.Base = b
        cut.Tool = c
        expected = L * W * H - math.pi * (D / 2.0) ** 2 * H
    recompute_ok(doc, 'the new model')
    got = solid_volume_sum(top_level_solids(doc))
    if not _near(got, expected, 0.001):
        raise JobError('verification-failed', 'The new model has volume %.3f mm3 but %.3f mm3 was expected.' % (got, expected))
    save_new(doc, final)
    FreeCAD.closeDocument(doc.Name)
    objs, params = reopen(final)
    vol = sum(o.get('volume_mm3', 0.0) for o in objs if o['type'] in ('Part::Box', 'Part::Cylinder', 'Part::Cut') and 'volume_mm3' in o and o['name'] in ('Box', 'Cylinder', 'PlateWithHole'))
    if not _near(vol, expected, 0.001) or not params:
        raise JobError('verification-failed', 'The saved file did not reopen with the expected model (volume %.3f, %d parameters).' % (vol, len(params)))
    base = os.path.basename(final)
    return {
        'message': 'Created %s: a parametric %s (%d objects, %d named parameters), volume %.1f mm3.' % (base, shape.replace('_', ' '), len(objs), len(params), vol),
        'outputs': [base],
        'data': {'document': base, 'shape': shape, 'parameters': params, 'volume_mm3': round(vol, 3), 'objects': [o['name'] for o in objs]},
        'evidence': ['reopened %s: %d objects' % (base, len(objs)), 'volume %.3f mm3 matches the formula (%.3f)' % (vol, expected), 'parameters on the Params sheet: %s' % ', '.join(sorted(params))],
        'verified': True,
    }


def _open_doc_param():
    path = work_path(PARAMS.get('document', ''), 'document', True)
    return path, FreeCAD.openDocument(path)


def cmd_doc_inspect():
    path, doc = _open_doc_param()
    try:
        objs, params = describe(doc)
        solids = [o for o in top_level_solids(doc)]
        total = solid_volume_sum(solids)
        invalid = [o['name'] for o in objs if o.get('valid') is False]
    finally:
        FreeCAD.closeDocument(doc.Name)
    base = os.path.basename(path)
    return {
        'message': '%s: %d objects, %d parameters, %d solids, total volume %.1f mm3.%s' % (base, len(objs), len(params), len(solids), total, (' Invalid shapes: %s.' % ', '.join(invalid)) if invalid else ''),
        'outputs': [],
        'data': {'document': base, 'freecad_version': _fc_version(), 'objects': objs, 'parameters': params, 'solid_count': len(solids), 'total_volume_mm3': round(total, 3)},
        'evidence': ['opened %s read-only and listed %d objects' % (base, len(objs))],
        'verified': True,
    }


_PRIMITIVES = {
    'box': ('Part::Box', ['length', 'width', 'height']),
    'cylinder': ('Part::Cylinder', ['radius', 'height']),
    'sphere': ('Part::Sphere', ['radius']),
    'cone': ('Part::Cone', ['radius', 'radius2', 'height']),
}


def _expected_primitive(kind):
    if kind == 'box':
        return PARAMS['length'] * PARAMS['width'] * PARAMS['height']
    if kind == 'cylinder':
        return math.pi * PARAMS['radius'] ** 2 * PARAMS['height']
    if kind == 'sphere':
        return 4.0 / 3.0 * math.pi * PARAMS['radius'] ** 3
    r1, r2, h = PARAMS['radius'], PARAMS['radius2'], PARAMS['height']
    return math.pi * h * (r1 * r1 + r1 * r2 + r2 * r2) / 3.0


def cmd_geometry_add():
    kind = str(PARAMS.get('shape', 'box'))
    if kind not in _PRIMITIVES:
        raise JobError('invalid-params', 'shape must be box, cylinder, sphere or cone.')
    type_id, needed = _PRIMITIVES[kind]
    for n in needed:
        if n == 'radius2':
            if not isinstance(PARAMS.get('radius2'), (int, float)) or PARAMS['radius2'] < 0:
                raise JobError('invalid-params', 'radius2 (the top radius of a cone) must be 0 or more.')
        else:
            _positive(n)
    label = stem(PARAMS.get('label', kind.capitalize()), 'label')
    path, doc = _open_doc_param()
    final = out_path(PARAMS.get('output') or (os.path.splitext(os.path.basename(path))[0] + ' edited'), '.FCStd', 'output')
    before = len(doc.Objects)
    o = doc.addObject(type_id, kind.capitalize())
    o.Label = label
    if kind == 'box':
        o.Length, o.Width, o.Height = PARAMS['length'], PARAMS['width'], PARAMS['height']
    elif kind == 'cylinder':
        o.Radius, o.Height = PARAMS['radius'], PARAMS['height']
    elif kind == 'sphere':
        o.Radius = PARAMS['radius']
    else:
        o.Radius1, o.Radius2, o.Height = PARAMS['radius'], PARAMS['radius2'], PARAMS['height']
    base_v = FreeCAD.Vector(float(PARAMS.get('x', 0)), float(PARAMS.get('y', 0)), float(PARAMS.get('z', 0)))
    o.Placement = FreeCAD.Placement(base_v, FreeCAD.Rotation())
    recompute_ok(doc, 'the new %s' % kind)
    name = o.Name
    expected = _expected_primitive(kind)
    if not _near(float(o.Shape.Volume), expected, 0.001):
        raise JobError('verification-failed', 'The new %s has volume %.3f but %.3f was expected.' % (kind, float(o.Shape.Volume), expected))
    save_new(doc, final)
    FreeCAD.closeDocument(doc.Name)
    objs, _ = reopen(final)
    found = [x for x in objs if x['name'] == name]
    if len(objs) != before + 1 or not found or not _near(found[0].get('volume_mm3', -1), expected, 0.001):
        raise JobError('verification-failed', 'The saved file does not contain the new %s as expected.' % kind)
    base = os.path.basename(final)
    return {
        'message': 'Added a %s "%s" (%.1f mm3) and saved %s. The original %s is unchanged.' % (kind, label, expected, base, os.path.basename(path)),
        'outputs': [base],
        'data': {'document': base, 'object': name, 'volume_mm3': round(expected, 3), 'object_count': len(objs)},
        'evidence': ['reopened %s: %d objects (was %d)' % (base, len(objs), before), 'new object %s volume %.3f mm3 matches the formula' % (name, found[0].get('volume_mm3', 0))],
        'verified': True,
    }


_EDITABLE = ('Length', 'Width', 'Height', 'Radius', 'Radius1', 'Radius2', 'Angle', 'Label',
             'Placement.Base.x', 'Placement.Base.y', 'Placement.Base.z')


def _get_prop(o, prop):
    if prop == 'Label':
        return o.Label
    if prop.startswith('Placement.Base.'):
        return num(getattr(o.Placement.Base, prop.split('.')[-1]))
    return num(getattr(o, prop))


def cmd_object_set_property():
    prop = str(PARAMS.get('property', ''))
    if prop not in _EDITABLE:
        raise JobError('unsupported', 'Property "%s" is not supported. Supported: %s.' % (prop[:40], ', '.join(_EDITABLE)))
    obj_name = str(PARAMS.get('object', ''))
    if not _OBJ_RE.match(obj_name):
        raise JobError('invalid-params', 'object must be an object name such as Box (see doc.inspect).')
    path, doc = _open_doc_param()
    final = out_path(PARAMS.get('output') or (os.path.splitext(os.path.basename(path))[0] + ' edited'), '.FCStd', 'output')
    o = doc.getObject(obj_name)
    if o is None:
        raise JobError('invalid-params', 'There is no object "%s" in %s. Use doc.inspect to list them.' % (obj_name, os.path.basename(path)))
    try:
        bound = [e for e in o.ExpressionEngine if e[0] == prop]
    except Exception:
        bound = []
    if bound:
        raise JobError('invalid-params', '%s.%s is driven by the expression "%s". Change the parameter with param.set instead.' % (obj_name, prop, bound[0][1]))
    if prop != 'Label' and not hasattr(o, prop.split('.')[0]):
        raise JobError('invalid-params', 'Object %s has no property %s.' % (obj_name, prop))
    before_vol = float(o.Shape.Volume) if hasattr(o, 'Shape') and not o.Shape.isNull() and len(o.Shape.Solids) else None
    value = PARAMS.get('value')
    if prop == 'Label':
        o.Label = stem(value, 'value')
        want = o.Label
    else:
        try:
            want = float(value)
        except (TypeError, ValueError):
            raise JobError('invalid-params', 'value must be a number (millimetres, or degrees for Angle).')
        if prop.startswith('Placement.Base.'):
            v = o.Placement.Base
            setattr(v, prop.split('.')[-1], want)
            o.Placement = FreeCAD.Placement(v, o.Placement.Rotation)
        else:
            if want < 0 or (prop != 'Angle' and want == 0 and prop != 'Radius2'):
                raise JobError('invalid-params', '%s must be positive.' % prop)
            setattr(o, prop, want)
    recompute_ok(doc, 'the change')
    got = _get_prop(o, prop)
    if (prop == 'Label' and got != want) or (prop != 'Label' and not _near(got, want, 1e-6)):
        raise JobError('verification-failed', 'FreeCAD kept %s=%r instead of %r.' % (prop, got, want))
    save_new(doc, final)
    FreeCAD.closeDocument(doc.Name)
    d2 = FreeCAD.openDocument(final)
    try:
        o2 = d2.getObject(obj_name)
        got2 = _get_prop(o2, prop)
        after_vol = float(o2.Shape.Volume) if before_vol is not None and not o2.Shape.isNull() else None
    finally:
        FreeCAD.closeDocument(d2.Name)
    if (prop == 'Label' and got2 != want) or (prop != 'Label' and not _near(got2, want, 1e-6)):
        raise JobError('verification-failed', 'The saved file has %s=%r, not the requested %r.' % (prop, got2, want))
    base = os.path.basename(final)
    ev = ['reopened %s: %s.%s = %r' % (base, obj_name, prop, got2)]
    if before_vol is not None and after_vol is not None:
        ev.append('volume of %s: %.3f -> %.3f mm3' % (obj_name, before_vol, after_vol))
    return {
        'message': 'Set %s.%s to %s and saved %s. The original %s is unchanged.' % (obj_name, prop, got2, base, os.path.basename(path)),
        'outputs': [base],
        'data': {'document': base, 'object': obj_name, 'property': prop, 'value': got2, 'volume_before_mm3': before_vol, 'volume_after_mm3': after_vol},
        'evidence': ev,
        'verified': True,
    }


def cmd_param_set():
    alias = str(PARAMS.get('name', ''))
    if not _OBJ_RE.match(alias):
        raise JobError('invalid-params', 'name must be a parameter name from the Params sheet (see doc.inspect).')
    path, doc = _open_doc_param()
    final = out_path(PARAMS.get('output') or (os.path.splitext(os.path.basename(path))[0] + ' edited'), '.FCStd', 'output')
    sheet = doc.getObject('Params')
    if sheet is None or sheet.TypeId != 'Spreadsheet::Sheet':
        raise JobError('invalid-params', '%s has no Params sheet. Only documents made with doc.create have named parameters.' % os.path.basename(path))
    cell = None
    for c in sheet.getUsedCells():
        if sheet.getAlias(c) == alias:
            cell = c
    if cell is None:
        _objs, known = describe(doc)
        raise JobError('invalid-params', 'There is no parameter "%s". Known: %s.' % (alias, ', '.join(sorted(known)) or 'none'))
    value = PARAMS.get('value')
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not (0.1 <= value <= 100000):
        raise JobError('invalid-params', 'value must be a number between 0.1 and 100000 millimetres.')
    _o, params_before = describe(doc)
    vol_before = solid_volume_sum(top_level_solids(doc))
    sheet.set(cell, '%s mm' % repr(float(value)))
    recompute_ok(doc, 'the new parameter value')
    vol_after = solid_volume_sum(top_level_solids(doc))
    save_new(doc, final)
    FreeCAD.closeDocument(doc.Name)
    objs, params = reopen(final)
    if not _near(params.get(alias, -1), float(value), 1e-6):
        raise JobError('verification-failed', 'The saved file has %s=%r, not %r.' % (alias, params.get(alias), value))
    d2 = FreeCAD.openDocument(final)
    try:
        saved_vol = solid_volume_sum(top_level_solids(d2))
    finally:
        FreeCAD.closeDocument(d2.Name)
    if not _near(saved_vol, vol_after, 0.001):
        raise JobError('verification-failed', 'The saved model volume (%.3f) differs from the recomputed one (%.3f).' % (saved_vol, vol_after))
    base = os.path.basename(final)
    return {
        'message': 'Changed parameter %s from %s to %s mm; the model was recomputed (volume %.1f -> %.1f mm3) and saved as %s.' % (alias, params_before.get(alias), value, vol_before, vol_after, base),
        'outputs': [base],
        'data': {'document': base, 'parameter': alias, 'value': float(value), 'volume_before_mm3': round(vol_before, 3), 'volume_after_mm3': round(vol_after, 3), 'parameters': params},
        'evidence': ['reopened %s: %s = %s' % (base, alias, params.get(alias)), 'solid volume %.3f -> %.3f mm3 after recompute' % (vol_before, saved_vol)],
        'verified': True,
    }


def cmd_doc_save_as():
    path, doc = _open_doc_param()
    final = out_path(PARAMS.get('output', ''), '.FCStd', 'output')
    before, _p = describe(doc)
    save_new(doc, final)
    FreeCAD.closeDocument(doc.Name)
    after, _p2 = reopen(final)
    if [o['name'] for o in before] != [o['name'] for o in after]:
        raise JobError('verification-failed', 'The copy does not contain the same objects as the original.')
    base = os.path.basename(final)
    return {'message': 'Saved a copy of %s as %s (%d objects).' % (os.path.basename(path), base, len(after)), 'outputs': [base],
            'data': {'document': base, 'object_count': len(after)}, 'evidence': ['reopened %s: same %d objects' % (base, len(after))], 'verified': True}


def _export_targets(doc):
    only = PARAMS.get('object')
    if only:
        if not _OBJ_RE.match(str(only)) or doc.getObject(str(only)) is None:
            raise JobError('invalid-params', 'There is no object "%s" in the document.' % str(only)[:40])
    objs = top_level_solids(doc, str(only) if only else None)
    if not objs:
        raise JobError('invalid-params', 'The document has no solid to export.')
    return objs


def cmd_export_step():
    import Part
    path, doc = _open_doc_param()
    final = out_path(PARAMS.get('output') or (os.path.splitext(os.path.basename(path))[0]), '.step', 'output')
    objs = _export_targets(doc)
    want = solid_volume_sum(objs)
    tmp = _tmp('.step')
    Part.export(objs, tmp)
    os.replace(tmp, final)
    FreeCAD.closeDocument(doc.Name)
    with open(final, 'rb') as f:
        head = f.read(64)
    if b'ISO-10303-21' not in head:
        os.remove(final)
        raise JobError('verification-failed', 'The exported file is not a STEP file (no ISO-10303-21 header).')
    shape = Part.read(final)
    got = float(shape.Volume)
    if not len(shape.Solids) or not _near(got, want, 0.01):
        raise JobError('verification-failed', 'Re-reading the STEP file gave volume %.3f mm3 in %d solids; %.3f was expected.' % (got, len(shape.Solids), want))
    base = os.path.basename(final)
    return {'message': 'Exported %s (%d solid%s, %.1f mm3) as STEP.' % (base, len(shape.Solids), '' if len(shape.Solids) == 1 else 's', got), 'outputs': [base],
            'data': {'file': base, 'solids': len(shape.Solids), 'volume_mm3': round(got, 3), 'bytes': os.path.getsize(final)},
            'evidence': ['STEP header present', 're-read the STEP file: %d solids, volume %.3f mm3 (model %.3f)' % (len(shape.Solids), got, want)], 'verified': True}


def cmd_export_stl():
    import Mesh
    import MeshPart
    import Part
    path, doc = _open_doc_param()
    tol = float(PARAMS.get('tolerance_mm', 0.1))
    if not (0.001 <= tol <= 10):
        raise JobError('invalid-params', 'tolerance_mm must be between 0.001 and 10.')
    final = out_path(PARAMS.get('output') or (os.path.splitext(os.path.basename(path))[0]), '.stl', 'output')
    objs = _export_targets(doc)
    want = solid_volume_sum(objs)
    shape = Part.makeCompound([o.Shape for o in objs])
    mesh = MeshPart.meshFromShape(Shape=shape, LinearDeflection=tol, AngularDeflection=0.5236, Relative=False)
    tmp = _tmp('.stl')
    mesh.write(tmp)
    os.replace(tmp, final)
    FreeCAD.closeDocument(doc.Name)
    m2 = Mesh.Mesh(final)
    facets = int(m2.CountFacets)
    vol = float(m2.Volume)
    if facets < 4:
        raise JobError('verification-failed', 'The STL file has only %d triangles.' % facets)
    if not _near(vol, want, 0.05):
        raise JobError('verification-failed', 'The STL volume %.3f mm3 differs from the model volume %.3f mm3 by more than 5%%. Lower tolerance_mm.' % (vol, want))
    base = os.path.basename(final)
    return {'message': 'Exported %s: %d triangles, volume %.1f mm3 (tolerance %s mm).' % (base, facets, vol, tol), 'outputs': [base],
            'data': {'file': base, 'triangles': facets, 'volume_mm3': round(vol, 3), 'bytes': os.path.getsize(final)},
            'evidence': ['re-read the STL file: %d triangles' % facets, 'mesh volume %.3f mm3 vs model %.3f mm3' % (vol, want)], 'verified': True}


def cmd_app_health():
    import Part
    modules = {}
    for name in ('Part', 'Mesh', 'MeshPart', 'Spreadsheet'):
        try:
            __import__(name)
            modules[name] = True
        except Exception:
            modules[name] = False
    doc = FreeCAD.newDocument('CreateCraftHealth')
    b = doc.addObject('Part::Box', 'Box')
    b.Length, b.Width, b.Height = 10, 10, 10
    doc.recompute()
    vol = float(b.Shape.Volume)
    FreeCAD.closeDocument(doc.Name)
    if not _near(vol, 1000.0, 1e-6):
        raise JobError('verification-failed', 'A 10 mm cube has volume %.3f instead of 1000.' % vol)
    missing = [k for k, v in modules.items() if not v]
    if 'Part' in missing or 'Spreadsheet' in missing:
        raise JobError('app-error', 'This FreeCAD is missing required modules: %s.' % ', '.join(missing))
    return {'message': 'FreeCAD %s answered and built a 10 mm cube (volume %.0f mm3).%s' % (_fc_version(), vol, (' Optional modules missing: %s.' % ', '.join(missing)) if missing else ''),
            'outputs': [], 'data': {'freecad_version': _fc_version(), 'python': sys.version.split()[0], 'modules': modules},
            'evidence': ['built and measured a 10 mm cube in a temporary document (nothing saved)'], 'verified': True}


COMMANDS = {
    'app.health': cmd_app_health,
    'doc.create': cmd_doc_create,
    'doc.inspect': cmd_doc_inspect,
    'geometry.add': cmd_geometry_add,
    'object.set_property': cmd_object_set_property,
    'param.set': cmd_param_set,
    'doc.save_as': cmd_doc_save_as,
    'export.step': cmd_export_step,
    'export.stl': cmd_export_stl,
}

try:
    fn = COMMANDS.get(COMMAND)
    if fn is None:
        raise JobError('unsupported', 'Unknown command %s.' % COMMAND)
    _result = fn()
    _result['ok'] = True
    _finish(_result)
except JobError as e:
    _finish({'ok': False, 'kind': e.kind, 'error': str(e)})
except Exception as e:  # FreeCAD / Python errors: report, never hide
    import traceback
    _finish({'ok': False, 'kind': 'app-error', 'error': '%s: %s' % (type(e).__name__, e), 'trace': traceback.format_exc()[-800:]})
