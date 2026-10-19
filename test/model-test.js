// Unit tests for Model.js. Run with: node test/model-test.js
// Model.js is a QML JS library, so its ".pragma library" line is stripped
// before it is evaluated under node.

var fs = require("fs")
var path = require("path")
var assert = require("assert")
var vm = require("vm")

var source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  .replace(/^\.pragma library\s*$/m, "")
var M = {}
vm.runInNewContext(source, M)

// Arrays made inside the vm context have another Array prototype, which
// deepStrictEqual counts as a difference; compare ids as a plain array.
function ids(list) { return list.map(function (e) { return e.mouse || e.id }).join(",") }

var failures = 0
function test(name, fn) {
  try { fn(); console.log("ok   " + name) }
  catch (e) { failures++; console.log("FAIL " + name + "\n     " + e.message) }
}

// ---- fixtures: entries as `mousectl battery --json` prints them

function reading(id, percent, state, link) {
  return { mouse: id, name: id.toUpperCase(), link: link || "dongle", path: "/dev/hidraw1",
           battery: { percent: percent, state: state || "discharging" }, error: null }
}
function asleep(id) {
  return { mouse: id, name: id.toUpperCase(), link: "dongle", path: "/dev/hidraw1", battery: null,
           error: { code: "no-answer", message: "no battery report (move/click the mouse and retry)" } }
}
function wired(id) {
  return { mouse: id, name: id.toUpperCase(), link: "wired", path: "/dev/hidraw1", battery: null, error: null }
}
function failing(id, code) {
  return { mouse: id, name: id.toUpperCase(), link: null, path: null, battery: null,
           error: { code: code, message: code + " problem" } }
}
function doc(mice) { return JSON.stringify({ interface: 1, mice: mice }) }

var MIN = 60000

// ---- parse

test("parse returns the mice of a version 1 document", function () {
  assert.strictEqual(ids(M.parse(doc([wired("a")]))), "a")
})

test("parse rejects another interface version, naming both", function () {
  assert.throws(function () { M.parse(JSON.stringify({ interface: 2, mice: [] })) }, /2.*1|1.*2/)
})

test("parse rejects output that is not JSON (mousectl too old for --json shapes)", function () {
  assert.throws(function () { M.parse("[]") })
  assert.throws(function () { M.parse("garbage") })
})

// ---- merge: one poll folded into what we already knew

test("a reading marks the mouse present, awake and seen now", function () {
  var s = M.merge({}, [reading("a", 80)], 1000)
  assert.strictEqual(s.a.present, true)
  assert.strictEqual(s.a.awake, true)
  assert.strictEqual(s.a.percent, 80)
  assert.strictEqual(s.a.state, "discharging")
  assert.strictEqual(s.a.lastSeen, 1000)
  assert.strictEqual(s.a.wokeAt, 1000)
  assert.strictEqual(s.a.name, "A")
  assert.strictEqual(s.a.error, null)
})

test("staying awake keeps the time it woke up", function () {
  var s = M.merge({}, [reading("a", 80)], 1000)
  s = M.merge(s, [reading("a", 79)], 2000)
  assert.strictEqual(s.a.wokeAt, 1000)
  assert.strictEqual(s.a.lastSeen, 2000)
})

test("asleep keeps the last known level and when it was seen", function () {
  var s = M.merge({}, [reading("a", 80)], 1000)
  s = M.merge(s, [asleep("a")], 2000)
  assert.strictEqual(s.a.awake, false)
  assert.strictEqual(s.a.present, true)
  assert.strictEqual(s.a.percent, 80)
  assert.strictEqual(s.a.lastSeen, 1000)
  assert.strictEqual(s.a.error, null)
})

test("waking up again resets the wake time", function () {
  var s = M.merge({}, [reading("a", 80)], 1000)
  s = M.merge(s, [asleep("a")], 2000)
  s = M.merge(s, [reading("a", 80)], 3000)
  assert.strictEqual(s.a.wokeAt, 3000)
})

test("on its cable a mouse is awake and wired, keeping the last level", function () {
  var s = M.merge({}, [reading("a", 40)], 1000)
  s = M.merge(s, [wired("a")], 2000)
  assert.strictEqual(s.a.awake, true)
  assert.strictEqual(s.a.state, "wired")
  assert.strictEqual(s.a.percent, 40)
  assert.strictEqual(s.a.link, "wired")
})

