using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.UI;

namespace CreateCraft.Revit;

/// <summary>
/// The complete, fixed set of operations CreateCraft can ask Revit for. Every handler runs inside a Revit ExternalEvent.
/// There is deliberately NO "run this code" or "run this script" command: Claude can only call these typed operations.
/// Edits additionally need (1) the document key of the project Claude inspected, (2) a scratch model, and (3) a transaction.
/// </summary>
internal static class Commands
{
    public const double MmPerFoot = 304.8;
    public const string TestMarker = "CreateCraft test placement";

    private static readonly string[] Reads =
    {
        "revit.app_info", "revit.project_info", "revit.levels.list", "revit.views.list", "revit.elements.count", "revit.lighting.list", "revit.element.get",
    };
    private static readonly string[] Edits = { "revit.parameter.set", "revit.element.place_test", "revit.element.remove_test" };

    /// <summary>Dropping a file called "readonly.flag" next to the add-in (or CREATECRAFT_REVIT_READONLY=1) registers only the read commands.</summary>
    public static bool ReadOnlyMode(string dir)
        => File.Exists(Path.Combine(dir, "readonly.flag")) || Environment.GetEnvironmentVariable("CREATECRAFT_REVIT_READONLY") == "1";

    public static IReadOnlyList<string> Capabilities(bool readOnly) => readOnly ? Reads : Reads.Concat(Edits).ToArray();

    public static CommandResult Run(UIApplication app, string name, JsonObject p, Action<string, double?> progress, CancellationToken ct)
    {
        switch (name)
        {
            case "health": return Health(app);
            case "revit.app_info": return AppInfo(app);
            case "revit.project_info": return ProjectInfo(app);
            case "revit.levels.list": return LevelsList(Doc(app));
            case "revit.views.list": return ViewsList(Doc(app));
            case "revit.elements.count": return ElementsCount(Doc(app), p);
            case "revit.lighting.list": return LightingList(Doc(app), p);
            case "revit.element.get": return ElementGet(Doc(app), p);
            case "revit.parameter.set": return ParameterSet(app, p);
            case "revit.element.place_test": return PlaceTest(app, p);
            case "revit.element.remove_test": return RemoveTest(app, p);
            default: throw new CommandFailure("unsupported", $"This add-in has no command named \"{name}\".");
        }
    }

    // ---- helpers ----

    private static Document Doc(UIApplication app)
    {
        var d = app.ActiveUIDocument?.Document;
        if (d == null) throw new CommandFailure("app-error", "No Revit project is open. Open a project in Revit first.");
        return d;
    }

    public static string DocKey(Document d)
    {
        var raw = $"{d.PathName}|{d.Title}|{d.ProjectInformation?.UniqueId}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))[..16].ToLowerInvariant();
    }

    private static bool IsScratchName(Document d)
    {
        var n = $"{d.Title} {Path.GetFileNameWithoutExtension(d.PathName)}".ToLowerInvariant();
        return n.Contains("scratch") || n.Contains("cc-test") || n.Contains("createcraft-test");
    }

    /// <summary>Why this document may NOT be edited by CreateCraft, or null when it may.</summary>
    private static string? EditBlocker(Document d)
    {
        if (d.IsFamilyDocument) return "This is a family document. CreateCraft edits only project models.";
        if (d.IsReadOnly) return "The project is read-only.";
        if (d.IsLinked) return "Linked models cannot be edited.";
        if (d.IsWorkshared) return "This is a workshared (shared) model. CreateCraft will not edit shared models.";
        if (!IsScratchName(d)) return $"Editing is limited to scratch models. Save a copy whose file name contains \"scratch\" (for example CreateCraft-scratch.rvt) and open that one. This project is \"{d.Title}\".";
        return null;
    }

