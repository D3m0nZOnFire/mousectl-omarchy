import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// The one poller behind every bar. The bar exists once per monitor, and two
// mousectl processes talking to the same dongle read each other's answers,
// so the widgets only display what this singleton collects.
Item {
  id: root

  property var shell: null
  property var manifest: null

  // Set by the bar widget from its shell.json entry.
  property string command: "mousectl"
  property int intervalSec: 30

  property var mice: ({})
  property string problem: ""         // why there is nothing to show, or ""
  property real lastPoll: 0
  property bool ready: false          // cache read (or absent): start polling
  readonly property bool polling: proc.running

  property string _out: ""
  property string _err: ""

  readonly property string cachePath:
    (Quickshell.env("XDG_CACHE_HOME") || Quickshell.env("HOME") + "/.cache") + "/mousectl-omarchy.json"

  function refresh() {
    if (ready && !proc.running) proc.running = true
  }

  function ingest(exitCode, out, err) {
    if (exitCode !== 0 || out.trim() === "") {
      var last = err.trim().split("\n").pop()
      problem = exitCode === 127 ? "mousectl not found on PATH"
        : (last || "mousectl exited with " + exitCode)
      return
    }
    var now = Date.now()
    try {
      mice = Model.merge(mice, Model.parse(out), now)
    } catch (e) {
      problem = String(e.message || e)
      return
    }
    problem = ""
    lastPoll = now
    cache.setText(JSON.stringify(Model.persist(mice)) + "\n")
  }

  Process {
    id: proc
    // Through sh so a missing binary is exit 127 rather than a silent failure.
    command: ["sh", "-c", "exec \"$0\" battery --json", root.command]
    stdout: StdioCollector { id: stdoutCollector; waitForEnd: true; onStreamFinished: root._out = text }
    stderr: StdioCollector { id: stderrCollector; waitForEnd: true; onStreamFinished: root._err = text }
    onExited: function(exitCode) {
      root.ingest(exitCode, String(stdoutCollector.text || root._out || ""),
                  String(stderrCollector.text || root._err || ""))
      root._out = ""
      root._err = ""
    }
  }

  FileView {
    id: cache
    path: root.cachePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: {
      try { root.mice = Model.restore(JSON.parse(text())) } catch (e) { }
      root.ready = true
    }
    onLoadFailed: root.ready = true
  }

  Timer {
    interval: Math.max(5, root.intervalSec) * 1000
    repeat: true
    running: root.ready
    triggeredOnStart: true
    onTriggered: root.refresh()
  }
}
