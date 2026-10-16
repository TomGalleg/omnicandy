# MOCK Part module (test double, not FreeCAD). See FreeCAD.py in this folder.
import json
import FreeCAD
from FreeCAD import MockShape


def export(objs, path):
    FreeCAD.mock_test_hooks('crash')
    FreeCAD.mock_test_hooks('delay')
    vols = [float(o.Shape.Volume) for o in objs]
    with open(path, 'w') as f:
        f.write('ISO-10303-21;\nHEADER;\n/* MOCK STEP written by the CreateCraft test double, not real CAD data */\nENDSEC;\nDATA;\n#MOCK ' + json.dumps({'volumes': vols}) + '\nENDSEC;\nEND-ISO-10303-21;\n')


def read(path):
    text = open(path).read()
    if 'ISO-10303-21' not in text or '#MOCK ' not in text:
        raise ValueError('not a STEP file the mock can read')
    vols = json.loads(text.split('#MOCK ', 1)[1].split('\n', 1)[0])['volumes']
    return MockShape(sum(vols), (0, 0, 0), len(vols))


def makeCompound(shapes):
    return MockShape(sum(float(s.Volume) for s in shapes), (0, 0, 0), len(shapes))
