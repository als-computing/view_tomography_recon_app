# Live Notifications

On servers that support it — currently [**Remote** and **Production**](tiled-servers.md), not
**Local** — the app shows a toast pop-up (bottom-right corner) whenever a new reconstruction becomes
available, for every folder you have access to:

> **New reconstruction ready: `<name>`**

with a **View** button (opens it directly as a new tab) and a small **×** dismiss button.

The app also requests permission to show a native OS-level desktop notification with the same title and
click-to-view behavior, so you can be notified even when the browser tab isn't focused. Your browser
will prompt you to allow this the first time.

## How it stays current

The app opens one live connection per folder you can access, and re-checks which folders you have
access to roughly once a minute — so newly granted permissions, or logging in partway through your
session, are picked up automatically without needing to reload the page.
