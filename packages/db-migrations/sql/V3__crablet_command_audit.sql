-- The command audit (ADR-0047: one file per part of the schema, in its final shape).
--
-- crablet_commands stores one row per executed command, when auditing is on. It is linked to crablet_events through transaction_id: both share the
-- pg_current_xact_id() of the transaction in which the command was recorded and its events appended. There is no foreign key: the join is by xid8 only.

CREATE TABLE crablet_commands
(
    command_id     UUID                     NOT NULL PRIMARY KEY,
    transaction_id xid8                     NOT NULL,
    type           TEXT                     NOT NULL,
    data           JSONB                    NOT NULL,
    metadata       JSONB,
    occurred_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_crablet_command_type_length CHECK (LENGTH(type) BETWEEN 1 AND 64)
);

CREATE UNIQUE INDEX idx_crablet_commands_transaction_id ON crablet_commands (transaction_id);

COMMENT ON TABLE crablet_commands IS
    'Command audit log. One row per executed command, linked to crablet_events via transaction_id.';

COMMENT ON COLUMN crablet_commands.transaction_id IS
    'PostgreSQL xid8 for the command execution transaction; joins to crablet_events.transaction_id for events produced by the command. Not a business transaction ID.';
