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

## Docker notes

The OSC container inherits the host clock — no NTP configuration is needed inside Docker. Fix the Pi host clock and all containers get it automatically.
