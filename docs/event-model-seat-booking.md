# The seat-booking quick start, as an Event Model

The README's quick start declares `AddSeat`, `BookSeat` and `SeatModel`. This is the same thing as an [Event Model](https://eventmodeling.org/):
time runs left to right, and the declarations are the blueprint. Not checked by a test: if the quick start changes, update this by hand.

```text
 Screen     ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        ┌─────────┐
            │ Add seat│ │Book seat│ │Book seat│ │Book seat│ │  Seat   │        │  Seat   │
            │  (12A)  │ │(12A,Ann)│ │(12A,Bob)│ │(99Z,Bob)│ │   map   │        │   map   │
            └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └─────────┘        └─────────┘
                 │           │           │           │           ▲                  ▲
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─
                 ▼           ▼           ▼           ▼           │                  │
 Command    ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │                  │
            │ AddSeat │ │BookSeat │ │BookSeat │ │BookSeat │      │                  │
            └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘      │                  │
   SeatModel    exists:no   exists:yes  exists:yes  exists:no     │                  │
   at decide    taken:no    taken:no    taken:yes   taken:no      │                  │
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─
                 ▼           ▼           ▼           ▼           │                  │
 Event log  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐      │                  │
            │SeatAdded│▶│SeatBook-│ │SeatTaken│ │SeatNot- │      │                  │
            │seat=12A │ │ed 12A   │ │ rejected│ │Found    │      │                  │
            └────┬────┘ └────┬────┘ │  (409)  │ │rejected │      │                  │
                 │           │      └─────────┘ │  (404)  │      │                  │
                 │           │       (errors write no event)     │                  │
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─
                 ▼           ▼                                   │                  │
 Read model ┌──────────────────────────────────────────────────────────────────────────┐
            │ AvailableSeats:   12A listed  ──────▶  12A removed      (updated async) │
            └──────────────────────────────────────────────────────────────────────────┘
```

The read model is not part of the quick start (it needs the poller); the [tutorial](./tutorial/README.md) builds one.
