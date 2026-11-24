# Privacy Policy for YtSync

**Last updated:** November 24, 2026

YtSync is a browser extension that synchronizes YouTube video playback across participants in a shared room. This privacy policy explains what data the extension accesses, transmits, and stores.

## 1. Data Processed

When you actively create or join a YtSync room, the extension transmits only the minimum data needed for real-time playback synchronization to the configured sync server (by default `https://ytsync.ataraxia.ws`, or a custom self-hosted server you choose):

- **YouTube playback state (Website content):** The active YouTube video ID, play/pause status, playback timestamp, and playback speed of the bound YouTube tab.
- **Display name:** The arbitrary nickname you enter to identify yourself to other members in the same room.
- **Session ticket:** A temporary, randomly generated identifier issued by the sync server for the duration of your session.

YtSync does **not** collect your real name, email address, Google/YouTube account credentials, browsing history, chat messages, financial information, health information, or location data.

## 2. How Data Is Used

Data transmitted to the sync server is used **solely** to:

- Create and join synchronization rooms.
- Relay playback state (play, pause, seek, playback rate, and video changes) between participants in the same room.
- Display the list of current room members by their chosen display names.

## 3. Data Storage and Retention

- **Sync server:** Room state, playback snapshots, display names, and session tickets are held **in memory only** for real-time synchronization and are not written to a permanent database. Data is discarded when rooms close or sessions expire.
- **Local browser storage:** Your configured server URL and display name are saved locally in `chrome.storage.local` (`browser.storage.local`). Active room session state is stored in `chrome.storage.session` (or local storage where session storage is unavailable) so the connection persists across background service worker restarts and is cleared when you leave the room or close the browser.

## 4. Data Sharing and Third Parties

- We do **not** sell, rent, or transfer user data to third parties.
- We do **not** use user data for advertising, analytics, tracking, or profiling.
- Playback state and display names are shared only with the other participants currently connected to the same room code.
- If you configure a custom or self-hosted server URL in the extension settings, your room sync traffic is sent only to that server.

## 5. Self-Hosting and Open Source

YtSync is open source. You can inspect the full extension and backend source code at [github.com/MyleAtaraxia/YtSync](https://github.com/MyleAtaraxia/YtSync).

## 6. Contact

If you have questions about this privacy policy, please open an issue at [github.com/MyleAtaraxia/YtSync/issues](https://github.com/MyleAtaraxia/YtSync/issues).
