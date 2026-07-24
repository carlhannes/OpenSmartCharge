# Running OSC on a Raspberry Pi

OSC runs well on a Raspberry Pi 4 or 5 with at least 1 GB RAM. This page covers the one setup detail that catches people out: **clock accuracy**.

## Why clock accuracy matters

OSC buckets electricity prices into 15-minute UTC windows and runs the balancer control loop every 15 seconds. If the system clock drifts by more than ~30 seconds, the following breaks silently:

- Tariff slots land in the wrong bucket — the planner may charge at the wrong hour.
- The balancer's "should charge now?" decision uses the wrong slot.
- SSE event timestamps in the UI are wrong.

## Verify your clock is synchronized

```bash
timedatectl status
```

Look for:

```
System clock synchronized: yes
NTP service: active
```

If either is `no`, follow the steps below.

## Raspberry Pi OS / Debian 12 (default setup)

`systemd-timesyncd` is included and enabled by default. Confirm it is running:

```bash
systemctl status systemd-timesyncd
```

If it shows `inactive` or `failed`:

```bash
sudo systemctl enable --now systemd-timesyncd
```

The default NTP pool (`time.cloudflare.com` or `ntp.ubuntu.com` depending on image) gives ±50–200 ms accuracy — adequate for OSC.

## For tighter accuracy (\<50 ms)

Install `chrony`, which is more accurate and handles intermittent connectivity better than `timesyncd`:

```bash
sudo apt install chrony
sudo systemctl disable systemd-timesyncd  # only one time daemon at a time
sudo systemctl enable --now chronyd
```

Chrony will use the default `pool.ntp.org` pool. To verify sync after 1–2 minutes:

```bash
chronyc tracking
```

`System time` should show < 50 ms offset.

## Running without internet access

If your Pi is air-gapped (no internet), configure a local NTP server on your router (most home routers expose one on the LAN). Edit `/etc/systemd/timesyncd.conf`:

```ini
[Time]
NTP=192.168.1.1   # your router's IP
```

Then restart: `sudo systemctl restart systemd-timesyncd`.

## Running OSC as a systemd service

The Pi is a good fit for a LAN deployment. Build once, then run the **compiled** entry point as a single
process — `node` receives `SIGTERM` directly, so the graceful shutdown handler runs on every
`systemctl stop`/`restart`: it stops the control loop, closes the OCPP/HTTP/MQTT connections, and
**checkpoints the SQLite WAL** before exiting, with a watchdog that forces exit within ~8 s if any teardown
step stalls (so a restart never hangs).

```bash
cd ~/OpenSmartCharge
npm ci
npm run build            # produces dist/ (tsc + vite build)
```

`/etc/systemd/system/osc.service`:

```ini
[Unit]
Description=OpenSmartCharge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/OpenSmartCharge
ExecStart=/usr/bin/node dist/core/lifecycle.js
Restart=on-failure
# Give the graceful handler room to drain + checkpoint the WAL. Its own watchdog exits at ~8 s;
# keep this comfortably above that so systemd never SIGKILLs mid-checkpoint.
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now osc
journalctl -u osc -f          # watch logs; on stop you should see "shutdown complete"
```

> Run the **compiled** `dist/` build in production, not `tsx src/…`: `tsx` spawns a child process that the
> signal may not reach, so `systemctl stop` would hang until the kill timeout. `WorkingDirectory` must be
> the repo root so the `data/osc.db` path resolves.

## Docker notes

The OSC container inherits the host clock — no NTP configuration is needed inside Docker. Fix the Pi host clock and all containers get it automatically.

The shipped image already runs the compiled single process (`node dist/core/lifecycle.js`, PID 1), so
`docker stop` delivers `SIGTERM` straight to the handler. Keep the stop grace above the ~8 s watchdog
(Docker's default is 10 s; raise with `stop_grace_period` if you tune the watchdog up).
