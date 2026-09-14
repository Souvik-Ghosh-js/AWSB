# Putting the shop online

This guide takes you from nothing to a working shop. You do not need to know
anything about servers. Follow it in order, top to bottom, and copy-paste the
commands exactly as written.

Set aside about **an hour**, plus waiting time for DNS.

Anything in `this font` is a command to type or paste. Lines starting with `#`
are explanations — you do not type those.

---

## Before you start, collect these

You will need all four. Get them now so you are not hunting mid-install.

| What | Where to get it |
|---|---|
| A domain name | GoDaddy, Namecheap, BigRock, Cloudflare — wherever you bought it. You need the login. |
| An AWS account | https://lightsail.aws.amazon.com |
| Razorpay account | https://dashboard.razorpay.com — sign up and complete KYC. **KYC takes a few days**, so start it first. |
| A Gmail account | The one that sends order emails to customers. |

---

## Step 1 — Create the server

1. Go to https://lightsail.aws.amazon.com and click **Create instance**.
2. **Region:** pick **Mumbai (ap-south-1)**. Your customers are in India, and
   a closer server means a faster shop.
3. **Blueprint:** choose the **OS Only** tab, then **Ubuntu 22.04 LTS**.
   Do *not* pick any of the "Apps + OS" blueprints (Node.js, LAMP, etc.) —
   they come with pre-installed software that conflicts with this installer.
4. **Size:** choose the **$12/month — 2 GB RAM, 2 vCPUs, 60 GB SSD** plan.

### Why 2 GB and not the cheaper plan

The $5 (512 MB) and $7 (1 GB) plans genuinely will struggle, and it is worth
understanding why before you try to save ₹400 a month.

Two parts of this shop are memory-hungry:

- **Product image processing** (`sharp`). Every photo you upload is resized
  into several sizes. A large camera photo can need 200–300 MB of memory
  while it is being processed.
- **Label scanning** (`tesseract.js`). When you photograph a courier label to
  read the tracking number, the OCR engine loads a language model and can use
  300 MB or more for a few seconds.

On a 512 MB box, either of those can consume all available memory. Linux then
kills whatever is using the most — usually your shop — and customers see an
error page. The installer adds a swap file to soften this, but swap is disk,
and disk is roughly a thousand times slower than memory. The shop will not
crash as often; it will just be painfully slow instead.

**2 GB is the honest minimum.** If you truly must start on 1 GB, the installer
will set up swap automatically and the shop will work — but expect image
uploads and label scans to be slow, and plan to upgrade. Lightsail lets you
resize later by taking a snapshot and launching a bigger instance from it.

5. Name it something you will recognise, e.g. `attar-shop`.
6. Click **Create instance** and wait until it shows **Running**.

### Give it a fixed IP address

By default the server's address changes if it ever restarts, which would break
your website. Fix it permanently:

1. In Lightsail, open the **Networking** tab.
2. Click **Create static IP**.
3. Attach it to your instance.
4. **Write the IP address down.** It looks like `13.234.56.78`. You need it in
   Step 3.

Static IPs are free while attached to a running instance.

---

## Step 2 — Install everything

1. In Lightsail, click your instance, then the orange **Connect using SSH**
   button. A black terminal window opens in your browser. That is your server.

2. Paste these commands one block at a time. Press Enter after each block.

```bash
# Get the shop's code onto the server.
# Replace the URL with your actual repository address.
cd ~
git clone https://github.com/YOUR-USERNAME/YOUR-REPO.git awsb
cd awsb
```

> **No repository yet?** If your code is not on GitHub, upload it another way
> (for example with `scp`), placing it at `/home/ubuntu/awsb`, then continue.

3. Run the installer. Replace the domain and email with your own:

```bash
bash deploy/install.sh --domain yourshop.com --email you@gmail.com
```

**If you also want the website itself running on this same server** (cheaper,
but slower for customers than Vercel), add `--with-web`:

```bash
bash deploy/install.sh --domain yourshop.com --email you@gmail.com --with-web
```

The installer takes **10–25 minutes**. It will:

- ask for your password once, near the start (type it; nothing appears on
  screen as you type — that is normal)
- print green `==>` lines as it works
- finish with a numbered checklist

It is safe to run again if something goes wrong. It will not duplicate
anything or overwrite your passwords.

---

## Step 3 — Point your domain at the server

Log in to wherever you bought your domain and find **DNS settings** (sometimes
"DNS Management", "Nameservers" or "Advanced DNS").

Add these two records, replacing `13.234.56.78` with **your** static IP:

