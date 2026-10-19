import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar label for the mouse in use, and a hover popup listing every mouse.
//
// The data comes from this plugin's service (Service.qml), shared by the
// bars of all monitors. Left click opens `mousectl tui`, right click polls
// again right away.
BarWidget {
  id: root
  moduleName: "d3m0nz.mousectl"

  readonly property var service: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  readonly property var mice: service ? service.mice : ({})
  readonly property int lowThreshold: setting("lowThreshold", 20)
  readonly property var shown: Model.summary(mice, lowThreshold)
  readonly property var mouseRows: Model.rows(mice)
  readonly property string problem: service ? service.problem : "mousectl service not running"
  readonly property bool hasSomething: shown !== null || problem !== ""

  readonly property string mouseGlyph: "󰍽"
  readonly property string labelText: {
    if (!shown) return mouseGlyph + " !"
    if (vertical) return mouseGlyph
    return mouseGlyph + " " + (shown.charging ? "󱐋" : "") + shown.percentText
  }

  property bool popupOpen: false
  property real now: Date.now()
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family

  visible: hasSomething
  implicitWidth: hasSomething ? button.implicitWidth : 0
  implicitHeight: button.implicitHeight

  Binding {
    target: root.service
    when: root.service !== null
    property: "intervalSec"
    value: root.setting("intervalSec", 30)
  }

  Binding {
    target: root.service
    when: root.service !== null
    property: "command"
    value: root.setting("command", "mousectl")
  }

  function open() {
    now = Date.now()
    popupOpen = true
  }

  function close() {
    popupOpen = false
  }

  function closeForPopoutSwitch() {
    close()
  }

  function refresh() {
    if (service) service.refresh()
  }

  function openTui() {
    close()
    if (bar) bar.run(Model.tuiCommand(setting("command", "mousectl")))
  }

  function toggle() {
    if (popupOpen) close()
    else open()
  }

  IpcHandler {
    target: "d3m0nz.mousectl"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refresh() }
  }

  Timer {
    interval: 15000
    repeat: true
    running: root.popupOpen
    onTriggered: root.now = Date.now()
  }

  Timer {
    id: closeTimer
    interval: 250
    onTriggered: if (!button.tooltipHovered && !popup.containsMouse) root.close()
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.labelText
    active: root.shown ? root.shown.urgent : root.problem !== ""
    dimmed: root.shown ? root.shown.dim : false

    onTooltipHoveredChanged: {
      if (tooltipHovered) {
        closeTimer.stop()
        root.open()
      } else {
        closeTimer.restart()
      }
    }

    onPressed: function(b) {
      if (b === Qt.RightButton) root.refresh()
      else root.openTui()
    }
  }

  // Another connected mouse is low: a badge dot, the popup says which.
  Rectangle {
    visible: root.shown !== null && root.shown.otherLow
    width: Style.space(5)
    height: width
    radius: width / 2
    color: root.bar ? root.bar.urgent : Color.urgent
    anchors.right: button.right
    anchors.rightMargin: Style.space(4)
    anchors.top: button.top
    anchors.topMargin: Style.space(5)
  }

  PopupCard {
    id: popup
    anchorItem: button
    bar: root.bar
    owner: root
    triggerMode: "hover"
    open: root.popupOpen
    contentWidth: Style.space(300)
    contentHeight: popup.fittedContentHeight(content.implicitHeight)

    onContainsMouseChanged: {
      if (containsMouse) closeTimer.stop()
      else if (!button.tooltipHovered) closeTimer.restart()
    }

    Column {
      id: content
      width: parent.width
      spacing: Style.space(12)

      Text {
        width: parent.width
        text: "MICE"
        color: root.contentForeground
        horizontalAlignment: Text.AlignHCenter
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.title
        font.bold: true
      }

      Text {
        visible: root.problem !== ""
        width: parent.width
        text: root.problem
        color: root.bar ? root.bar.urgent : Color.urgent
        wrapMode: Text.Wrap
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.body
      }

      Repeater {
        model: root.mouseRows

        MouseRow {
          required property var modelData
          entry: modelData
          isCurrent: root.shown !== null && modelData.id === root.shown.id
        }
      }

      Text {
        width: parent.width
        text: Model.updatedLine(root.service ? root.service.lastPoll : 0,
                                root.service ? root.service.polling : false, root.now)
          + "\nclick: mousectl tui  ·  right click: refresh"
        color: root.contentForeground
        opacity: 0.48
        horizontalAlignment: Text.AlignHCenter
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  component MouseRow: Column {
    id: row
    property var entry: ({})
    property bool isCurrent: false
    readonly property bool lowLevel: entry.percent !== null && entry.percent <= root.lowThreshold
      && entry.state !== "charging" && entry.state !== "full" && entry.state !== "wired"
    readonly property color levelColor: lowLevel ? (root.bar ? root.bar.urgent : Color.urgent) : Color.accent
    width: parent ? parent.width : 0
    spacing: Style.space(4)
    opacity: entry.awake || entry.error ? 1 : 0.6

    Row {
      width: parent.width

      Text {
        width: Style.space(22)
        text: Model.batteryGlyph(row.entry.percent, row.entry.state)
        color: row.levelColor
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        width: parent.width - Style.space(22) - Style.space(48)
        text: row.entry.name
        color: row.isCurrent ? Color.accent : root.contentForeground
        elide: Text.ElideRight
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.body
        font.bold: row.isCurrent
      }
      Text {
        width: Style.space(48)
        text: row.entry.percent === null ? "--" : row.entry.percent + "%"
        color: row.lowLevel ? row.levelColor : root.contentForeground
        horizontalAlignment: Text.AlignRight
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.body
      }
    }

    Text {
      width: parent.width
      leftPadding: Style.space(22)
      text: Model.statusLine(row.entry, root.now)
      color: row.entry.error ? (root.bar ? root.bar.urgent : Color.urgent) : root.contentForeground
      opacity: row.entry.error ? 1 : 0.6
      elide: Text.ElideRight
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.caption
    }

    Rectangle {
      width: parent.width
      height: Style.space(5)
      radius: height / 2
      color: Qt.rgba(root.contentForeground.r, root.contentForeground.g, root.contentForeground.b, 0.12)

      Rectangle {
        width: parent.width * Math.max(0, Math.min(100, row.entry.percent || 0)) / 100
        height: parent.height
        radius: parent.radius
        color: row.levelColor
        Behavior on width { NumberAnimation { duration: 250; easing.type: Easing.OutCubic } }
      }
    }
  }
}
