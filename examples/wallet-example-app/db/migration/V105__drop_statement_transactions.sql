-- The statement view no longer keeps a junction table of the events it has folded in. A view's batch and its cursor commit in one transaction (ADR-0023), so a batch handled twice is applied once,
-- and the totals are plain additions (the view is declared with defineView, ADR-0026).
DROP TABLE statement_transactions;
