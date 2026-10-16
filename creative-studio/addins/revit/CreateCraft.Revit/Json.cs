using System.Text.Json.Nodes;

namespace CreateCraft.Revit;

/// <summary>What a command hands back to the bridge. Mirrors the protocol's "result" frame.</summary>
internal sealed class CommandResult
{
    public bool Ok = true;
    public string Message = "";
    public JsonObject? Data;
    public List<string> Evidence = new();
    public bool? Verified;
    /// <summary>One of: app-error, unsupported, invalid-params, cancelled, verification-failed.</summary>
    public string ErrorKind = "app-error";

    public static CommandResult Success(string message, JsonObject? data = null, bool verified = true, params string[] evidence)
        => new() { Ok = true, Message = message, Data = data, Verified = verified, Evidence = evidence.ToList() };

    public static CommandResult Fail(string kind, string message) => new() { Ok = false, ErrorKind = kind, Message = message };
}

internal sealed class CommandFailure : Exception
{
    public string Kind { get; }
    public CommandFailure(string kind, string message) : base(message) { Kind = kind; }
}

internal static class Params
{
    public static string Str(JsonObject p, string name, bool required = true)
    {
        var v = p[name];
        string? s = null;
        if (v is JsonValue jv) { if (!jv.TryGetValue(out s)) s = jv.ToString(); }
        if (string.IsNullOrWhiteSpace(s))
        {
            if (required) throw new CommandFailure("invalid-params", $"\"{name}\" is required.");
            return "";
        }
        return s.Trim();
    }

    public static double Num(JsonObject p, string name, double? dflt = null)
    {
        var v = p[name];
        if (v is JsonValue jv)
        {
            if (jv.TryGetValue(out double d)) return d;
            if (jv.TryGetValue(out string? s) && double.TryParse(s, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d)) return d;
        }
        if (dflt.HasValue) return dflt.Value;
        throw new CommandFailure("invalid-params", $"\"{name}\" must be a number.");
    }
}
