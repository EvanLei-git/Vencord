/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType } from "@utils/types";
import { Guild } from "@vencord/discord-types";
import { Button, ContextMenuApi, Forms, GuildStore, Menu, React, SelectedGuildStore } from "@webpack/common";

const DATA_KEY = "ServerLock_lockedGuilds";
const STYLE_ID = "vc-serverlock-style";
const OVERLAY_ID = "vc-serverlock-overlay";
const OVERLAY_STYLE_ID = "vc-serverlock-overlay-style";
// Discord tags each server in the left sidebar with this DOM attribute:
//   data-list-item-id="guildsnav___<guildId>"
// We rely on it both for the grey-out CSS and the click/hover blocking.
const ITEM_PREFIX = "guildsnav___";

// Source of truth, kept in memory and mirrored to DataStore.
let lockedGuilds = new Set<string>();

function isGuildLocked(guildId?: string | null): boolean {
    return !!guildId && lockedGuilds.has(guildId);
}

function persist() {
    return DataStore.set(DATA_KEY, lockedGuilds);
}

function setLocked(guildId: string, locked: boolean) {
    if (locked) lockedGuilds.add(guildId);
    else lockedGuilds.delete(guildId);
    persist();
    updateLockStyle();
    updateOverlay();
    applyActiveNowFilter();
}

// ----- Active Now panel filtering --------------------------------------------
// Each voice card in the "Active Now" panel embeds the server's icon, and the
// icon URL contains the guild id (…/icons/<guildId>/…). We read that straight
// from the rendered DOM and hide cards belonging to a locked guild — no webpack
// patch, so it can't break when Discord reshuffles its internal modules.
const ACTIVE_NOW_CARD = '[class*="itemCard"]';
const VOICE_SECTION = '[class*="voiceSectionAssets"],[class*="voiceSectionDetails"]';

function cardGuildId(card: HTMLElement): string | null {
    const img = card.querySelector("img[src*=\"/icons/\"]");
    const m = img && /\/icons\/(\d+)\//.exec(img.getAttribute("src") || "");
    if (m) return m[1];

    // Icon-less server: fall back to matching the displayed server name.
    const nameEl = card.querySelector('[class*="voiceSectionText"],[class*="voiceSectionDetails"]');
    const name = nameEl?.textContent?.trim();
    if (name) {
        for (const id of lockedGuilds)
            if (GuildStore.getGuild(id)?.name === name) return id;
    }
    return null;
}

function applyActiveNowFilter() {
    const filter = settings.store.filterActiveNow;
    const cards = new Set<HTMLElement>();
    document.querySelectorAll<HTMLElement>(VOICE_SECTION).forEach(el => {
        const card = el.closest<HTMLElement>(ACTIVE_NOW_CARD);
        if (card) cards.add(card);
    });
    cards.forEach(card => {
        const id = cardGuildId(card);
        card.style.display = filter && !!id && lockedGuilds.has(id) ? "none" : "";
    });
}

let activeNowObserver: MutationObserver | null = null;
let scanTimer: number | null = null;
function scheduleActiveNowScan() {
    if (scanTimer != null) return;
    scanTimer = window.setTimeout(() => {
        scanTimer = null;
        applyActiveNowFilter();
    }, 120);
}

// "LOCKED" screen shown over the channel list + chat (the middle/right) when a
// locked server's content is open — e.g. you followed an invite link into it.
// It deliberately stops at the left server rail so you can click another server
// to leave. Plain DOM + a Flux change listener; no webpack patch needed.
const OVERLAY_CSS =
    `#${OVERLAY_ID}{position:fixed;right:0;bottom:0;z-index:100;display:flex;` +
    "align-items:center;justify-content:center;" +
    "background:var(--background-base-lower,var(--background-primary,#2b2d31));}" +
    `#${OVERLAY_ID}::after{content:"LOCKED";color:var(--text-muted,#949ba4);` +
    "font-size:52px;font-weight:800;letter-spacing:8px;opacity:.5;}";