test("permission and io errors are kept for display, no-answer is not an error", function () {
  var s = M.merge({}, [failing("a", "permission"), failing("b", "io"), asleep("c")], 1000)
  assert.strictEqual(s.a.error.code, "permission")
  assert.strictEqual(s.b.error.code, "io")
  assert.strictEqual(s.c.error, null)
})

test("an unplugged mouse is remembered but not present", function () {
  var s = M.merge({}, [reading("a", 80)], 1000)
  s = M.merge(s, [], 2000)
  assert.strictEqual(s.a.present, false)
  assert.strictEqual(s.a.awake, false)
  assert.strictEqual(s.a.percent, 80)
})

test("merge does not modify the previous state", function () {
  var s1 = M.merge({}, [reading("a", 80)], 1000)
  M.merge(s1, [asleep("a")], 2000)
  assert.strictEqual(s1.a.awake, true)
})

// ---- current: the one mouse the bar shows

test("no mouse: nothing to show", function () {
  assert.strictEqual(M.current({}), null)
  assert.strictEqual(M.current(M.merge(M.merge({}, [reading("a", 80)], 1), [], 2)), null)
})

test("the mouse picked up most recently wins", function () {
  var s = M.merge({}, [reading("a", 80), asleep("b"), asleep("c")], 1 * MIN)
  assert.strictEqual(M.current(s).id, "a")
  s = M.merge(s, [reading("a", 80), reading("b", 60), asleep("c")], 2 * MIN)   // b picked up, a not asleep yet
  assert.strictEqual(M.current(s).id, "b")
})

test("several awake since the same poll: the lowest battery wins", function () {
  var s = M.merge({}, [reading("a", 80), reading("b", 30), reading("c", 55)], 1000)
  assert.strictEqual(M.current(s).id, "b")
})

test("all asleep: the one seen last, so the bar keeps its last reading", function () {
  var s = M.merge({}, [reading("a", 80), asleep("b")], 1 * MIN)
  s = M.merge(s, [asleep("a"), reading("b", 50)], 2 * MIN)
  s = M.merge(s, [asleep("a"), asleep("b")], 3 * MIN)
  assert.strictEqual(M.current(s).id, "b")
  assert.strictEqual(M.current(s).awake, false)
})

test("all asleep and never seen: still names a present mouse", function () {
  var s = M.merge({}, [asleep("a")], 1000)
  assert.strictEqual(M.current(s).id, "a")
})

// ---- rows: the popup list

test("rows: the current mouse first, then awake ones, then by last seen", function () {
  var s = M.merge({}, [reading("a", 80), asleep("b"), asleep("c"), asleep("d")], 1 * MIN)
  s = M.merge(s, [asleep("a"), reading("b", 70), asleep("c"), asleep("d")], 2 * MIN)
  s = M.merge(s, [reading("a", 80), reading("b", 70), asleep("c"), reading("d", 10)], 3 * MIN)
  // a and d woke at 3 min (d lower -> current), b awake since 2 min, c never seen
  assert.strictEqual(ids(M.rows(s)), "d,a,b,c")
})

test("rows leave out unplugged mice", function () {
  var s = M.merge({}, [reading("a", 80), reading("b", 80)], 1000)
  s = M.merge(s, [reading("a", 80)], 2000)
  assert.strictEqual(ids(M.rows(s)), "a")
})

// ---- low: mice to charge

test("low lists present mice at or under the threshold that are not charging", function () {
  var s = M.merge({}, [reading("a", 20), reading("b", 21), reading("c", 5, "charging"),
                       reading("d", 10, "full"), asleep("e")], 1000)
  s = M.merge(s, [reading("a", 20), reading("b", 21), reading("c", 5, "charging"),
                  reading("d", 10, "full"), asleep("e")], 2000)
  assert.strictEqual(ids(M.low(s, 20)), "a")
})

test("low counts asleep mice by their last known level", function () {
  var s = M.merge({}, [reading("a", 12)], 1000)
  s = M.merge(s, [asleep("a")], 2000)
  assert.strictEqual(M.low(s, 20).length, 1)
})