| Type | Name / Host | Value | TTL |
|---|---|---|---|
| A | `@` | `13.234.56.78` | leave default |
| A | `api` | `13.234.56.78` | leave default |

`@` means the bare domain (`yourshop.com`). `api` creates
`api.yourshop.com`, which is where the shop's engine lives.

> **If your website is hosted on Vercel or Amplify** (i.e. you did *not* use
> `--with-web`), then the `@` record should point at **them** instead — they
> will tell you what value to use. Only the `api` record points at your
> Lightsail IP.

### Wait for it to take effect

DNS changes take between 5 minutes and a few hours. Check with:

```bash
dig +short api.yourshop.com
```

When it prints your IP address, you are ready. **Do not continue until it
does.**

---

## Step 4 — Turn on HTTPS (the padlock)

Without this, browsers show "Not secure" next to your shop's name and
customers will not enter card details.

Once `dig` shows your IP, run:

```bash
# If the website is hosted elsewhere (Vercel/Amplify):
sudo certbot --nginx -d api.yourshop.com --agree-tos -m you@gmail.com --redirect

# If you used --with-web (everything on this server):
sudo certbot --nginx -d yourshop.com -d www.yourshop.com -d api.yourshop.com \
  --agree-tos -m you@gmail.com --redirect
```

You should see `Congratulations!`. The certificate renews itself
automatically from now on.

> **If this fails**, it is almost always because DNS has not finished
> propagating. Wait 30 minutes and try again. Do not retry repeatedly —
> Let's Encrypt limits how many times you can ask per week.

---

## Step 5 — Save your passwords

The installer created passwords for you and put them in a file only you can
read.

```bash
cat ~/awsb-credentials.txt
```

**Copy everything it prints into a password manager** (or write it down and
keep it somewhere safe). Then delete the file:

```bash
rm ~/awsb-credentials.txt
```

Deleting it breaks nothing — the shop keeps its own copy in a separate
protected file. This is just removing a second copy lying around.

---

## Step 6 — Add your Razorpay and Gmail details

This is the step that makes payments and emails actually work.

### 6a. Get your Razorpay keys

1. Log in to https://dashboard.razorpay.com
2. Go to **Settings → API Keys → Generate Key**
3. You get a **Key ID** (starts `rzp_live_` or `rzp_test_`) and a **Key
   Secret**.
4. **Copy the Key Secret immediately.** Razorpay shows it exactly once. If you
   lose it you must generate a new pair.

### 6b. Get a Gmail App Password

Your normal Gmail password will **not** work. Google requires a special
16-character "App Password" for programs.

1. Go to https://myaccount.google.com/security
2. Turn on **2-Step Verification** if it is not already on. *You cannot get an
   App Password without this.*
3. Go to https://myaccount.google.com/apppasswords
4. Create one named "Attar Shop". Google shows 16 characters like
   `abcd efgh ijkl mnop`.
5. **Type it without the spaces**: `abcdefghijklmnop`

### 6c. Put them into the settings file

```bash
nano ~/awsb/backend/.env
```

A text editor opens. Use the arrow keys to move — the mouse does not work.
Find each line that says `REPLACE_ME` and type your real value in its place:

```
RAZORPAY_KEY_ID=rzp_live_AbCdEf123456
RAZORPAY_KEY_SECRET=your_key_secret_here
RAZORPAY_WEBHOOK_SECRET=make_up_a_long_random_password_here
SMTP_PASSWORD=abcdefghijklmnop
```

> **`RAZORPAY_WEBHOOK_SECRET` is not given to you by Razorpay.** You invent
> it — any long random text. You will paste the *same* value into Razorpay in
> the next step. It must match exactly.

To save and exit nano: press **Ctrl+O**, then **Enter**, then **Ctrl+X**.

Then restart the shop so it picks up the new settings:

```bash
pm2 restart awsb-api --update-env
```

---

## Step 7 — Tell Razorpay where to send confirmations

**Without this step, customers can pay but their orders will never be
confirmed.** This is the single most commonly missed step.

1. In Razorpay: **Settings → Webhooks → Add New Webhook**
2. Fill in:

   - **Webhook URL:** `https://api.yourshop.com/api/v1/webhooks/razorpay`
   - **Secret:** the exact same random text you put in
     `RAZORPAY_WEBHOOK_SECRET`
   - **Active Events:** tick `order.paid`, `payment.failed`,
     `payment.captured`, `refund.processed`

3. Click **Create Webhook**.

---

## Step 8 — Create your admin login

```bash
cd ~/awsb/api && npm run create-admin
```

Answer the prompts (your name, email, password). Then open
`https://yourshop.com/admin` and log in.

