# Course enrolment, as an Event Model

*Concept · anyone designing with events · the [README](../../README.md) read · 5 minutes*

The README's example declares `CourseDefined`, `StudentSubscribed`, two models and `Subscribe`. This is the same thing as an
[Event Model](https://eventmodeling.org/): time runs left to right, and the declarations are the blueprint. It is not checked by a test, so if the
example changes, update this page by hand.

```text
 Screen     ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      ┌──────────┐
            │  Define  │ │Subscribe │ │Subscribe │ │Subscribe │ │Subscribe │      │  Seats   │
            │math (1)  │ │ann, math │ │bob, math │ │ann, chem │ │cy, ghost │      │   left   │
            └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘      └──────────┘
                 │            │            │      (ann has 3)        │                  ▲
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─ ─ ─ ─┼ ─ ─
                 ▼            ▼            ▼            ▼            ▼                  │
 Command    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
            │ Define   │ │Subscribe │ │Subscribe │ │Subscribe │ │Subscribe │            │
            │ Course   │ │          │ │          │ │          │ │          │            │
            └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘            │
   course       new        0 of 1       1 of 1      chem: 0/10   not found              │
   student       -         0 courses    0 courses   3 courses        -                  │
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─ ─ ─ ─┼ ─ ─
                 ▼            ▼            ▼            ▼            ▼                  │
 Event log  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐            │
            │ Course-  │▶│ Student- │ │CourseFull│ │StudentAt-│ │CourseNot-│            │
            │ Defined  │ │Subscribed│ │ refused  │ │  Limit   │ │  Found   │            │
            │course=   │ │course=   │ │  (409)   │ │ refused  │ │ refused  │            │
            │ math     │ │math,     │ └──────────┘ │  (409)   │ │  (404)   │            │
            └────┬─────┘ │student=  │              └──────────┘ └──────────┘            │
                 │       │ ann      │        (a refusal writes no event)                │
                 │       └────┬─────┘                                                   │
 ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─┼ ─ ─
                 ▼            ▼                                                         │
 Read model ┌───────────────────────────────────────────────────────────────────────────────┐
            │ course_seats_view:   math 1 left  ──────▶  math 0 left       (updated async) │
            └───────────────────────────────────────────────────────────────────────────────┘
```

Two things the picture shows that an aggregate model cannot:

- **`StudentSubscribed` is tagged with both the course and the student.** The course's model and the student's model read the same event, each from its
  own side, and `Subscribe` decides on both at once.
- **Each refusal comes from a different model.** `CourseFull` comes from the course, `StudentAtLimit` from the student, and both are part of one decision
  with one boundary.

The read model is not part of the quick start, because it needs the poller. [Tutorial step 4](../tutorial/04-read-your-own-writes.md) builds it.
