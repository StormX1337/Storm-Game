# Backups

Backups are per server, taken by the node that runs the server, and stored
either on that node or in S3-compatible object storage. A backup that has never
been restored is a hypothesis — the last section of this document is the one
that matters.

- [How they work](#how-they-work)
- [Storage drivers](#storage-drivers)
- [Configuring storage](#configuring-storage)
- [Taking a backup](#taking-a-backup)
- [Restoring](#restoring)
- [Automatic backups](#automatic-backups)
- [Retention](#retention)
- [Limits and quotas](#limits-and-quotas)
- [Downloads](#downloads)
- [Backing up the panel itself](#backing-up-the-panel-itself)
- [Troubleshooting](#troubleshooting)

---

## How they work

Creating a backup queues a job. The panel asks the agent; the agent streams the
server's directory through tar and gzip, computes a SHA-256 as it goes, and
writes the archive to the configured target. Progress is reported back and
shown in the UI.

The server keeps running. For most games that is fine — the archive is
crash-consistent, which is the same guarantee the game already relies on. For
databases and anything that writes continuously, stop the server first, or add
a schedule that stops it, backs up and starts it again.

Every backup records its size, its checksum, which storage it went to, who
asked for it and why. States: `PENDING` → `IN_PROGRESS` → `COMPLETED`, or
`FAILED` with the reason.

A backup can exclude paths: pass `ignoredFiles` when creating one, or fill in
the exclusions field in the UI. Patterns are gitignore-style, matched against
paths relative to the server's directory.

---

## Storage drivers

### Local

Archives land in the agent's `BACKUP_DIRECTORY` on the node. Fast, free, and gone
when the node's disk dies. Fine for "I am about to try something", useless as
disaster recovery.

The panel keeps no copy. A download is proxied from the agent, and a deletion
is asked of the agent — so a node that is unreachable is a backup that cannot
be pruned yet, and the panel keeps the record until it can. That is on purpose:
forgetting a record while the file is still on a node is how a disk fills with
archives nothing is pointing at any more.

### S3-compatible

Anything speaking the S3 API: AWS S3, Cloudflare R2, Backblaze B2, MinIO,
Wasabi, DigitalOcean Spaces.

The archive never passes through the panel. The panel issues a pre-signed URL
and the agent streams straight to the bucket — no proxying, no panel disk
usage, and the panel's bandwidth is not the bottleneck. Restores work the same
way, with a pre-signed GET.

Credentials are encrypted at rest with `ENCRYPTION_KEY` and are never sent to a
browser.

---

## Configuring storage

**Admin → Backup storage → Add.**

| Field                   | Notes                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Name                    | What operators see                                                                              |
| Driver                  | Local or S3                                                                                     |
| Endpoint                | S3 only — `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com` |
| Region                  | S3 only — `auto` for R2                                                                         |
| Bucket                  | Must already exist                                                                              |
| Access key / Secret key | An account scoped to this bucket alone                                                          |
| Path style              | On for MinIO and most self-hosted S3                                                            |
| Default                 | Used by servers without an explicit choice                                                      |

**Test connection** does a real round trip — put, get, delete — before saving,
so a typo fails here rather than at 3am during a restore.

### Cloudflare R2

```
Endpoint: https://<account-id>.r2.cloudflarestorage.com
Region:   auto
Bucket:   storm-backups
```

R2 has no egress fees, which makes it a good fit for restores.

### MinIO

`docker compose --profile storage up -d` brings one up beside the panel:

```
Endpoint:   http://minio:9000
Region:     us-east-1
Path style: on
```

Set `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` in `.env` first. Note that a
MinIO on the same host as the panel is convenient, not a disaster recovery
plan.

### A least-privilege bucket policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::storm-backups/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::storm-backups"
    }
  ]
}
```

No bucket deletion, no policy changes, nothing outside that bucket.

---

## Taking a backup

**Server → Backups → Create backup.** Give it a name you will recognise later —
"before 1.21 upgrade" beats "backup 4".

Or:

```bash
curl -X POST https://panel.example.com/api/v1/servers/$SERVER/backups \
  -H "Authorization: Bearer $STORM_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"before-upgrade","ignoredFiles":["cache/**"]}'
```

Requires `servers.backups.create`. Returns immediately with a `PENDING` backup;
watch the server socket or poll the backup for its state.

**Lock** a backup to exempt it from retention pruning. Locked backups cannot be
deleted until unlocked — worth doing before any upgrade you are unsure about.

---

## Restoring

**Server → Backups → ⋯ → Restore.** The panel asks for confirmation, because
this is destructive:

1. The server is stopped and waited for.
2. The archive is verified against its checksum.
3. The current contents of the server directory are **deleted**.
4. The archive is extracted, with every entry path re-validated.
5. Ownership is reset to uid 1000.
6. The server is started if it was running before.

A partially-extracted restore leaves the server stopped rather than half-
restored, and the failure says so.

A restore that fails puts the backup back to the state it was in — a record
left saying `RESTORING` could never be restored again, since the route only
accepts a `COMPLETED` one, and one bad attempt would have taken away the only
copy there was.

Requires `servers.backups.restore`.

> Take a fresh backup before restoring an old one. The state you are about to
> discard is sometimes the state you wanted.

---

## Automatic backups

Backups are a schedule task, so anything the scheduler can express works.

**Server → Schedules → New schedule:**

```
Name:  Nightly backup
Cron:  0 4 * * *
Tasks: Backup
```

Stop first, for a database-heavy server:

```
Tasks: Power → stop
       Backup            (offset 60s)
       Power → start     (offset 120s)
```

Offsets are seconds after the previous task starts, which gives the game time
to shut down cleanly.

Operators can set a panel-wide default schedule for new servers at **Admin →
Settings → Backups**.

---

## Retention

Two mechanisms, and they do different jobs.

**Age, per storage target.** Set **Retention days** on a backup storage at
**Admin → Backup storage**. The panel's hourly maintenance job deletes
completed, unlocked backups on that target older than the cutoff — the archive
and its database record together. `0` means keep forever.

**Count, per account.** Each account has a backup limit (`Admin → Users →
<user>`, defaulting to **Admin → Settings → Default backup limit**). Creating a
backup beyond the limit is refused with a message naming the number, rather
than silently deleting an older one — nobody wants a backup system that throws
away history on its own.

A **locked** backup is exempt from age-based pruning entirely, and cannot be
deleted until it is unlocked. Deleting a server deletes its backups with it.

Pruning removes the archive first and the record second. If the archive cannot
be removed — a node that is down, a bucket that refuses — the record stays and
the next hourly run tries again. Deleting a backup **by hand** is the other way
round: somebody is waiting on the button, so an unreachable node is logged and
the record goes anyway.

---

## Limits and quotas

| Setting                | Where                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| Backups per account    | `Admin → Users → <user>`, defaulting from `Admin → Settings`                |
| Retention days         | Per backup storage, at `Admin → Backup storage`                             |
| Concurrent backup jobs | The panel's backup worker — three at a time, scaled by `WORKER_CONCURRENCY` |

Concurrency is capped because gzip is CPU-hungry, and a fleet backing up all at
once is a fleet whose game servers stutter. Stagger your schedules.

---

## Downloads

**Server → Backups → ⋯ → Download** yields a short-lived signed URL. For S3 it
is a pre-signed GET straight from the bucket; for local storage it is a signed
URL the agent honours. Either way the link expires, so it can be handed to a
customer without handing over an account.

```bash
URL=$(curl -s -H "Authorization: Bearer $STORM_KEY" \
  https://panel.example.com/api/v1/servers/$SERVER/backups/$BACKUP/download | jq -r .data.url)
curl -o backup.tar.gz "$URL"
```

Archives are plain `tar.gz`:

```bash
tar -tzf backup.tar.gz | head
tar -xzf backup.tar.gz -C ./restored
```

---

## Backing up the panel itself

Server backups do not include the panel's database, and the database is what
knows which server is whose.

```bash
# Database
docker compose exec -T postgres pg_dump -U storm storm | gzip > storm-$(date +%F).sql.gz

# Configuration — contains ENCRYPTION_KEY. Without it, every stored secret is
# unreadable, even with the database.
cp .env storm-env-$(date +%F).bak
```

Restore:

```bash
gunzip -c storm-2026-08-30.sql.gz | docker compose exec -T postgres psql -U storm storm
```

Keep `.env` and the dumps in different places, and treat the `.env` copy as the
secret it is.

---

## Troubleshooting

**Backup stuck `PENDING`.** The job is queued but nothing is consuming it —
check the API's worker logs and that Redis is reachable.

**"No space left on device".** The node's disk. `du -sh
/var/lib/storm/backups/*`, prune, or move that server to S3 storage.

**"Access denied" to S3.** The key lacks `PutObject` on that bucket, or the
endpoint and region disagree. **Test connection** on the storage target will
tell you which.

**Checksum mismatch on restore.** The archive is corrupt — a truncated upload,
usually. Do not extract it. Use an older backup, and check the node's disk
health.

**Restore finished but the server will not start.** The archive was taken from
a different template version, or file ownership is wrong. Check the console
output; reinstall preserves the data directory.

**Backups are slow.** Gzip is CPU-bound. A large server on a busy node takes
time. Exclude what you do not need with `ignoredFiles` — world backups rarely
need cached region files.

---

## Test your restores

Once a quarter, pick a real server, restore a backup into a scratch server, and
start it. Every backup system works until the first time you need it.
