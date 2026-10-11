-- The seats view no longer remembers the position of the last event it applied. A view's batch and its cursor commit in one transaction (ADR-0023), so a batch delivered twice is applied once by the
-- processor, and the projector only adds (the view is declared with defineView, ADR-0026).
ALTER TABLE course_seats_view DROP COLUMN last_position;
