"""Writes freecad-enclosure.blueprint.json: the blueprint Claude authored for the FreeCAD proof of concept.
Authored in a Claude Code development session (not by the in-app research run) and then fed through the same builder pipeline."""
import json

RUN_CREATE = '''import FreeCAD
import Part


def run(P, H):
    w = float(P["width"])
    d = float(P["depth"])
    h = float(P["height"])
    t = float(P["wall"])
    if 2 * t >= min(w, d) or t >= h:
        H.fail("invalid-params", "The wall is too thick for the box: it must be less than half of the width and depth, and less than the height.")
    path = H.new_output(P["name"], ".FCStd")
    outer = Part.makeBox(w, d, h)
    inner = Part.makeBox(w - 2 * t, d - 2 * t, h - t, FreeCAD.Vector(t, t, t))
    shell = outer.cut(inner)
    H.check(shell.isValid(), "The enclosure shape is not valid.")
    doc = FreeCAD.newDocument("Enclosure")
    obj = doc.addObject("Part::Feature", "Enclosure")
    obj.Shape = shell
    doc.recompute()
    doc.saveAs(path)
    FreeCAD.closeDocument(doc.Name)
    expected = w * d * h - (w - 2 * t) * (d - 2 * t) * (h - t)
    return {
        "message": "Created an open-top enclosure %g x %g x %g mm with %g mm walls (volume %.1f mm3)." % (w, d, h, t, expected),
        "outputs": [path.name],
        "data": {"file": path.name, "expected_volume_mm3": expected, "width_mm": w, "depth_mm": d, "height_mm": h, "wall_mm": t},
        "evidence": ["shape is valid inside FreeCAD", "saved to " + path.name],
    }
'''

VERIFY_CREATE = '''import FreeCAD


def verify(P, R, H):
    path = H.work_path(R["outputs"][0])
    doc = FreeCAD.openDocument(str(path))
    shapes = [o.Shape for o in doc.Objects if hasattr(o, "Shape")]
    H.check(len(shapes) == 1, "Expected exactly one shape in the saved file, found %d." % len(shapes))
    s = shapes[0]
    w = float(P["width"])
    d = float(P["depth"])
    h = float(P["height"])
    t = float(P["wall"])
    expected = w * d * h - (w - 2 * t) * (d - 2 * t) * (h - t)
    H.check(s.isValid(), "The re-opened shape is not valid.")
    H.check(len(s.Solids) == 1, "Expected one solid, found %d." % len(s.Solids))
    H.check(H.close_enough(s.Volume, expected, 1e-6, 1e-3), "Volume %.4f does not match the expected %.4f." % (s.Volume, expected))
    bb = s.BoundBox
    H.check(H.close_enough(bb.XLength, w) and H.close_enough(bb.YLength, d) and H.close_enough(bb.ZLength, h), "The bounding box is not %g x %g x %g." % (w, d, h))
    name = doc.Name
    FreeCAD.closeDocument(name)
    return {"evidence": ["re-opened the saved file in a fresh program run", "one valid solid", "volume %.3f mm3 equals the formula %.3f" % (s.Volume, expected), "size %g x %g x %g mm" % (bb.XLength, bb.YLength, bb.ZLength)]}
'''

RUN_MEASURE = '''import FreeCAD


def run(P, H):
    path = H.work_path(P["document"])
    doc = FreeCAD.openDocument(str(path))
    shapes = [o.Shape for o in doc.Objects if hasattr(o, "Shape")]
    H.check(len(shapes) >= 1, "The document has no shape.")
    s = shapes[0]
    bb = s.BoundBox
    data = {"solids": len(s.Solids), "valid": bool(s.isValid()), "volume_mm3": round(float(s.Volume), 3), "x_mm": round(float(bb.XLength), 3), "y_mm": round(float(bb.YLength), 3), "z_mm": round(float(bb.ZLength), 3)}
    FreeCAD.closeDocument(doc.Name)
    return {"message": "Measured %s: %d solid, volume %.3f mm3, %g x %g x %g mm." % (P["document"], data["solids"], data["volume_mm3"], data["x_mm"], data["y_mm"], data["z_mm"]), "outputs": [], "data": data, "evidence": ["opened the document and measured its first shape"]}
'''

