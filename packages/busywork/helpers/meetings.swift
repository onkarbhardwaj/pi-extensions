// Lists one day's calendar meetings with your RSVP status, using macOS EventKit.
//
// Build: ./build.sh (an app bundle, recommended) or swiftc -O meetings.swift -o bin/meetings
// Usage: meetings [today|tomorrow|YYYY-MM-DD] [--json] [--out FILE]
//
// --out writes the result (or {"error": "..."} on failure) to FILE instead of stdout. The app bundle
// is launched with `open`, which has no stdout to read, so callers use --out with it.
//
// Status values: accepted, tentative, declined, invited (no reply), organizer,
// own (no attendees), unknown (not listed individually, e.g. a mailing-list invite).
// The first run asks macOS for calendar access for the calling terminal.

import EventKit
import Foundation

var outPath: String? = nil

func emit(_ text: String) {
  guard let outPath else { print(text); return }
  do {
    // Atomic: the caller never reads a half-written file.
    try (text + "\n").write(to: URL(fileURLWithPath: outPath), atomically: true, encoding: .utf8)
  } catch {
    FileHandle.standardError.write("Cannot write \(outPath): \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
  }
}

func fail(_ message: String) -> Never {
  if outPath != nil,
     let data = try? JSONSerialization.data(withJSONObject: ["error": message]),
     let text = String(data: data, encoding: .utf8) {
    emit(text)
  } else {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  }
  exit(1)
}

var dayArgument = "today"
var json = false
var arguments = Array(CommandLine.arguments.dropFirst())
while !arguments.isEmpty {
  let argument = arguments.removeFirst()
  if argument == "--json" { json = true }
  else if argument == "--out" {
    guard !arguments.isEmpty else { fail("--out needs a file path.") }
    outPath = arguments.removeFirst()
  }
  else if argument == "-h" || argument == "--help" { print("Usage: meetings [today|tomorrow|YYYY-MM-DD] [--json] [--out FILE]"); exit(0) }
  else { dayArgument = argument }
}

let calendar = Calendar.current
let today = calendar.startOfDay(for: Date())
let start: Date
switch dayArgument {
case "today": start = today
case "tomorrow": start = calendar.date(byAdding: .day, value: 1, to: today)!
default:
  let parser = DateFormatter()
  parser.dateFormat = "yyyy-MM-dd"
  parser.timeZone = .current
  guard let date = parser.date(from: dayArgument) else { fail("Expected today, tomorrow, or YYYY-MM-DD.") }
  start = calendar.startOfDay(for: date)
}
let end = calendar.date(byAdding: .day, value: 1, to: start)!

let store = EKEventStore()
let access = DispatchSemaphore(value: 0)
var granted = false
if #available(macOS 14.0, *) {
  store.requestFullAccessToEvents { ok, _ in granted = ok; access.signal() }
} else {
  store.requestAccess(to: .event) { ok, _ in granted = ok; access.signal() }
}
access.wait()
guard granted else { fail("Calendar access denied. Allow it in System Settings → Privacy & Security → Calendars.") }

func describe(_ status: EKParticipantStatus) -> String {
  switch status {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  case .pending: return "invited"
  case .delegated: return "delegated"
  default: return "unknown"
  }
}

func rsvp(_ event: EKEvent) -> String {
  if let me = event.attendees?.first(where: { $0.isCurrentUser }) { return describe(me.participantStatus) }
  if event.organizer?.isCurrentUser == true { return "organizer" }
  return (event.attendees?.isEmpty ?? true) ? "own" : "unknown"
}

let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
  .filter { !$0.isAllDay }
  .sorted { $0.startDate < $1.startDate }

if json {
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime]
  iso.timeZone = .current
  let records: [[String: Any]] = events.map { event in
    // The external identifier is shared by recurring occurrences, so the start time keeps each occurrence unique.
    let base = event.calendarItemExternalIdentifier ?? event.eventIdentifier ?? ""
    return [
      "id": "\(base)@\(iso.string(from: event.startDate))",
      "title": event.title ?? "",
      "start": iso.string(from: event.startDate),
      "end": iso.string(from: event.endDate),
      "status": rsvp(event),
      "canceled": event.status == .canceled,
      "organizer": event.organizer?.name ?? "",
      "calendar": event.calendar.title,
    ]
  }
  let data = try! JSONSerialization.data(withJSONObject: records, options: [.prettyPrinted, .sortedKeys])
  emit(String(data: data, encoding: .utf8)!)
} else {
  let time = DateFormatter()
  time.dateFormat = "HH:mm"
  emit(events.map { event in
    let canceled = event.status == .canceled ? "CANCELED " : ""
    return "\(time.string(from: event.startDate))-\(time.string(from: event.endDate))\t\(rsvp(event))\t\(canceled)\(event.title ?? "")"
  }.joined(separator: "\n"))
}