**You are live.** Place a small test order on yourself before telling anyone
about the shop.

---

# Running the shop day to day

## Is it working?

```bash
pm2 status
```

`awsb-api` should say **online**. If it says `errored` or `stopped`, see
Troubleshooting.

## Reading the logs

The logs are what the shop writes down about what it is doing. They are the
first place to look when something is wrong.

```bash
pm2 logs awsb-api              # live, as it happens — Ctrl+C to stop watching
pm2 logs awsb-api --lines 100  # the last 100 lines
pm2 logs awsb-api --err        # errors only
```

## Restarting

```bash
pm2 restart awsb-api           # quick restart, a few seconds of downtime
pm2 reload awsb-api            # no downtime — prefer this one
```

## Installing new code

```bash
cd ~/awsb && ./deploy/update.sh
```

This backs up the database, fetches the new code, updates the shop, and checks
it still works. **If the new version fails, it automatically puts the old one
back.**

## Backups

A backup runs automatically every night at 02:30 server time.

```bash
./deploy/backup.sh             # take one right now
ls -lh ~/awsb-backups/         # see what you have
./deploy/restore.sh --list     # same, with dates
```

Backups are kept for 14 days.

### To also copy backups to Amazon S3

Backups on the same server are lost if the server is lost. To copy them
off-site:

```bash
sudo snap install aws-cli --classic
aws configure                  # paste your AWS access keys when asked
./deploy/backup.sh --s3 s3://your-bucket-name/db-backups
```

### Restoring a backup

**This erases everything that happened since that backup was taken.** It
refuses to run unless you explicitly confirm:

```bash
./deploy/restore.sh --latest --yes-i-am-sure
```

## Where your secrets live

| What | Where |
|---|---|
| All settings and passwords | `~/awsb/backend/.env` |
| Generated passwords (delete after saving) | `~/awsb-credentials.txt` |
| Logs | `~/awsb-logs/` |
| Backups | `~/awsb-backups/` |

`backend/.env` is the important one. It is readable only by you. **Never** email
it, paste it into a chat, or commit it to GitHub. If it leaks, someone can
take payments as you and read your customer data.

---

# Troubleshooting

## Customers pay, but orders stay "pending payment"

This is the Razorpay webhook failing, and it is the most common problem.

**Check the logs first:**

```bash
pm2 logs awsb-api --lines 100 | grep -i webhook
```

**In Razorpay:** Settings → Webhooks → click your webhook. There is a delivery
log showing each attempt and the response.

The causes, in order of likelihood:

1. **The webhook secret does not match.** `RAZORPAY_WEBHOOK_SECRET` in
   `backend/.env` must be character-for-character identical to the Secret field in
   the Razorpay dashboard. Retype both rather than trusting a copy-paste —
   a trailing space is invisible and breaks it.

2. **You used the wrong secret.** The webhook secret is **not** the API Key
   Secret. They are two different values. Using the Key Secret here fails
   every single time, silently. This catches almost everyone once.

3. **The URL is wrong.** It must be exactly
   `https://api.yourshop.com/api/v1/webhooks/razorpay` — `https` not `http`,
   and the `api.` subdomain.

4. **Razorpay cannot reach your server.** Check the delivery log for timeouts.
   Verify the certificate works: `curl -I https://api.yourshop.com`

After changing `backend/.env`, always run `pm2 restart awsb-api --update-env`.
The shop does not notice edits to that file on its own.

> **Technical note, if someone is helping you:** the signature is verified
> against the *exact bytes* Razorpay sent. The nginx configuration has a
> special rule for this one URL that passes the data through untouched. If
> anyone edits `/etc/nginx/sites-available/awsb.conf` and removes the
> `proxy_request_buffering off` line from the webhook block, every webhook
> will start failing.

## Emails are not being sent

```bash
pm2 logs awsb-api --lines 100 | grep -i -E "smtp|mail"
```

**"Invalid login" or "Username and Password not accepted":**

You are using your Gmail password instead of an App Password, or 2-Step
Verification is not turned on. Go back to Step 6b. The App Password is 16
letters with no spaces.

**Emails send but land in spam:**

Expected, unfortunately. Mail sent through Gmail SMTP comes from a
`@gmail.com` address, and some inboxes distrust that for shop receipts. It
improves as customers mark you "not spam". If it becomes a real problem, the
shop can be switched to a proper sending service like Amazon SES or Brevo —
that is a settings change, not a rewrite.

**Nothing sends at all after about 500 emails in a day:**

That is Gmail's daily limit. It resets after 24 hours. Passing it regularly
means it is time to move to SES or Brevo.

## The shop is slow, or keeps restarting by itself