    private static Document EditableDoc(UIApplication app, JsonObject p)
    {
        var d = Doc(app);
        var key = Params.Str(p, "documentKey");
        if (!string.Equals(key, DocKey(d), StringComparison.OrdinalIgnoreCase))
            throw new CommandFailure("verification-failed", $"The project that is open in Revit now (\"{d.Title}\") is not the one this request was made for. Nothing was changed. Ask for the project information again.");
        var why = EditBlocker(d);
        if (why != null) throw new CommandFailure("invalid-params", why + " Nothing was changed.");
        return d;
    }

    private static double Mm(double feet) => Math.Round(feet * MmPerFoot, 1);
    private static long IdOf(Element e) => e.Id.Value;
    private static string LevelName(Document d, ElementId id) => id == ElementId.InvalidElementId ? "" : d.GetElement(id)?.Name ?? "";

    private static string ParamString(Element e, BuiltInParameter bip)
    {
        var p = e.get_Parameter(bip);
        return p == null ? "" : p.AsString() ?? p.AsValueString() ?? "";
    }

    // ---- read-only ----

    private static CommandResult Health(UIApplication app)
    {
        var ca = app.Application;
        var title = app.ActiveUIDocument?.Document.Title;
        return CommandResult.Success($"Revit {ca.VersionNumber} answered from inside its API context." + (title != null ? $" Active project: {title}." : " No project is open."),
            new JsonObject { ["version"] = ca.VersionNumber, ["build"] = ca.VersionBuild, ["projectOpen"] = title != null });
    }

    private static CommandResult AppInfo(UIApplication app)
    {
        var a = app.Application;
        var docs = new JsonArray();
        foreach (Document d in a.Documents) docs.Add(d.Title);
        var data = new JsonObject
        {
            ["name"] = a.VersionName, ["version"] = a.VersionNumber, ["build"] = a.VersionBuild, ["product"] = a.Product.ToString(),
            ["language"] = a.Language.ToString(), ["bridge"] = "connected", ["addinVersion"] = AppIdentity.PluginVersion,
            ["openDocuments"] = docs, ["activeDocument"] = app.ActiveUIDocument?.Document.Title,
        };
        return CommandResult.Success($"{a.VersionName} (build {a.VersionBuild}) is connected. {(app.ActiveUIDocument == null ? "No project is open." : "Active project: " + app.ActiveUIDocument.Document.Title + ".")}", data, true, "answered from inside Revit's API context");
    }

    private static CommandResult ProjectInfo(UIApplication app)
    {
        var d = app.ActiveUIDocument?.Document;
        if (d == null) return CommandResult.Success("Revit is running but no project is open.", new JsonObject { ["open"] = false }, true);
        var pi = d.ProjectInformation;
        var blocker = EditBlocker(d);
        var data = new JsonObject
        {
            ["open"] = true, ["title"] = d.Title, ["path"] = string.IsNullOrEmpty(d.PathName) ? null : d.PathName, ["documentKey"] = DocKey(d),
            ["projectName"] = pi?.Name, ["projectNumber"] = pi?.Number, ["client"] = pi?.ClientName, ["address"] = pi?.Address, ["status"] = pi?.Status,
            ["isFamily"] = d.IsFamilyDocument, ["isWorkshared"] = d.IsWorkshared, ["isReadOnly"] = d.IsReadOnly, ["isModified"] = d.IsModified,
            ["activeView"] = d.ActiveView?.Name, ["editable"] = blocker == null, ["editBlockedReason"] = blocker,
            ["unitsLength"] = d.GetUnits().GetFormatOptions(SpecTypeId.Length).GetUnitTypeId().TypeId,
        };
        return CommandResult.Success($"Project \"{d.Title}\" is open ({(blocker == null ? "a scratch model: edits allowed" : "read-only for CreateCraft")}).", data, true, "read from the active Revit document");
    }

    private static CommandResult LevelsList(Document d)
    {
        var levels = new FilteredElementCollector(d).OfClass(typeof(Level)).Cast<Level>().OrderBy(l => l.Elevation).ToList();
        var arr = new JsonArray();
        foreach (var l in levels) arr.Add(new JsonObject { ["id"] = IdOf(l), ["name"] = l.Name, ["elevationMm"] = Mm(l.Elevation) });
        return CommandResult.Success($"{levels.Count} level(s) in \"{d.Title}\".", new JsonObject { ["count"] = levels.Count, ["levels"] = arr }, true, "FilteredElementCollector of Level elements");
    }

