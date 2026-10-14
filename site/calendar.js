import { deadlineCutoff, timezoneKnown } from "./logic.js";

const CRLF = "\r\n";
const encoder = new TextEncoder();

function escapeText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** RFC 5545 §3.1: lines longer than 75 octets continue after CRLF + space. */
function fold(line) {
  const parts = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > (parts.length ? 74 : 75)) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

function utcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function dateValue(iso) {
  return iso.replaceAll("-", "");
}

function nextDay(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function title(event) {
  return `${event.acronym} ${event.edition}`.trim();
}

function description(event, extra) {
  return [
    event.name,
    extra,
    `Confidence: ${event.confidence}`,
    `Official source: ${event.source_url}`,
    "Always confirm dates on the official source.",
  ].filter(Boolean).join("\n");
}

function submissionEvent(event, kind, iso, stamp) {
  const cutoff = deadlineCutoff(iso, event.deadlines.timezone);
  if (!cutoff) return [];
  const zone = timezoneKnown(event.deadlines.timezone)
    ? `Closes 23:59 ${event.deadlines.timezone} on ${iso}.`
    : `Cutoff time not published; shown as 23:59 AoE on ${iso} (the latest it could be).`;
  const start = new Date(cutoff.getTime() - 30 * 60 * 1000);
  return [
    "BEGIN:VEVENT",
    `UID:${event.id}-${kind.toLowerCase()}@deadline-compass`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(new Date(cutoff.getTime() + 1000))}`,
    `SUMMARY:${escapeText(`${title(event)} — ${kind} deadline`)}`,
    `DESCRIPTION:${escapeText(description(event, zone))}`,
    `URL:${event.source_url}`,
    "TRANSP:TRANSPARENT",
    ...["P7D", "P1D"].flatMap((before) => [
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(`${title(event)} ${kind.toLowerCase()} deadline`)}`,
      `TRIGGER:-${before}`,
      "END:VALARM",
    ]),
    "END:VEVENT",
  ];
}

function allDayEvent(event, kind, iso, stamp) {
  return [
    "BEGIN:VEVENT",
    `UID:${event.id}-${kind.toLowerCase().replace(/[^a-z]+/g, "-")}@deadline-compass`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${dateValue(iso)}`,
    `DTEND;VALUE=DATE:${dateValue(nextDay(iso))}`,
    `SUMMARY:${escapeText(`${title(event)} — ${kind}`)}`,
    `DESCRIPTION:${escapeText(description(event, ""))}`,
    `URL:${event.source_url}`,
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ];
}

/**
 * Build an iCalendar file for the given records. Submission gates become
 * timed reminders at their cutoff; notification, camera-ready, and the event
 * itself become all-day entries. With `futureOnly`, dates already behind
 * `now` are left out, so a bulk export stays a list of things still to do.
 */
export function buildIcs(events, { now = new Date(), futureOnly = false, name = "Deadline Compass" } = {}) {
  const stamp = utcStamp(now);
  const today = now.toISOString().slice(0, 10);
  const keep = (iso) => iso && (!futureOnly || iso >= today);
  const body = events.flatMap((event) => {
    const d = event.deadlines;
    return [
      ...(keep(d.abstract) ? submissionEvent(event, "Abstract", d.abstract, stamp) : []),
      ...(keep(d.paper) ? submissionEvent(event, "Paper", d.paper, stamp) : []),
      ...(keep(d.notification) ? allDayEvent(event, "Notification", d.notification, stamp) : []),
      ...(keep(d.camera_ready) ? allDayEvent(event, "Camera-ready", d.camera_ready, stamp) : []),
      ...(event.event_start && keep(event.event_end || event.event_start)
        ? [
          "BEGIN:VEVENT",
          `UID:${event.id}-event@deadline-compass`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${dateValue(event.event_start)}`,
          `DTEND;VALUE=DATE:${dateValue(nextDay(event.event_end || event.event_start))}`,
          `SUMMARY:${escapeText(title(event))}`,
          `LOCATION:${escapeText(event.location)}`,
          `DESCRIPTION:${escapeText(description(event, ""))}`,
          `URL:${event.source_url}`,
          "TRANSP:TRANSPARENT",
          "END:VEVENT",
        ]
        : []),
    ];
  });
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Deadline Compass//Opportunity deadlines//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    ...body,
    "END:VCALENDAR",
  ].map(fold).join(CRLF) + CRLF;
}