function ensureOverlayStyle() {
    if (document.getElementById(OVERLAY_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = OVERLAY_STYLE_ID;
    style.textContent = OVERLAY_CSS;
    document.head.appendChild(style);
}

// Anchor the overlay to the right edge / top of the left server rail so it
// covers everything to the right of it (channels + chat) but not the rail
// itself, and never the window title bar above the rail.
function positionOverlay(el: HTMLElement) {
    const scroller = document.querySelector('[data-list-id="guildsnav"]');
    const rail = scroller?.closest("nav") ?? scroller?.parentElement ?? scroller;
    const rect = rail?.getBoundingClientRect();
    el.style.left = `${rect ? Math.ceil(rect.right) : 72}px`;
    el.style.top = `${rect ? Math.max(0, Math.floor(rect.top)) : 0}px`;
}

function updateOverlay() {
    const locked = isGuildLocked(SelectedGuildStore?.getGuildId?.());
    let el = document.getElementById(OVERLAY_ID);

    if (!locked) {
        el?.remove();
        return;
    }

    if (!el) {
        el = document.createElement("div");
        el.id = OVERLAY_ID;
        document.body.appendChild(el);
    }
    positionOverlay(el);
}

// Inject a single <style> element that greys out every locked server icon.
// Regenerated whenever the locked set changes; survives Discord re-renders
// because it targets a stable DOM attribute rather than a React component.
function updateLockStyle() {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

    if (lockedGuilds.size === 0) {
        el?.remove();
        return;
    }

    if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        document.head.appendChild(el);
    }

    const ids = [...lockedGuilds];
    const greySelector = ids
        .map(id => `[data-list-item-id="${ITEM_PREFIX}${id}"]`)
        .join(",");
    // The item AND every descendant — a child blob with its own pointer-events
    // would otherwise stay hit-testable and re-trigger the hover tooltip/click.
    const inertSelector = ids
        .flatMap(id => {
            const s = `[data-list-item-id="${ITEM_PREFIX}${id}"]`;
            return [s, `${s} *`];
        })
        .join(",");

    el.textContent =
        `${greySelector}{filter:grayscale(1) brightness(.65);opacity:.5;cursor:default!important;}` +
        `${inertSelector}{pointer-events:none!important;}`;
}

// Find the sidebar server item whose box contains a viewport point. We test
// geometry rather than the event target because a locked icon is
// pointer-events:none, so the right-click actually lands on whatever is behind it.
function guildItemAtPoint(x: number, y: number): HTMLElement | null {
    const items = Array.from(document.querySelectorAll<HTMLElement>(`[data-list-item-id^="${ITEM_PREFIX}"]`));
    for (const item of items) {
        const r = item.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return item;
    }
    return null;
}

// Because a locked icon is pointer-events:none, Discord's own context menu (with
// the "LOCKED" toggle) can't open on it — so give a minimal "Unlock" menu here.
// Right-clicks on non-locked servers fall through to Discord's normal menu.
function onServerContextMenu(e: MouseEvent) {
    const item = guildItemAtPoint(e.clientX, e.clientY);
    if (!item) return;

    const guildId = item.getAttribute("data-list-item-id")!.slice(ITEM_PREFIX.length);
    if (!lockedGuilds.has(guildId)) return;

    e.preventDefault();
    e.stopPropagation();

    // openContextMenu expects a React-style event; hand it a shim carrying the
    // cursor position and the icon as the anchor element.
    const evt = {
        currentTarget: item,
        target: item,
        clientX: e.clientX,
        clientY: e.clientY,
        pageX: e.pageX,
        pageY: e.pageY,
        nativeEvent: e,
        preventDefault() { },
        stopPropagation() { }
    } as any;

    ContextMenuApi.openContextMenu(evt, () => (
        <Menu.Menu
            navId="vc-serverlock-unlock"
            onClose={ContextMenuApi.closeContextMenu}
            aria-label="Server Lock"
        >
            <Menu.MenuItem
                id="vc-serverlock-unlock-item"
                label="Unlock"
                action={() => setLocked(guildId, false)}
            />
        </Menu.Menu>
    ));
}

const settings = definePluginSettings({
    filterActiveNow: {
        type: OptionType.BOOLEAN,
        description: "Hide voice activity from locked servers in the \"Active Now\" panel on the home page",
        default: true,
        onChange: () => applyActiveNowFilter()
    },
    lockedList: {
        type: OptionType.COMPONENT,
        description: "Locked servers",
        component: () => <LockedServersList />
    }
});

function LockedServersList() {
    const forceUpdate = useForceUpdater();
    const ids = [...lockedGuilds];

    if (ids.length === 0)
        return <Forms.FormText>No servers are locked. Right-click a server in the sidebar and choose "LOCKED".</Forms.FormText>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {ids.map(id => {
                const guild = GuildStore.getGuild(id);
                return (
                    <div
                        key={id}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                    >
                        <Forms.FormText>{guild?.name ?? `Unknown server (${id})`}</Forms.FormText>
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.PRIMARY}
                            onClick={() => {
                                setLocked(id, false);
                                forceUpdate();
                            }}
                        >
                            Unlock
                        </Button>
                    </div>
                );
            })}
        </div>
    );
}