    private static CommandResult ViewsList(Document d)
    {
        var skip = new HashSet<ViewType> { ViewType.Internal, ViewType.ProjectBrowser, ViewType.SystemBrowser, ViewType.Undefined };
        var views = new FilteredElementCollector(d).OfClass(typeof(View)).Cast<View>().Where(v => !v.IsTemplate && !skip.Contains(v.ViewType)).OrderBy(v => v.ViewType.ToString()).ThenBy(v => v.Name).ToList();
        var arr = new JsonArray();
        foreach (var v in views.Take(400)) arr.Add(new JsonObject { ["id"] = IdOf(v), ["name"] = v.Name, ["type"] = v.ViewType.ToString(), ["level"] = v.GenLevel?.Name });
        var byType = new JsonObject();
        foreach (var g in views.GroupBy(v => v.ViewType.ToString())) byType[g.Key] = g.Count();
        return CommandResult.Success($"{views.Count} view(s) in \"{d.Title}\".", new JsonObject { ["count"] = views.Count, ["byType"] = byType, ["views"] = arr, ["truncated"] = views.Count > 400 }, true, "FilteredElementCollector of View elements (templates and system browsers excluded)");
    }

    private static readonly (string Name, BuiltInCategory Cat)[] CountCategories =
    {
        ("Walls", BuiltInCategory.OST_Walls), ("Doors", BuiltInCategory.OST_Doors), ("Windows", BuiltInCategory.OST_Windows), ("Floors", BuiltInCategory.OST_Floors),
        ("Ceilings", BuiltInCategory.OST_Ceilings), ("Roofs", BuiltInCategory.OST_Roofs), ("Rooms", BuiltInCategory.OST_Rooms), ("Columns", BuiltInCategory.OST_Columns),
        ("Structural Columns", BuiltInCategory.OST_StructuralColumns), ("Structural Framing", BuiltInCategory.OST_StructuralFraming), ("Stairs", BuiltInCategory.OST_Stairs),
        ("Railings", BuiltInCategory.OST_StairsRailing), ("Furniture", BuiltInCategory.OST_Furniture), ("Generic Models", BuiltInCategory.OST_GenericModel),
        ("Lighting Fixtures", BuiltInCategory.OST_LightingFixtures), ("Electrical Fixtures", BuiltInCategory.OST_ElectricalFixtures), ("Electrical Equipment", BuiltInCategory.OST_ElectricalEquipment),
        ("Mechanical Equipment", BuiltInCategory.OST_MechanicalEquipment), ("Plumbing Fixtures", BuiltInCategory.OST_PlumbingFixtures), ("Lighting Devices", BuiltInCategory.OST_LightingDevices),
    };

    private static CommandResult ElementsCount(Document d, JsonObject p)
    {
        var want = Params.Str(p, "category", false);
        var chosen = want == "" || want.Equals("all", StringComparison.OrdinalIgnoreCase)
            ? CountCategories.ToList()
            : CountCategories.Where(c => c.Name.Equals(want, StringComparison.OrdinalIgnoreCase) || c.Name.TrimEnd('s').Equals(want.TrimEnd('s'), StringComparison.OrdinalIgnoreCase)).ToList();
        if (chosen.Count == 0) throw new CommandFailure("invalid-params", $"\"{want}\" is not a supported category. Supported: {string.Join(", ", CountCategories.Select(c => c.Name))}.");
        var counts = new JsonObject();
        long total = 0;
        foreach (var (n, c) in chosen)
        {
            var k = new FilteredElementCollector(d).OfCategory(c).WhereElementIsNotElementType().GetElementCount();
            counts[n] = k; total += k;
        }
        var summary = chosen.Count == 1 ? $"{counts[chosen[0].Name]} {chosen[0].Name.ToLowerInvariant()} in \"{d.Title}\"." : $"{total} element(s) across {chosen.Count} categories in \"{d.Title}\".";
        return CommandResult.Success(summary, new JsonObject { ["counts"] = counts, ["total"] = total }, true, "FilteredElementCollector.GetElementCount per category (element types excluded)");
    }

