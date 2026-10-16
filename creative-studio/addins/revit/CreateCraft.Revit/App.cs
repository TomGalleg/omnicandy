using System.Diagnostics;
using System.Text.Json.Nodes;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace CreateCraft.Revit;

/// <summary>
/// Entry point. Revit loads this when it starts (through the .addin manifest CreateCraft installed). It only wires the
/// pieces together: an ExternalEvent dispatcher (the supported place to touch the model) and the bridge client, which runs
/// on its own thread and never calls the Revit API.
/// </summary>
public sealed class App : IExternalApplication
{
    private int _idleCount;
    private bool _started;
    private BridgeClient? _bridge;
    private RevitDispatcher? _dispatcher;

    public Result OnStartup(UIControlledApplication application)
    {
        try
        {
            var dir = Path.GetDirectoryName(typeof(App).Assembly.Location)!;
            // The installer writes the pairing file into the add-in folder; the DLL may sit in a sub-folder of it.
            var cfg = new[] { Path.Combine(dir, "cc-bridge.json"), Path.Combine(Directory.GetParent(dir)?.FullName ?? dir, "cc-bridge.json") }
                .FirstOrDefault(File.Exists) ?? Path.Combine(dir, "cc-bridge.json");

            Log.Write("startup; config " + cfg);
            _dispatcher = new RevitDispatcher();
            _dispatcher.Initialise();
            var ca = application.ControlledApplication;
            var identity = new AppIdentity("Revit", ca.VersionNumber, ca.VersionName ?? "Revit", Process.GetCurrentProcess().Id);
            var readOnly = Commands.ReadOnlyMode(dir);
            _bridge = new BridgeClient(cfg, identity, _dispatcher, () => Commands.Capabilities(readOnly));
            _bridge.StateChanged += (st, d) => Log.Write("bridge " + st + (d == null ? "" : ": " + d));
            // The bridge is started by the first Idling event: Revit is then fully started and can answer a command at once.
            // Connecting earlier would advertise an add-in that cannot yet do anything (Revit may still be opening a file
            // or showing start-up dialogs).
            application.ApplicationClosing += OnClosing;
            // Revit raises ExternalEvents only when it happens to be idle and in focus. Idling is the second supported entry
            // point: while a command is waiting it drains the same queue, inside the same API context.
            application.Idling += OnIdling;
            return Result.Succeeded;
        }
        catch (Exception e)
        {
            // Never stop Revit from starting because of this add-in.
            TaskDialog.Show("CreateCraft", "The CreateCraft add-in could not start and is switched off for this session.\n\n" + e.Message);
            return Result.Failed;
        }
    }

    private void OnIdling(object? sender, Autodesk.Revit.UI.Events.IdlingEventArgs e)
    {
        if (!_started) { _started = true; _bridge?.Start(); }
        if (++_idleCount % 200 == 1) Log.Write("idling #" + _idleCount + " work=" + (_dispatcher?.HasWork == true));
        if (_dispatcher == null || !_dispatcher.HasWork || sender is not UIApplication ui) return;
        _dispatcher.Execute(ui);
        if (_dispatcher.HasWork) e.SetRaiseWithoutDelay();
    }

    private void OnClosing(object? sender, Autodesk.Revit.UI.Events.ApplicationClosingEventArgs e) => Shutdown();

    private void Shutdown()
    {
        try { _bridge?.Dispose(); } catch { /* closing */ }
        _bridge = null;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        try { application.ApplicationClosing -= OnClosing; application.Idling -= OnIdling; } catch { /* closing */ }
        Shutdown();
        return Result.Succeeded;
    }
}

/// <summary>
/// Runs queued work inside a Revit ExternalEvent, the Revit-supported way to use the API from outside a Revit callback.
/// Commands are executed one at a time, in the order they arrived.
/// </summary>
public sealed class RevitDispatcher : IExternalEventHandler
{
    internal sealed record Work(string Name, JsonObject Params, CancellationToken Ct, Action<string, double?> Progress, TaskCompletionSource<CommandResult> Tcs);

    private readonly System.Collections.Concurrent.ConcurrentQueue<Work> _queue = new();
    private ExternalEvent? _event;

    /// <summary>Must be called from a Revit API context (OnStartup is one).</summary>
    public bool HasWork => !_queue.IsEmpty;

    public void Initialise() => _event = ExternalEvent.Create(this);

    internal Task<CommandResult> RunAsync(string name, JsonObject p, CancellationToken ct, Action<string, double?> progress)
    {
        if (_event == null) throw new InvalidOperationException("Revit is not ready.");
        var tcs = new TaskCompletionSource<CommandResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _queue.Enqueue(new Work(name, p, ct, progress, tcs));
        Log.Write("queued " + name + "; raise=" + _event.Raise());
        return tcs.Task;
    }

    public void Execute(UIApplication app)
    {
        while (_queue.TryDequeue(out var w))
        {
            Log.Write("dequeued " + w.Name + " cancelled=" + w.Ct.IsCancellationRequested);
            if (w.Ct.IsCancellationRequested) { w.Tcs.TrySetResult(CommandResult.Fail("cancelled", "Cancelled before Revit started it.")); continue; }
            Log.Write("running " + w.Name);
            try { w.Tcs.TrySetResult(Commands.Run(app, w.Name, w.Params, w.Progress, w.Ct)); }
            catch (CommandFailure f) { w.Tcs.TrySetResult(CommandResult.Fail(f.Kind, f.Message)); }
            catch (OperationCanceledException) { w.Tcs.TrySetResult(CommandResult.Fail("cancelled", "The command was cancelled.")); }
            catch (Autodesk.Revit.Exceptions.OperationCanceledException) { w.Tcs.TrySetResult(CommandResult.Fail("cancelled", "Revit cancelled the operation.")); }
            catch (Exception e) { w.Tcs.TrySetResult(CommandResult.Fail("app-error", $"{e.GetType().Name}: {e.Message}")); }
        }
    }

    public string GetName() => "CreateCraft bridge";
}