VERIFY_MEASURE = '''import FreeCAD


def verify(P, R, H):
    path = H.work_path(P["document"])
    doc = FreeCAD.openDocument(str(path))
    shapes = [o.Shape for o in doc.Objects if hasattr(o, "Shape")]
    H.check(len(shapes) >= 1, "The document has no shape.")
    s = shapes[0]
    before = R["data"]
    H.check(H.close_enough(float(s.Volume), before["volume_mm3"], 1e-6, 1e-2), "A second measurement gives a different volume.")
    H.check(len(s.Solids) == before["solids"], "A second measurement counts a different number of solids.")
    FreeCAD.closeDocument(doc.Name)
    return {"evidence": ["a second, separate program run measured the same volume and solid count"]}
'''

W = "https://wiki.freecad.org/Topological_data_scripting"
T = "https://wiki.freecad.org/Python_scripting_tutorial"


def ref(sym, url=W):
    return {"symbol": sym, "url": url}


bp = {
    "schemaVersion": 1,
    "application": {"name": "FreeCAD", "publisher": "FreeCAD project", "platforms": ["windows", "linux", "macos"],
                    "versions": [{"min": "1.0", "max": "1.99"}], "exeNames": ["FreeCADCmd.exe"], "displayNames": ["FreeCAD"]},
    "research": {
        "application": {"name": "FreeCAD", "publisher": "FreeCAD project", "platforms": ["windows", "linux", "macos"], "version": "1.1.4"},
        "summary": "FreeCAD is free, open-source parametric 3D CAD. Its command-line program FreeCADCmd runs a Python script without a window, and the Part module builds solid shapes (boxes, boolean cuts) that can be saved as .FCStd documents and re-opened.",
        "sources": [
            {"title": "FreeCAD wiki: Topological data scripting (Part module, shapes, boolean operations)", "url": W, "kind": "official",
             "note": "The page could not be fetched in the authoring session (the wiki blocks automated readers). Every symbol used was instead confirmed on the installed FreeCAD 1.1.4 by inspecting the real module (Part.makeBox, Shape.cut, isValid, Volume, Solids, BoundBox, FreeCAD.newDocument, FreeCAD.openDocument exist)."},
            {"title": "FreeCAD wiki: Python scripting tutorial (documents, objects, recompute, save)", "url": T, "kind": "official",
             "note": "Same note: confirmed against the installed program, not read from the page."},
        ],
        "methods": [
            {"method": "scripting", "officialSupport": "official", "note": "FreeCADCmd.exe runs Python scripts headless; the Part module is documented for scripting."},
            {"method": "cli", "officialSupport": "partial", "note": "FreeCADCmd accepts a script file; there is no high-level command line for modelling."},
            {"method": "file-exchange", "officialSupport": "official", "note": "STEP/STL/FCStd files, but no in-place editing without scripting."},
        ],
        "scripting": ["FreeCADCmd.exe <script.py> runs a script without opening a window", "Part.makeBox, Shape.cut, FreeCAD.newDocument, Document.addObject, Document.recompute, Document.saveAs, FreeCAD.openDocument"],
        "commandLine": ["FreeCADCmd.exe --version prints the version"],
        "fileFormats": [".FCStd (FreeCAD document)", "STEP", "STL"],
        "pluginTechnologies": ["Python workbenches / macros inside the FreeCAD window (not needed here)"],
        "licensing": "LGPL 2.1 or later. Free to use and automate.",
        "requiredTools": ["FreeCAD 1.0 or newer with FreeCADCmd.exe (free from freecad.org)"],
        "limitations": ["Tested only on FreeCAD 1.1.4 for Windows.", "Documents are created as new files; existing files are never overwritten or edited in place.", "Only open-top rectangular enclosures are supported."],
        "insufficient": None, "sourcesConsulted": True,
    },
    "decision": {"feasible": True, "notFeasibleReason": None, "type": "external", "template": "python-script", "methods": ["scripting"],
                 "rationale": "FreeCAD documents a scripting API and ships a headless command-line program, so an external adapter driving FreeCADCmd with a fixed Python job is the most reliable method; no add-in inside FreeCAD is needed and no UI automation is used.", "hostProfile": None},
    "python": {"host": "freecad"},
    "commands": [
        {"id": "enclosure.create", "label": "Create a parametric enclosure",
         "description": "Makes a new FreeCAD document containing an open-top rectangular enclosure (a box with a hollow inside) with the given outer width, depth, height and wall thickness, in millimetres. The saved file is re-opened in a fresh run and its volume, size and validity are checked.",
         "params": {"name": {"type": "string", "description": "File name of the new document, without extension.", "required": True},
                    "width": {"type": "number", "description": "Outer width (X) in mm.", "required": True, "min": 10, "max": 1000},
                    "depth": {"type": "number", "description": "Outer depth (Y) in mm.", "required": True, "min": 10, "max": 1000},
                    "height": {"type": "number", "description": "Outer height (Z) in mm.", "required": True, "min": 5, "max": 1000},
                    "wall": {"type": "number", "description": "Wall and floor thickness in mm.", "required": True, "min": 0.5, "max": 50}},
         "permissions": ["execute-scripts", "write-files"], "timeoutMs": 120000,
         "docRefs": [ref("Part.makeBox"), ref("Shape.cut"), ref("Shape.isValid"), ref("FreeCAD.Vector", T), ref("FreeCAD.newDocument", T), ref("Document.addObject", T), ref("Document.recompute", T), ref("Document.saveAs", T), ref("FreeCAD.closeDocument", T), ref("FreeCAD.openDocument", T), ref("Shape.Volume"), ref("Shape.Solids"), ref("Shape.BoundBox")],
         "python": {"source": RUN_CREATE, "verifySource": VERIFY_CREATE, "outputExtensions": [".FCStd"]},
         "mock": {"params": {"name": "Sim Box", "width": 60, "depth": 40, "height": 30, "wall": 2}},
         "liveTest": {"params": {"name": "Live Enclosure", "width": 60, "depth": 40, "height": 30, "wall": 2}, "kind": "edit"}},
        {"id": "enclosure.measure", "label": "Measure a FreeCAD document",
         "description": "Opens a FreeCAD document from this project's work folder and reports the first shape's volume, size, number of solids and whether it is valid. Changes nothing.",
         "params": {"document": {"type": "string", "description": "File name of a .FCStd document in the project's work folder for this integration.", "required": True}},
         "permissions": ["execute-scripts", "read-project"], "idempotent": True, "timeoutMs": 120000,
         "docRefs": [ref("FreeCAD.openDocument", T), ref("FreeCAD.closeDocument", T), ref("Shape.isValid"), ref("Shape.Volume"), ref("Shape.Solids"), ref("Shape.BoundBox")],
         "python": {"source": RUN_MEASURE, "verifySource": VERIFY_MEASURE, "outputExtensions": []},
         "mock": {"params": {"document": "Sim Box.FCStd"}},
         "liveTest": {"params": {"document": "Live Enclosure.FCStd"}, "kind": "read"}},
    ],
    "userGuide": "Ask Claude to create an enclosure, for example: \"Make an enclosure 80 wide, 50 deep and 35 high with 2 mm walls called Sensor Box.\" The new FreeCAD file appears in this project's work folder for this integration. Then ask Claude to measure it. Files are never overwritten: choose a new name each time.",
}
json.dump(bp, open('freecad-enclosure.blueprint.json', 'w'), indent=2)
print('ok')
