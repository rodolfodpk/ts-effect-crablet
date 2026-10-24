# ADR-0044: Time in the domain is an Effect DateTime: `now` and `Instant`

## Status

**Accepted** (2026-10-24). Built: `DecideContext.now` is a `DateTime.Utc` (`@crablet/commands/Command`); `Instant` and events stored encoded by their
schema come first, in the change before this one. Breaking: every `decide` that reads `now` as a `Date` changes.

## Context

A rule about time needs two instants: one recorded on an event (when a student subscribed) and the one the decision is made at (`now`). Before this,
both were awkward:

- `now` was a JavaScript `Date`, mutable, with millisecond arithmetic by hand.
- An event could only hold time as text: its builder stored the payload in its decoded form, so a field whose schema transforms
  (`Schema.DateTimeUtcFromString`) died in the `byModel()` check. Every use converted by hand, `now.toISOString()` to store and `Date.parse(...)` to
  read, and `Date.parse` answers `NaN` for text that is not a date, which a comparison then gets quietly wrong.

A payment window written that way needed a helper schema, three conversions, and a type (`string`) that accepted any text.

## Decision

- **Events are stored encoded by their schema** (the previous change), so a payload field may transform.
- **`Instant`** (`@crablet/commands/Domain`, `= Schema.DateTimeUtcFromString`) is the type of an instant in a payload: stored as ISO-8601 text in UTC,
  read as a `DateTime.Utc`. A plain string where one is declared does not compile; stored text that is not an instant fails to decode.
- **`now` is a `DateTime.Utc`**: the same instant as before (the clock, read once per attempt; the one a period was decided at), in the type an
  `Instant` field holds. Business code stamps and compares without converting:

  ```ts
  emit(StudentSubscribed({ ...c, subscribedAt: now }))                       // subscribedAt: Instant
  windowClosesAt: DateTime.add(d.subscribedAt, { days: 3 })                  // in the model
  DateTime.isGreaterThanOrEqualTo(now, s.windowClosesAt)                     // in decide
  ```

- A text field that already holds time keeps its stored shape, and is stamped with `DateTime.formatIso(now)`; it can become an `Instant` later without
  rewriting stored events (the text is the same).

## Consequences

- The wallet's commands stamp their text fields with `DateTime.formatIso(now)`, and its welcome notification now uses `now` instead of `new Date()`.
- The tests that fix the clock (`Scenario.at(date)`) are unchanged: `at` still takes a `Date`, and the scenario's clock turns it into `now`.
- Not changed yet, each a follow-up:
  - `Period.custom`'s `fieldsAt(now)` still receives a `Date`;
  - a view's `timestamptz` column takes ISO text, so a view writing an `Instant` field formats it; letting it take a `DateTime` would let the
    wallet's events move to `Instant` with no formatting anywhere.

## Alternatives considered

- **Keep `now` a `Date`, with `Instant` fields.** Additive, but one conversion (`DateTime.fromDateUnsafe(now)`) at every use, in every domain file.
- **`Date` everywhere, with `Schema.DateFromString`.** No conversion with `now` as it was, but a mutable value in the domain's state and arithmetic in
  milliseconds; `DateTime` is immutable and has the calendar operations (`add`, `distance`, time zones).
- **A branded string (`string & Brand<"IsoInstant">`).** Type-safe without changing the framework, but still a conversion in each direction.
