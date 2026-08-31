-- A server being moved to another node is neither running nor simply off: its
-- files are being copied and its container does not exist on either side for
-- part of that. Without a status of its own the panel would show it as OFFLINE
-- and offer a Start button that cannot work.
ALTER TYPE "ServerStatus" ADD VALUE 'TRANSFERRING';