    private static CommandResult LightingList(Document d, JsonObject p)
    {
        var limit = (int)Math.Clamp(Params.Num(p, "limit", 100), 1, 500);
        var fixtures = new FilteredElementCollector(d).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsNotElementType().OfType<FamilyInstance>().ToList();
        var items = new JsonArray();
        foreach (var fi in fixtures.OrderBy(f => LevelName(d, f.LevelId)).ThenBy(f => f.Symbol?.FamilyName).Take(limit))
        {
            var pt = (fi.Location as LocationPoint)?.Point;
            var level = LevelName(d, fi.LevelId);
            if (level == "") level = ParamString(fi, BuiltInParameter.SCHEDULE_LEVEL_PARAM);
            items.Add(new JsonObject
            {
                ["id"] = IdOf(fi), ["family"] = fi.Symbol?.FamilyName, ["type"] = fi.Symbol?.Name, ["level"] = level,
                ["xMm"] = pt == null ? null : Mm(pt.X), ["yMm"] = pt == null ? null : Mm(pt.Y), ["zMm"] = pt == null ? null : Mm(pt.Z),
                ["mark"] = ParamString(fi, BuiltInParameter.ALL_MODEL_MARK), ["host"] = fi.Host?.Name, ["placement"] = fi.Symbol?.Family?.FamilyPlacementType.ToString(),
            });
        }
        var byType = new JsonObject();
        foreach (var g in fixtures.GroupBy(f => $"{f.Symbol?.FamilyName} : {f.Symbol?.Name}")) byType[g.Key] = g.Count();
        var byLevel = new JsonObject();
        foreach (var g in fixtures.GroupBy(f => LevelName(d, f.LevelId) is { Length: > 0 } n ? n : "(no level)")) byLevel[g.Key] = g.Count();
        var types = new JsonArray();
        foreach (var s in new FilteredElementCollector(d).OfCategory(BuiltInCategory.OST_LightingFixtures).WhereElementIsElementType().OfType<FamilySymbol>().OrderBy(s => s.FamilyName).ThenBy(s => s.Name).Take(200))
            types.Add(new JsonObject { ["family"] = s.FamilyName, ["type"] = s.Name, ["placement"] = s.Family.FamilyPlacementType.ToString(), ["active"] = s.IsActive });
        var data = new JsonObject { ["count"] = fixtures.Count, ["byType"] = byType, ["byLevel"] = byLevel, ["fixtures"] = items, ["truncated"] = fixtures.Count > limit, ["availableTypes"] = types };
        return CommandResult.Success($"{fixtures.Count} lighting fixture(s) in \"{d.Title}\".", data, true, "FilteredElementCollector of Lighting Fixtures instances (element types excluded)");
    }

    private static CommandResult ElementGet(Document d, JsonObject p)
    {
        var id = (long)Params.Num(p, "elementId");
        var e = d.GetElement(new ElementId(id)) ?? throw new CommandFailure("invalid-params", $"There is no element with id {id} in \"{d.Title}\".");
        var fi = e as FamilyInstance;
        var data = new JsonObject
        {
            ["id"] = IdOf(e), ["category"] = e.Category?.Name, ["name"] = e.Name, ["family"] = fi?.Symbol?.FamilyName, ["type"] = fi?.Symbol?.Name,
            ["level"] = fi != null ? LevelName(d, fi.LevelId) : LevelName(d, e.LevelId), ["comments"] = ParamString(e, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS), ["mark"] = ParamString(e, BuiltInParameter.ALL_MODEL_MARK),
        };
        return CommandResult.Success($"Element {id}: {e.Category?.Name} \"{e.Name}\".", data, true, "d.GetElement");
    }

