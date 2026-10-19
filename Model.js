.pragma library

// Pure state logic for the mousectl widget: folding `mousectl battery --json`
// polls into what is known about each mouse, and deciding what the bar shows.
// Qt-free so it can be unit tested under node (test/model-test.js).
//
// Several mice can sit on one desk (dongles in a dock) while only one is in
// use. mousectl can't see input, but a wireless mouse that is put down goes to
// sleep and stops answering, so "answers" means "recently used". The bar shows
// the mouse that woke up last; the rest keep their last known level.

var INTERFACE = 1
var CACHE_VERSION = 1

// ---- input

// The mice of a `mousectl battery --json` document; throws on anything this
// widget wasn't written for.
function parse(text) {
  var doc = JSON.parse(text)
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw new Error("mousectl is too old for this widget (needs mousectl 0.2.0 or newer)")
  if (doc.interface !== INTERFACE)
    throw new Error("mousectl speaks interface " + doc.interface + ", this widget understands "
      + INTERFACE + " -- update " + (doc.interface > INTERFACE ? "the widget" : "mousectl"))
  return Array.isArray(doc.mice) ? doc.mice : []
}

// ---- state: { <mouse id>: entry }
//
// entry: id, name, link, present (plugged in), awake (answered this poll),
// wokeAt (when it last went from silent to answering), lastSeen (last time
// it answered), percent, state ("charging" | "discharging" | "full" |
// "unknown" | "wired" | null), error ({code, message} for permission/io).

function copy(e) {
  var out = {}
  for (var k in e) out[k] = e[k]
  return out
}

function merge(prev, mice, now) {
  var next = {}
  for (var id in prev) {
    var gone = copy(prev[id])
    gone.present = false
    gone.awake = false
    next[id] = gone
  }
  for (var i = 0; i < mice.length; i++) {
    var m = mice[i]
    var p = prev[m.mouse] || {}
    var e = {
      id: m.mouse, name: m.name, link: m.link || p.link || null, present: true,
      awake: false, wokeAt: 0, lastSeen: p.lastSeen || 0,
      percent: p.percent === undefined ? null : p.percent,
      state: p.state === undefined ? null : p.state, error: null
    }
    if (m.battery) {
      e.awake = true
      e.percent = m.battery.percent
      e.state = m.battery.state
    } else if (!m.error) {
      e.awake = true            // on its cable: powered, no level to report
      e.state = "wired"
    } else if (m.error.code !== "no-answer") {
      e.error = { code: m.error.code, message: m.error.message }
    }
    if (e.awake) {
      e.lastSeen = now
      e.wokeAt = p.awake && p.present ? p.wokeAt : now
    }
    next[m.mouse] = e
  }
  return next
}

function present(state) {
  var out = []
  for (var id in state) if (state[id].present) out.push(state[id])
  return out
}

function byLevel(a, b) {
  var pa = a.percent === null ? 101 : a.percent
  var pb = b.percent === null ? 101 : b.percent
  return pa - pb
}

function rank(a, b) {
  if (a.awake !== b.awake) return a.awake ? -1 : 1
  if (a.awake) return (b.wokeAt - a.wokeAt) || byLevel(a, b) || a.id.localeCompare(b.id)
  return (b.lastSeen - a.lastSeen) || a.id.localeCompare(b.id)
}

// The mouse the bar shows: the one picked up last (lowest level on a tie),
// else the one that answered last.
function current(state) {
  var mice = present(state).sort(rank)
  return mice.length ? mice[0] : null
}

// Popup order: the shown mouse first, then the awake ones, then by last seen.
function rows(state) {
  return present(state).sort(rank)
}

function isLow(e, threshold) {
  return e.percent !== null && e.percent <= threshold
    && e.state !== "charging" && e.state !== "full" && e.state !== "wired"
}

function low(state, threshold) {
  return present(state).filter(function (e) { return isLow(e, threshold) })
}

// What the bar paints, or null to hide.
function summary(state, threshold) {
  var cur = current(state)
  if (!cur) return null
  var others = low(state, threshold).filter(function (e) { return e.id !== cur.id })
  return {
    id: cur.id,
    name: cur.name,
    percentText: cur.error ? "!" : (cur.percent === null ? "--" : cur.percent + "%"),
    charging: cur.state === "charging",
    urgent: !!cur.error || isLow(cur, threshold),
    dim: !cur.awake && !cur.error,
    otherLow: others.length > 0
  }
}

// ---- text

function ago(then, now) {
  if (!then) return "never"
  var s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return Math.floor(s / 60) + " min ago"
  if (s < 86400) return Math.floor(s / 3600) + " h ago"
  return Math.floor(s / 86400) + " d ago"
}

function statusLine(e, now) {
  if (e.error) {
    if (e.error.code === "permission") return "no access -- run mousectl install-udev"
    return e.error.message
  }
  if (e.state === "wired") return "on cable"
  if (!e.awake) return "asleep · " + (e.lastSeen ? "seen " + ago(e.lastSeen, now) : "no reading yet")
  var link = e.link ? " · " + e.link : ""
  if (e.state === "charging") return "charging" + link
  if (e.state === "full") return "full" + link
  return "awake" + link
}

function updatedLine(lastPoll, polling, now) {
  if (polling) return "checking mice…"
  if (!lastPoll) return "not checked yet"
  return "updated " + ago(lastPoll, now)
}

// ---- clicks. The bar API handed to third-party widgets has run() but no
// shellQuote(), so quoting is done here.

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function tuiCommand(command) {
  return "omarchy-launch-or-focus-tui " + shellQuote(command) + " tui"
}

// Nerd Font battery glyphs (md-battery-*).
var LEVEL_GLYPHS = ["󰂎", "󰁺", "󰁻", "󰁼", "󰁽", "󰁾", "󰁿", "󰂀", "󰂁", "󰂂", "󰁹"]

function batteryGlyph(percent, state) {
  if (state === "charging") return "󰂄"
  if (percent === null || percent === undefined) return "󰂑"
  return LEVEL_GLYPHS[Math.max(0, Math.min(10, Math.floor(percent / 10)))]
}

// ---- cache, so asleep mice keep their level across shell restarts

function persist(state) {
  var mice = {}
  for (var id in state) {
    var e = state[id]
    mice[id] = { name: e.name, link: e.link, percent: e.percent, state: e.state, lastSeen: e.lastSeen }
  }
  return { version: CACHE_VERSION, mice: mice }
}

function restore(saved) {
  var out = {}
  if (!saved || typeof saved !== "object" || saved.version !== CACHE_VERSION || !saved.mice) return out
  for (var id in saved.mice) {
    var s = saved.mice[id] || {}
    out[id] = {
      id: id, name: String(s.name || id), link: s.link || null, present: false, awake: false,
      wokeAt: 0, lastSeen: Number(s.lastSeen) || 0,
      percent: typeof s.percent === "number" ? s.percent : null,
      state: typeof s.state === "string" ? s.state : null, error: null
    }
  }
  return out
}
