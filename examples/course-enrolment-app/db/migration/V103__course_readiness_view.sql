-- Read model: what each course still needs before it can start (a teacher, a room, enough students), and whether it was confirmed.
-- Maintained by CourseReadinessViewProjector, the example of the "aggregate events" guide (docs/guides/build/aggregate-events.md): each event fills in its own column.
CREATE TABLE course_readiness_view
(
    course_id  TEXT    NOT NULL PRIMARY KEY,
    teacher_id TEXT,
    room       TEXT,
    students   INTEGER NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT 'waiting'
);
