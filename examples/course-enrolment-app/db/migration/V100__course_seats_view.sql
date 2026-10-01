-- Read model: seats left per course, maintained by CourseSeatsViewProjector.
-- `last_position` is the log position of the last event applied to the row: an event delivered twice (the poller
-- is at-least-once) is recognised by its position and skipped, so the counter is never double-counted.
CREATE TABLE course_seats_view
(
    course_id     TEXT    NOT NULL PRIMARY KEY,
    capacity      INTEGER NOT NULL,
    subscribers   INTEGER NOT NULL DEFAULT 0,
    last_position BIGINT  NOT NULL
);
