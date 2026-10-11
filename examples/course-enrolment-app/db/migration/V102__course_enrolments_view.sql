-- Read model: who took which seat, in the order they subscribed. `seat_number` is 1 for the first student of a course, 2 for the second, and so on.
-- Maintained by CourseEnrolmentsViewProjector, the example of a hand-written projector (docs/guides/build/add-a-view.md): the number is computed from the view's own rows.
CREATE TABLE course_enrolments_view
(
    course_id   TEXT    NOT NULL,
    student_id  TEXT    NOT NULL,
    seat_number INTEGER NOT NULL,
    PRIMARY KEY (course_id, student_id)
);
