using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace CreateCraft.Revit;

/// <summary>
/// CreateCraft plugin bridge client, protocol 1 (docs/universal-installer.md). Runs on its OWN background thread and never
/// touches the Revit API: every command is handed to <see cref="RevitDispatcher"/>, which runs it inside a Revit
/// ExternalEvent (Revit's supported API context). CreateCraft is the server; this side dials in, proves it knows the pairing
/// secret (mutual HMAC, the secret is never sent), registers its capabilities and answers typed commands.
/// </summary>
internal sealed class BridgeClient : IDisposable
{
    private const int MaxFrame = 1024 * 1024;
    private const int Proto = 1;

    private readonly string _configFile;
    private readonly AppIdentity _app;
    private readonly RevitDispatcher _dispatcher;
    private readonly Func<IReadOnlyList<string>> _capabilities;
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _active = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private Task? _loop;
    private volatile string _state = "connecting";

    public string State => _state;
    public string? Detail { get; private set; }
    public event Action<string, string?>? StateChanged;

    public BridgeClient(string configFile, AppIdentity app, RevitDispatcher dispatcher, Func<IReadOnlyList<string>> capabilities)
    {
        _configFile = configFile; _app = app; _dispatcher = dispatcher; _capabilities = capabilities;
    }

    public void Start() => _loop = Task.Run(RunAsync);

    private void SetState(string s, string? detail = null)
    {
        _state = s; Detail = detail;
        try { StateChanged?.Invoke(s, detail); } catch { /* listener error */ }
    }

    private sealed class Config { public string PluginId = ""; public string Secret = ""; public string EndpointFile = ""; }

    private Config? LoadConfig()
    {
        try
        {
            var j = JsonNode.Parse(File.ReadAllText(_configFile))!.AsObject();
            return new Config { PluginId = (string)j["pluginId"]!, Secret = (string)j["secret"]!, EndpointFile = (string)j["endpointFile"]! };
        }
        catch { return null; }
    }

    private async Task RunAsync()
    {
        var backoff = 250;
        while (!_stop.IsCancellationRequested)
        {
            try
            {
                // The pairing file and the endpoint are re-read on every attempt: CreateCraft picks a new pipe name each run.
                var cfg = LoadConfig();
                if (cfg == null) SetState("connecting", "pairing file missing");
                else
                {
                    string? pipe = null;
                    try { pipe = (string?)JsonNode.Parse(File.ReadAllText(cfg.EndpointFile))!["pipe"]; } catch { /* CreateCraft not running */ }
                    if (pipe == null) SetState("connecting", "CreateCraft is not running");
                    else if (await SessionAsync(cfg, pipe)) backoff = 250;
                }
            }
            catch (OperationCanceledException) { break; }
            catch { /* reconnect */ }
            if (_stop.IsCancellationRequested) break;
            try { await Task.Delay(backoff, _stop.Token); } catch { break; }
            backoff = Math.Min(backoff * 2, 5000);
        }
        SetState("closed");
    }

