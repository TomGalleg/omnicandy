# MOCK MeshPart module (test double, not FreeCAD).
import Mesh


def meshFromShape(Shape=None, LinearDeflection=0.1, AngularDeflection=0.5, Relative=False):
    return Mesh.Mesh(volume=float(Shape.Volume))