const guildContextPatch: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild) return;

    const locked = isGuildLocked(guild.id);
    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuCheckboxItem
            id="vc-serverlock-toggle"
            label="LOCKED"
            checked={locked}
            action={() => setLocked(guild.id, !locked)}
        />
    );
};

export default definePlugin({
    name: "ServerLock",
    description: "Right-click a server and choose \"LOCKED\" to grey it out, make it un-clickable, suppress its hover tooltip, hide its voice activity from the \"Active Now\" panel, and show a gray LOCKED screen if its content is opened (e.g. via an invite link). Right-click again to unlock.",
    authors: [{ name: "Evan", id: 0n }],
    tags: ["Servers", "Privacy", "Utility"],
    settings,

    contextMenus: {
        "guild-context": guildContextPatch,
        "guild-header-popout": guildContextPatch
    },

    async start() {
        const stored = await DataStore.get(DATA_KEY);
        // Tolerate an older array-shaped value as well as a Set.
        lockedGuilds = stored instanceof Set ? stored : new Set(Array.isArray(stored) ? stored : []);

        updateLockStyle();
        ensureOverlayStyle();
        document.addEventListener("contextmenu", onServerContextMenu, true);

        // Show/hide the LOCKED screen as the selected server changes.
        SelectedGuildStore.addChangeListener(updateOverlay);
        window.addEventListener("resize", updateOverlay);
        updateOverlay();

        // Filter the Active Now panel by watching the DOM for new voice cards.
        activeNowObserver = new MutationObserver(scheduleActiveNowScan);
        activeNowObserver.observe(document.body, { childList: true, subtree: true });
        applyActiveNowFilter();
    },

    stop() {
        document.removeEventListener("contextmenu", onServerContextMenu, true);
        SelectedGuildStore.removeChangeListener(updateOverlay);
        window.removeEventListener("resize", updateOverlay);

        activeNowObserver?.disconnect();
        activeNowObserver = null;
        if (scanTimer != null) {
            clearTimeout(scanTimer);
            scanTimer = null;
        }
        // Un-hide any Active Now cards we had hidden.
        document.querySelectorAll<HTMLElement>(VOICE_SECTION).forEach(el => {
            const card = el.closest<HTMLElement>(ACTIVE_NOW_CARD);
            if (card) card.style.display = "";
        });

        document.getElementById(STYLE_ID)?.remove();
        document.getElementById(OVERLAY_ID)?.remove();
        document.getElementById(OVERLAY_STYLE_ID)?.remove();
    }
});