    // ---- edits (scratch models only) ----

    private static readonly Dictionary<string, BuiltInParameter> WritableParameters = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Comments"] = BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS,
        ["Mark"] = BuiltInParameter.ALL_MODEL_MARK,
    };

    private sealed class RollbackOnErrors : IFailuresPreprocessor
    {
        public FailureProcessingResult PreprocessFailures(FailuresAccessor a)
        {
            var failures = a.GetFailureMessages();
            if (failures.Any(f => f.GetSeverity() == FailureSeverity.Error)) return FailureProcessingResult.ProceedWithRollBack;
            if (failures.Count > 0) a.DeleteAllWarnings();
            return FailureProcessingResult.Continue;
        }
    }

    private static void Commit(Transaction t)
    {
        var o = t.GetFailureHandlingOptions();
        o.SetFailuresPreprocessor(new RollbackOnErrors());
        o.SetClearAfterRollback(true);
        t.SetFailureHandlingOptions(o);
        var st = t.Commit();
        if (st != TransactionStatus.Committed) throw new CommandFailure("app-error", "Revit rolled the change back, so nothing was changed.");
    }

    private static CommandResult ParameterSet(UIApplication app, JsonObject p)
    {
        var d = EditableDoc(app, p);
        var id = (long)Params.Num(p, "elementId");
        var pname = Params.Str(p, "parameter");
        var value = Params.Str(p, "value", false);
        if (value.Length > 250) throw new CommandFailure("invalid-params", "The value is longer than 250 characters.");
        if (!WritableParameters.TryGetValue(pname, out var bip)) throw new CommandFailure("invalid-params", $"\"{pname}\" is not an approved writable parameter. Approved: {string.Join(", ", WritableParameters.Keys)}.");
        var e = d.GetElement(new ElementId(id)) ?? throw new CommandFailure("invalid-params", $"There is no element with id {id}.");
        if (e is ElementType) throw new CommandFailure("invalid-params", "Only element instances can be changed, not types.");
        var prm = e.get_Parameter(bip);
        if (prm == null) throw new CommandFailure("invalid-params", $"Element {id} has no \"{pname}\" parameter.");
        if (prm.IsReadOnly || prm.StorageType != StorageType.String) throw new CommandFailure("invalid-params", $"\"{pname}\" cannot be written on element {id}.");
        var before = prm.AsString() ?? "";
        using (var t = new Transaction(d, $"CreateCraft: set {pname}"))
        {
            t.Start();
            try
            {
                if (!prm.Set(value)) throw new CommandFailure("app-error", $"Revit refused to set \"{pname}\".");
                Commit(t);
            }
            catch { if (t.GetStatus() == TransactionStatus.Started) t.RollBack(); throw; }
        }
        var after = d.GetElement(new ElementId(id))?.get_Parameter(bip)?.AsString() ?? "";
        if (after != value) throw new CommandFailure("verification-failed", $"After the change \"{pname}\" reads \"{after}\", not \"{value}\".");
        return CommandResult.Success($"Set {pname} of element {id} to \"{value}\" (was \"{before}\"). It is one step in Revit's Undo list: \"CreateCraft: set {pname}\".",
            new JsonObject { ["elementId"] = id, ["parameter"] = pname, ["before"] = before, ["after"] = after }, true,
            $"read back {pname} = \"{after}\" after the transaction committed");
    }

    private static CommandResult PlaceTest(UIApplication app, JsonObject p)
    {
        var d = EditableDoc(app, p);
        var typeName = Params.Str(p, "typeName");
        var familyName = Params.Str(p, "familyName", false);
        var levelName = Params.Str(p, "levelName");
        var x = Params.Num(p, "xMm"); var y = Params.Num(p, "yMm");
        var symbols = new FilteredElementCollector(d).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>()
            .Where(s => s.Name.Equals(typeName, StringComparison.OrdinalIgnoreCase) && (familyName == "" || s.FamilyName.Equals(familyName, StringComparison.OrdinalIgnoreCase))).ToList();
        if (symbols.Count == 0) throw new CommandFailure("invalid-params", $"This project has no family type \"{typeName}\"{(familyName == "" ? "" : " in family \"" + familyName + "\"")}. CreateCraft does not load families; load a test family in the scratch model first.");
        if (symbols.Count > 1) throw new CommandFailure("invalid-params", $"More than one family has a type called \"{typeName}\". Say which family: {string.Join(", ", symbols.Select(s => s.FamilyName).Distinct())}.");
        var sym = symbols[0];
        if (sym.Family.IsInPlace) throw new CommandFailure("invalid-params", "In-place families cannot be placed.");
        if (sym.Family.FamilyPlacementType != FamilyPlacementType.OneLevelBased)
            throw new CommandFailure("invalid-params", $"\"{sym.FamilyName}\" is placed by {sym.Family.FamilyPlacementType}, not by a simple point on a level. Pick a free-standing, level-based test family (or a Generic Model).");
        var level = new FilteredElementCollector(d).OfClass(typeof(Level)).Cast<Level>().FirstOrDefault(l => l.Name.Equals(levelName, StringComparison.OrdinalIgnoreCase))
            ?? throw new CommandFailure("invalid-params", $"There is no level named \"{levelName}\". Levels: {string.Join(", ", new FilteredElementCollector(d).OfClass(typeof(Level)).Select(l => l.Name))}.");
        FamilyInstance inst;
        using (var t = new Transaction(d, "CreateCraft: place test family"))
        {
            t.Start();
            try
            {
                if (!sym.IsActive) { sym.Activate(); d.Regenerate(); }
                inst = d.Create.NewFamilyInstance(new XYZ(x / MmPerFoot, y / MmPerFoot, level.Elevation), sym, level, Autodesk.Revit.DB.Structure.StructuralType.NonStructural);
                inst.get_Parameter(BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS)?.Set(TestMarker);
                Commit(t);
            }
            catch { if (t.GetStatus() == TransactionStatus.Started) t.RollBack(); throw; }
        }
        var again = d.GetElement(inst.Id) as FamilyInstance;
        if (again == null || ParamString(again, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS) != TestMarker) throw new CommandFailure("verification-failed", "Revit does not list the new instance after the change.");
        return CommandResult.Success($"Placed \"{sym.FamilyName} : {sym.Name}\" (id {IdOf(inst)}) on {level.Name}. Marked \"{TestMarker}\" so it can be removed with revit.element.remove_test or Revit's Undo.",
            new JsonObject { ["elementId"] = IdOf(inst), ["family"] = sym.FamilyName, ["type"] = sym.Name, ["level"] = level.Name, ["xMm"] = x, ["yMm"] = y }, true,
            "the new instance was found again by id after the transaction committed");
    }

    private static CommandResult RemoveTest(UIApplication app, JsonObject p)
    {
        var d = EditableDoc(app, p);
        var id = (long)Params.Num(p, "elementId");
        var e = d.GetElement(new ElementId(id)) as FamilyInstance ?? throw new CommandFailure("invalid-params", $"Element {id} is not a placed family instance.");
        if (ParamString(e, BuiltInParameter.ALL_MODEL_INSTANCE_COMMENTS) != TestMarker) throw new CommandFailure("invalid-params", $"Element {id} was not placed by CreateCraft's test placement, so it will not be removed.");
        using (var t = new Transaction(d, "CreateCraft: remove test placement"))
        {
            t.Start();
            try { d.Delete(e.Id); Commit(t); }
            catch { if (t.GetStatus() == TransactionStatus.Started) t.RollBack(); throw; }
        }
        if (d.GetElement(new ElementId(id)) != null) throw new CommandFailure("verification-failed", "The element is still in the project.");
        return CommandResult.Success($"Removed the test placement (id {id}).", new JsonObject { ["removedElementId"] = id }, true, "the element is no longer found after the transaction committed");
    }
}