    /// <summary>One connection. Returns true when it got as far as being welcomed.</summary>
    private async Task<bool> SessionAsync(Config cfg, string pipePath)
    {
        const string prefix = @"\\.\pipe\";
        var name = pipePath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? pipePath[prefix.Length..] : pipePath;
        using var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
        using (var cts = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token))
        {
            cts.CancelAfter(3000);
            try { await pipe.ConnectAsync(cts.Token); }
            catch (OperationCanceledException) when (!_stop.IsCancellationRequested) { SetState("connecting", "CreateCraft did not answer"); return false; }
        }
        var cnonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        string? snonce = null;
        var welcomed = false;
        var buf = new StringBuilder();
        var chunk = new byte[16 * 1024];
        var decoder = Encoding.UTF8.GetDecoder();
        var chars = new char[chunk.Length + 4];
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var n = await pipe.ReadAsync(chunk, _stop.Token);
                if (n == 0) break;
                var c = decoder.GetChars(chunk, 0, n, chars, 0);
                buf.Append(chars, 0, c);
                if (buf.Length > MaxFrame * 2) break;
                int nl;
                while ((nl = IndexOfNewline(buf)) >= 0)
                {
                    var line = buf.ToString(0, nl);
                    buf.Remove(0, nl + 1);
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    JsonObject f;
                    try { f = JsonNode.Parse(line)!.AsObject(); } catch { return welcomed; }
                    switch ((string?)f["t"])
                    {
                        case "hello":
                            snonce = (string)f["nonce"]!;
                            await SendAsync(pipe, new JsonObject
                            {
                                ["t"] = "hello",
                                ["protocol"] = new JsonObject { ["min"] = Proto, ["max"] = Proto },
                                ["pluginId"] = cfg.PluginId,
                                ["pluginVersion"] = AppIdentity.PluginVersion,
                                ["nonce"] = cnonce,
                                ["proof"] = Sign(cfg.Secret, "c", snonce, cnonce, cfg.PluginId, $"{Proto}-{Proto}"),
                                ["app"] = new JsonObject { ["name"] = _app.Name, ["version"] = _app.Version, ["edition"] = _app.Edition, ["pid"] = _app.Pid },
                            });
                            break;
                        case "welcome":
                        {
                            var expect = Sign(cfg.Secret, "s", snonce ?? "", cnonce, cfg.PluginId, f["protocol"]!.ToString());
                            if (!FixedEq(expect, (string?)f["proof"] ?? "")) { SetState("rejected", "the server did not prove it knows the pairing secret"); return false; }
                            welcomed = true;
                            var caps = new JsonArray();
                            foreach (var cap in _capabilities()) caps.Add(cap);
                            await SendAsync(pipe, new JsonObject { ["t"] = "register", ["capabilities"] = caps });
                            SetState("connected");
                            break;
                        }
                        case "reject": SetState("rejected", $"{(string?)f["code"]}: {(string?)f["message"]}"); return false;
                        case "ping": await SendAsync(pipe, new JsonObject { ["t"] = "pong", ["n"] = f["n"]!.DeepClone() }); break;
                        case "cancel": { if (_active.TryGetValue((string)f["id"]!, out var a)) a.Cancel(); break; }
                        case "bye": return welcomed;
                        case "health":
                        {
                            var id = (string)f["id"]!;
                            _ = Task.Run(() => RunWorkAsync(pipe, id, "health", new JsonObject()));
                            break;
                        }
                        case "command":
                        {
                            var id = (string)f["id"]!;
                            var cname = (string)f["name"]!;
                            var p = f["params"] as JsonObject ?? new JsonObject();
                            _ = Task.Run(() => RunWorkAsync(pipe, id, cname, p));
                            break;
                        }
                    }
                }
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (IOException) { /* connection lost */ }
        finally
        {
            foreach (var a in _active.Values) { try { a.Cancel(); } catch { /* done */ } }
            if (welcomed) SetState("disconnected", "connection lost");
        }
        return welcomed;
    }

    private static int IndexOfNewline(StringBuilder sb)
    {
        for (var i = 0; i < sb.Length; i++) if (sb[i] == '\n') return i;
        return -1;
    }

    private async Task RunWorkAsync(NamedPipeClientStream pipe, string id, string name, JsonObject p)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        _active[id] = cts;
        JsonObject frame;
        try
        {
            // The only place work leaves this thread: queued for Revit's own API context.
            var r = await _dispatcher.RunAsync(name, p, cts.Token,
                (stage, fraction) => _ = SendSafeAsync(pipe, new JsonObject { ["t"] = "progress", ["id"] = id, ["stage"] = Trunc(stage, 200), ["fraction"] = fraction }));
            frame = ResultFrame(id, r);
        }
        catch (OperationCanceledException) { frame = ResultFrame(id, CommandResult.Fail("cancelled", "The command was cancelled before or while Revit ran it.")); }
        catch (Exception e) { frame = ResultFrame(id, CommandResult.Fail("app-error", Trunc(e.Message, 900))); }
        finally { _active.TryRemove(id, out _); }
        await SendSafeAsync(pipe, frame);
    }

    internal static JsonObject ResultFrame(string id, CommandResult r)
    {
        var f = new JsonObject { ["t"] = "result", ["id"] = id, ["ok"] = r.Ok };
        if (!string.IsNullOrEmpty(r.Message)) f["message"] = Trunc(r.Message, 950);
        if (r.Data != null)
        {
            var txt = r.Data.ToJsonString();
            if (Encoding.UTF8.GetByteCount(txt) > 60 * 1024) f["data"] = new JsonObject { ["truncated"] = true, ["note"] = "The result was too large for one reply; ask for fewer items." };
            else f["data"] = r.Data.DeepClone();
        }
        if (r.Evidence.Count > 0)
        {
            var ev = new JsonArray();
            foreach (var e in r.Evidence.Take(20)) ev.Add(Trunc(e, 290));
            f["evidence"] = ev;
        }
        if (r.Verified.HasValue) f["verified"] = r.Verified.Value;
        if (!r.Ok) f["error"] = new JsonObject { ["kind"] = r.ErrorKind, ["message"] = Trunc(string.IsNullOrEmpty(r.Message) ? "failed" : r.Message, 900) };
        return f;
    }

    private static string Trunc(string s, int max) => s.Length <= max ? s : s[..max];

    private async Task SendSafeAsync(NamedPipeClientStream pipe, JsonObject f)
    {
        try { await SendAsync(pipe, f); } catch { /* connection closed: the server reports connection-lost */ }
    }

    private async Task SendAsync(NamedPipeClientStream pipe, JsonObject f)
    {
        var bytes = Encoding.UTF8.GetBytes(f.ToJsonString() + "\n");
        await _writeLock.WaitAsync(_stop.Token);
        try { await pipe.WriteAsync(bytes, _stop.Token); await pipe.FlushAsync(_stop.Token); }
        finally { _writeLock.Release(); }
    }

    private static string Sign(string secretHex, string role, string snonce, string cnonce, string pluginId, string binding)
    {
        using var h = new HMACSHA256(Convert.FromHexString(secretHex));
        return Convert.ToHexString(h.ComputeHash(Encoding.UTF8.GetBytes($"cc-bridge|{role}|{snonce}|{cnonce}|{pluginId}|{binding}"))).ToLowerInvariant();
    }

    private static bool FixedEq(string a, string b)
    {
        try { return CryptographicOperations.FixedTimeEquals(Convert.FromHexString(a), Convert.FromHexString(b)); } catch { return false; }
    }

    public void Dispose()
    {
        _stop.Cancel();
        try { _loop?.Wait(1500); } catch { /* closing */ }
        SetState("closed");
    }
}

internal sealed record AppIdentity(string Name, string Version, string Edition, int Pid)
{
    public const string PluginVersion = "1.0.0";
}
