# Scheduled jobs

`deploy/install.sh` installs these into your user's crontab automatically. You
should not normally need to touch anything here.

`awsb-crontab` is a reference copy of exactly what gets installed.

## What runs, and why it matters

| Job | Frequency | If it stops running |
|---|---|---|
| Stale reservation sweeper | every 10 min | Abandoned checkouts keep holding stock. Products show "out of stock" while the bottles are still on your shelf. |
| Database backup | nightly, 02:30 | You have no recent backup. Discovered only when you need one. |
| TLS renewal | daily, 03:15 | The HTTPS certificate expires after 90 days and browsers show a full-page security warning to every customer. |

## Checking they are working

```bash
# What is scheduled right now
crontab -l

# Did the sweeper run? (should show entries every 10 minutes)
tail -50 ~/awsb-logs/sweep.log

# Did last night's backup work?
tail -50 ~/awsb-logs/backup.log
ls -lh ~/awsb-backups/
```

If a log file does not exist at all, the job has never run. If it exists but
is full of errors, read the error — the most common one is a missing
`backend/.env` value, because every script validates the whole environment at
startup.

## Timezone

A fresh Lightsail instance runs on **UTC, not IST**. The times above are
server time, so 02:30 UTC is 08:00 in India.

To switch the whole box to India time:

```bash
sudo timedatectl set-timezone Asia/Kolkata
timedatectl          # confirm
```

Do this *before* you start relying on the backup schedule, so you know when
backups actually happen. Changing it later is safe; cron picks it up.

## Editing

Edit `deploy/cron/awsb-crontab` and re-run `deploy/install.sh`, which replaces
the block between the `# BEGIN AWSB` and `# END AWSB` markers and leaves any
other crontab entries you have alone.

Editing `crontab -e` by hand also works, but your change is overwritten the
next time the installer runs.