Almost always memory, especially on a 512 MB or 1 GB instance.

```bash
free -h                         # how much memory is left
pm2 status                      # look at the restart count
dmesg | grep -i "killed process"   # did Linux kill the shop?
```

If `dmesg` shows "Out of memory: Killed process ... node", the server ran out
of memory. Causes, in order:

1. **Uploading a very large photo.** Resize photos to roughly 2000 pixels
   before uploading. Phone photos are often far larger than needed.
2. **Scanning a courier label.** The OCR step is the single most
   memory-hungry thing the shop does.
3. **The instance is too small.** This is the real fix.

Confirm swap is active (the installer sets this up on small instances):

```bash
swapon --show
```

If that prints nothing on a small instance, re-run `bash deploy/install.sh`.

**To upgrade the instance:** in Lightsail, take a **snapshot** of your
instance, then **create a new instance from that snapshot** at a larger size,
and move your static IP to the new one. Your data comes with it.

## "MySQL connection refused" / the shop will not start

```bash
sudo systemctl status mysql
```

**If it says `inactive` or `failed`:**

```bash
sudo systemctl start mysql
sudo journalctl -u mysql -n 50     # read why it stopped
```

The usual reason is a full disk. Check with `df -h`. If the disk is full,
clear old logs and backups:

```bash
ls -lh ~/awsb-backups/
pm2 flush                          # clear the shop's logs
```

**If MySQL is running but the shop still cannot connect**, the password in
`backend/.env` may no longer match the database. Test it:

```bash
mysql -h 127.0.0.1 -u awsb -p awsb
# paste the DB_PASSWORD from backend/.env when it asks
```

If that fails, re-running `bash deploy/install.sh` re-syncs them.

> MySQL is deliberately not reachable from the internet, only from the shop
> itself. "Connection refused" from your own computer is correct and expected.

## The website shows "502 Bad Gateway"

nginx is running but the shop behind it is not.

```bash
pm2 status                     # is awsb-api online?
pm2 logs awsb-api --lines 50   # why did it stop?
pm2 restart awsb-api
```

A crash right after startup is nearly always a bad value in `backend/.env`. The
shop checks every setting when it starts and refuses to run with a bad one —
the log message names the offending setting.

## Stock is stuck / products show "out of stock" wrongly

When a customer starts checkout, their items are held for them so two people
cannot buy the last bottle. If they abandon payment, a cleanup job releases
the stock after 30 minutes.

Check that job is running:

```bash
tail -50 ~/awsb-logs/sweep.log
crontab -l                     # should list the sweeper every 10 minutes
```

If `sweep.log` is empty or missing, the job is not running and abandoned
checkouts are eating your stock. Re-run `bash deploy/install.sh` to
reinstall the schedule.

## The certificate expired / "Not secure" warning came back

Renewal is automatic, but if it failed:

```bash
sudo certbot renew --dry-run   # test without changing anything
sudo certbot renew             # actually renew
sudo systemctl reload nginx
```

## I have broken something and want help

Collect this before asking anyone:

```bash
pm2 logs awsb-api --lines 200 > ~/debug.txt
pm2 status >> ~/debug.txt
free -h >> ~/debug.txt
df -h >> ~/debug.txt
sudo systemctl status mysql --no-pager >> ~/debug.txt
sudo nginx -t 2>> ~/debug.txt
```

**Before sending `~/debug.txt` to anyone, open it and check it does not
contain passwords.** Logs occasionally include settings.

---

# What is running on your server

You do not need this to run the shop, but it helps to know.

| Piece | What it does |
|---|---|
| **nginx** | Answers the internet, handles HTTPS, passes requests to the shop. |
| **Node.js + pm2** | Runs the shop's engine, restarts it if it crashes, starts it on reboot. |
| **MySQL** | Stores products, orders, customers. Not reachable from outside. |
| **UFW** | Firewall. Only SSH, 80 and 443 are open. |
| **fail2ban** | Blocks IPs that repeatedly guess your SSH password. |
| **certbot** | Gets and renews the HTTPS certificate. |
| **cron** | Runs the nightly backup and the 10-minute stock cleanup. |

## Files in this folder

| File | Purpose |
|---|---|
| `install.sh` | First-time setup. Safe to re-run. |
| `update.sh` | Deploy new code, with automatic rollback. |
| `backup.sh` | Back up the database. |
| `restore.sh` | Restore a backup. Requires explicit confirmation. |
| `ecosystem.config.cjs` | How pm2 runs the shop. |
| `nginx/awsb.conf.template` | The web server configuration. |
| `cron/` | The scheduled jobs. |