// ---- summary: what the bar paints

test("summary: hidden without mice", function () {
  assert.strictEqual(M.summary({}, 20), null)
})

test("summary: the current mouse's level", function () {
  var sm = M.summary(M.merge({}, [reading("a", 73)], 1000), 20)
  assert.strictEqual(sm.percentText, "73%")
  assert.strictEqual(sm.urgent, false)
  assert.strictEqual(sm.dim, false)
  assert.strictEqual(sm.charging, false)
  assert.strictEqual(sm.otherLow, false)
  assert.strictEqual(sm.id, "a")
})

test("summary: low current mouse is urgent", function () {
  assert.strictEqual(M.summary(M.merge({}, [reading("a", 15)], 1000), 20).urgent, true)
})

test("summary: charging is flagged and never urgent", function () {
  var sm = M.summary(M.merge({}, [reading("a", 15, "charging")], 1000), 20)
  assert.strictEqual(sm.charging, true)
  assert.strictEqual(sm.urgent, false)
})

test("summary: dim when the shown mouse is asleep", function () {
  var s = M.merge({}, [reading("a", 73)], 1000)
  assert.strictEqual(M.summary(M.merge(s, [asleep("a")], 2000), 20).dim, true)
})

test("summary: unknown level", function () {
  assert.strictEqual(M.summary(M.merge({}, [asleep("a")], 1000), 20).percentText, "--")
})

test("summary: another low mouse raises otherLow, not urgent", function () {
  // b was used earlier and left at 9%; a is the mouse in use
  var s = M.merge({}, [reading("b", 9)], 1000)
  s = M.merge(s, [reading("a", 73), asleep("b")], 2000)
  var sm = M.summary(s, 20)
  assert.strictEqual(sm.id, "a")
  assert.strictEqual(sm.otherLow, true)
  assert.strictEqual(sm.urgent, false)
})

test("summary: an error on the shown mouse is urgent and says so", function () {
  var sm = M.summary(M.merge({}, [failing("a", "permission")], 1000), 20)
  assert.strictEqual(sm.urgent, true)
  assert.strictEqual(sm.percentText, "!")
})

// ---- text for the popup

test("ago", function () {
  var now = 10 * 24 * 60 * MIN
  assert.strictEqual(M.ago(0, now), "never")
  assert.strictEqual(M.ago(now - 30000, now), "just now")
  assert.strictEqual(M.ago(now - 5 * MIN, now), "5 min ago")
  assert.strictEqual(M.ago(now - 3 * 60 * MIN, now), "3 h ago")
  assert.strictEqual(M.ago(now - 2 * 24 * 60 * MIN, now), "2 d ago")
})

test("status line per kind of row", function () {
  var now = 1000 * MIN
  var polled = [reading("a", 80), reading("b", 50, "charging"), wired("c"), asleep("d"),
                failing("e", "permission"), failing("f", "io")]
  var s = M.merge({}, [reading("d", 60)], now - 120 * MIN)    // d last used 2 h ago
  s = M.merge(s, polled, now - 10 * MIN)
  s = M.merge(s, polled, now)
  assert.strictEqual(M.statusLine(s.a, now), "awake · dongle")
  assert.strictEqual(M.statusLine(s.b, now), "charging · dongle")
  assert.strictEqual(M.statusLine(s.c, now), "on cable")
  assert.strictEqual(M.statusLine(s.d, now), "asleep · seen 2 h ago")
  assert.match(M.statusLine(s.e, now), /mousectl install-udev/)
  assert.strictEqual(M.statusLine(s.f, now), "io problem")
})

test("status line of a mouse never seen awake", function () {
  assert.strictEqual(M.statusLine(M.merge({}, [asleep("a")], 1000).a, 2000), "asleep · no reading yet")
})

test("battery glyph by level, charging and unknown", function () {
  assert.strictEqual(M.batteryGlyph(null, null), "󰂑")
  assert.strictEqual(M.batteryGlyph(100, "discharging"), "󰁹")
  assert.strictEqual(M.batteryGlyph(5, "discharging"), "󰂎")
  assert.strictEqual(M.batteryGlyph(55, "discharging"), "󰁾")
  assert.strictEqual(M.batteryGlyph(55, "charging"), "󰂄")
})

