# ServerLock

Personal-use Vencord plugin to "lock" servers in the sidebar.

## What it does

Right-click any server in the left sidebar and choose **LOCKED**. While a server is locked:

- Its icon is **greyed out** (greyscale + dimmed).
- It is **not clickable** — left-clicking it does nothing, so you can't accidentally open it.
- **No tooltip** appears when you hover it.
- Its **voice activity is hidden** from the **Active Now** panel on the home/friends page (e.g. a friend sitting in that server's voice channel won't show up).
- If its **content is opened anyway** (e.g. you follow an **invite link** into it), a gray **LOCKED** screen covers the channel list + chat. The left server rail stays clickable so you can navigate away to another server.

**Unlocking is intentionally hard** (this is a self-control tool). A locked server is fully inert — right-clicking it does nothing. The only way to unlock is the plugin's **settings page**, and even there it doesn't happen instantly: pressing **Unlock** starts a countdown, and the server stays locked until you've **restarted (or reloaded) Discord 3 more times**. Each launch ticks the counter down; on the 3rd it actually unlocks. You can press **Cancel** before then to keep it locked. Locking, by contrast, stays easy (right-click → LOCKED).

## How it works (and what can break)

- **Grey-out / not-clickable / no-tooltip** rely on the stable DOM attribute Discord puts on each sidebar server: `data-list-item-id="guildsnav___<guildId>"`.
  - The grey-out is a generated `<style>` element targeting that attribute.
  - Clicks and hover are blocked by a capture-phase event listener on `document` (it never blocks right-click, which is why the unlock menu keeps working).
  - If a Discord update changes that attribute, update `ITEM_PREFIX` in `index.tsx`. Worst case the lock simply stops applying — you're never locked *out*, because right-click always works.

- **Active Now filtering** reads the rendered DOM (no webpack patch). Each voice card embeds the server's icon, whose URL contains the guild id (`…/icons/<guildId>/…`); a `MutationObserver` hides any card belonging to a locked guild (icon-less servers fall back to matching the server name). Turn it off with the `filterActiveNow` setting. If a Discord update renames the card/section classes, update `ACTIVE_NOW_CARD` / `VOICE_SECTION` in `index.tsx`.

## Settings

- **filterActiveNow** — toggle the Active Now hiding (on by default).
- **Locked servers** — list of currently locked servers with an Unlock button each.

Locked servers are stored in Vencord's `DataStore` under `ServerLock_lockedGuilds`, so they persist across restarts.
