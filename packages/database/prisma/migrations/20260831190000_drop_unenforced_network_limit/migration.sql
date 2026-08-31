-- `networkLimitMbps` was accepted by the API, stored, and sent to the node
-- agent, which validated it and dropped it. No traffic shaping exists anywhere
-- in the panel, and no form ever offered the field, so every row holds the
-- default. Dropping it removes a limit that only ever looked like one.
--
-- If bandwidth shaping is built later it wants its own column anyway: doing it
-- properly needs a `tc` qdisc per container and NET_ADMIN on the host, which is
-- a node-agent capability rather than a number on a server row.
ALTER TABLE "servers" DROP COLUMN "networkLimitMbps";