// ---- clicks and refresh feedback

test("shellQuote survives spaces and quotes", function () {
  assert.strictEqual(M.shellQuote("mousectl"), "'mousectl'")
  assert.strictEqual(M.shellQuote("/opt/my tools/mouse'ctl"), "'/opt/my tools/mouse'\\''ctl'")
})

test("tuiCommand opens mousectl tui through omarchy's TUI launcher", function () {
  assert.strictEqual(M.tuiCommand("mousectl"), "omarchy-launch-or-focus-tui 'mousectl' tui")
})

test("updated line: polling, never polled, and age of the last poll", function () {
  var now = 1000 * MIN
  assert.strictEqual(M.updatedLine(now - 5 * MIN, true, now), "checking mice…")
  assert.strictEqual(M.updatedLine(0, false, now), "not checked yet")
  assert.strictEqual(M.updatedLine(now - 12000, false, now), "updated just now")
  assert.strictEqual(M.updatedLine(now - 3 * MIN, false, now), "updated 3 min ago")
})

// ---- mousectl missing or too old

test("exit 127 means mousectl is not installed", function () {
  var f = M.runFailure(127, "sh: line 1: mousectl: command not found\n")
  assert.strictEqual(f.code, "missing")
  assert.match(f.message, /not installed|not found/)
})

test("any other failure keeps mousectl's last stderr line", function () {
  var f = M.runFailure(2, "usage: ...\nmousectl: error: unrecognized arguments: --json\n")
  assert.strictEqual(f.code, "failed")
  assert.strictEqual(f.message, "mousectl: error: unrecognized arguments: --json")
  assert.strictEqual(M.runFailure(3, "").message, "mousectl exited with 3")
})

test("output the widget can't read means mousectl is outdated", function () {
  var f = M.parseFailure(new Error("mousectl is too old"))
  assert.strictEqual(f.code, "outdated")
  assert.strictEqual(f.message, "mousectl is too old")
})

test("missing and outdated point to the mousectl page, other failures don't", function () {
  assert.strictEqual(M.needsInstall({ code: "missing", message: "" }), true)
  assert.strictEqual(M.needsInstall({ code: "outdated", message: "" }), true)
  assert.strictEqual(M.needsInstall({ code: "failed", message: "" }), false)
  assert.strictEqual(M.needsInstall(null), false)
})

test("the visit line names the GitHub page", function () {
  assert.strictEqual(M.HOMEPAGE, "https://github.com/D3m0nZOnFire/mousectl")
  assert.strictEqual(M.visitLine(), "visit github.com/D3m0nZOnFire/mousectl")
})

test("click opens the TUI, or the mousectl page when it has to be installed", function () {
  assert.strictEqual(M.clickCommand(null, "mousectl"), "omarchy-launch-or-focus-tui 'mousectl' tui")
  assert.strictEqual(M.clickCommand({ code: "failed", message: "x" }, "mousectl"),
                     "omarchy-launch-or-focus-tui 'mousectl' tui")
  assert.strictEqual(M.clickCommand({ code: "missing", message: "x" }, "mousectl"),
                     "omarchy-launch-browser 'https://github.com/D3m0nZOnFire/mousectl'")
})

// ---- cache across shell restarts

test("persist/restore keeps name, level and last seen, nothing live", function () {
  var s = M.merge({}, [reading("a", 80)], 1000)
  var r = M.restore(JSON.parse(JSON.stringify(M.persist(s))))
  assert.strictEqual(r.a.percent, 80)
  assert.strictEqual(r.a.lastSeen, 1000)
  assert.strictEqual(r.a.name, "A")
  assert.strictEqual(r.a.present, false)
  assert.strictEqual(r.a.awake, false)
})

test("restore ignores junk", function () {
  assert.strictEqual(Object.keys(M.restore(null)).length, 0)
  assert.strictEqual(Object.keys(M.restore({ version: 99, mice: { a: {} } })).length, 0)
  assert.strictEqual(Object.keys(M.restore("nope")).length, 0)
})

console.log(failures ? "\n" + failures + " failed" : "\nall passed")
process.exit(failures ? 1 : 0)
